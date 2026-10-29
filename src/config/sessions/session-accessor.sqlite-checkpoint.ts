import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseExecutionFileIdentity } from "../../state/openclaw-agent-execution-contract.js";
import { invalidateSessionBranchCache } from "./session-accessor.sqlite-branches.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  assertPreparedSessionDeletionNotMixed,
  captureNativeSessionWorkerDeletion,
  hasPreparedNativeSessionDeletion,
  runSqliteSessionDeletionTransaction,
  commitSqliteSessionDeletion,
  withSqliteSessionContextReset,
} from "./session-accessor.sqlite-deletion.js";
import type { SessionAdmissionTransition } from "./session-accessor.sqlite-entry-admission.js";
import {
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  publishCommittedSessionIdentity,
  prepareSessionIdentityPublication,
} from "./session-accessor.sqlite-identity.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { resolveCheckpointBoundaryPath } from "./session-checkpoint-boundary.js";
import { readOwnedLegacyCheckpoint } from "./session-checkpoint-legacy-file.js";
import {
  hasExistingNativeIncognitoCheckpointOwner,
  captureNativeIncognitoCompactionCheckpoint,
  persistNativeIncognitoCompactionCheckpoint,
  applyNativeIncognitoCheckpointOperation,
} from "./session-checkpoint-native-incognito.js";
import { captureCheckpointSnapshotWitness } from "./session-checkpoint-snapshot-witness.js";
import {
  captureOwnedCheckpointSnapshotWitnesses,
  isCheckpointSnapshotWitnessCurrent,
  type CheckpointSnapshotWitness,
} from "./session-checkpoint-snapshot-witness.js";
import type {
  CheckpointPreparation,
  CheckpointCandidate,
  CheckpointWorkerMutation,
} from "./session-compaction-checkpoint.worker.js";
import { findSessionTranscriptHeader } from "./session-entry-codec.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { inheritSessionSelection } from "./session-entry-selection.js";
import { executeSessionForkOperation } from "./session-fork-domain.js";
import {
  captureIncognitoSessionSource,
  publishIncognitoSessionEntry,
  withAcquiredIncognitoSessionBinding,
} from "./session-incognito-binding.js";
import { runSessionNativeBindingWorkerOperation } from "./session-native-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey as normalizeSqliteSessionKey,
} from "./store-entry.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { scanSessionTranscriptTree } from "./transcript-tree.js";
import { assertNoOwnedSessionTranscriptWriteContextForNativeCompatibility } from "./transcript-write-context.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry as SessionEntry,
  type SessionCompactionCheckpoint,
} from "./types.js";
import { MIN_READABLE_SESSION_VERSION } from "./version.js";

// Compaction checkpoint branch/restore owner.

type SqliteCheckpointTranscriptForkSource = {
  sessionId: string;
  leafId?: string;
  totalTokens?: number;
};

export type SqliteCompactionCheckpointLegacySource = {
  checkpointId: string;
  events: TranscriptEvent[];
  sessionFile: string;
  witness?: CheckpointSnapshotWitness;
  sourceLeafId?: string;
  totalTokens?: number;
};

export type SessionEntryExpectedState = Pick<SessionEntry, "lifecycleRevision" | "sessionId"> &
  Partial<Pick<SessionEntry, "activeWriterRunId">>;

export function checkpointStateMatches(
  entry: SessionEntry,
  expected: SessionEntryExpectedState,
): boolean {
  return (
    entry.sessionId === expected.sessionId &&
    entry.lifecycleRevision === expected.lifecycleRevision &&
    (!Object.hasOwn(expected, "activeWriterRunId") ||
      entry.activeWriterRunId === expected.activeWriterRunId)
  );
}

/** Result from SQLite compaction checkpoint branch or restore operations. */
export type SqliteCompactionCheckpointSessionMutationResult =
  | {
      status: "created";
      key: string;
      checkpoint: SessionCompactionCheckpoint;
      entry: SessionEntry;
    }
  | { status: "missing-session" }
  | { status: "missing-checkpoint" }
  | { status: "missing-boundary" }
  | { status: "model-selection-locked" }
  | { status: "conflict" }
  | { status: "failed" };

/** Parameters for branching a SQLite session from a compaction checkpoint. */
export type SqliteBranchCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  commitGuard?: () => void;
  sourceKey: string;
  sourceStoreKey?: string;
  nextKey: string;
  checkpointId: string;
  expectedState: SessionEntryExpectedState;
  legacySource?: SqliteCompactionCheckpointLegacySource;
  creation?: Parameters<typeof buildSessionCreationStamp>[0];
};

/** Parameters for restoring a SQLite session from a compaction checkpoint. */
export type SqliteRestoreCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  commitGuard?: () => void;
  sessionKey: string;
  sessionStoreKey?: string;
  checkpointId: string;
  expectedState: SessionEntryExpectedState;
  legacySource?: SqliteCompactionCheckpointLegacySource;
};

export type SqliteCompactionCheckpointSessionOperation =
  | ({ kind: "branch" } & SqliteBranchCheckpointSessionParams)
  | ({ kind: "restore" } & SqliteRestoreCheckpointSessionParams);

export async function branchCompactionCheckpointSession(
  params: SqliteBranchCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  return applySqliteCompactionCheckpointSessionOperation({ ...params, kind: "branch" });
}

export async function restoreCompactionCheckpointSession(
  params: SqliteRestoreCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  return applySqliteCompactionCheckpointSessionOperation({ ...params, kind: "restore" });
}

function checkpointScope(
  params: { agentId?: string; env?: NodeJS.ProcessEnv; storePath?: string },
  sessionKey: string,
) {
  const resolved = resolveSqliteScope({ ...params, sessionKey });
  return {
    ...resolved,
    storePath: params.storePath ?? resolved.ownerStorePath,
    env: Object.freeze({ ...(resolved.env ?? process.env) }),
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
  };
}

async function prepareCheckpointInWorker(
  scope: ReturnType<typeof checkpointScope>,
  input: { sourceKey: string; sessionId?: string; expectedState?: SessionEntryExpectedState },
  assertCurrent: () => void,
): Promise<CheckpointPreparation> {
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  return withSessionEntryWorker(database, undefined, assertCurrent, async (execution, source) => {
    await execution.prepare(source);
    assertCurrent();
    const prepared = await execution.runExisting(source, (worker) =>
      executeSessionForkOperation(worker, database.agentId, {
        type: "session.checkpoint.prepare",
        input,
      }),
    );
    assertCurrent();
    return { ...(prepared ?? { ownedSessionIds: [] }), databaseIdentity: execution.fileIdentity };
  });
}

async function commitCheckpointInWorker(
  scope: ReturnType<typeof checkpointScope>,
  input: CheckpointWorkerMutation,
  assertCurrent: () => void,
  captured?: NonNullable<ReturnType<typeof captureNativeSessionWorkerDeletion>>,
  expectedIdentity?: AgentDatabaseExecutionFileIdentity,
) {
  const operation: Omit<
    Parameters<
      typeof runSessionEntryWorkerOperation<CheckpointCandidate, CheckpointCandidate["result"]>
    >[0],
    "run"
  > = {
    database: { ...toDatabaseOptions(scope), path: scope.path },
    agentId: scope.agentId,
    databaseIdentity: expectedIdentity?.physicalIdentity,
    candidateKind: "session-checkpoint",
    assertCurrent,
    onCommitted(candidate, published, identity) {
      if (published)
        publishCommittedSessionIdentity(
          scope.agentId,
          identity,
          published.previous,
          published.current,
          published.prepared,
        );
      if (candidate.result.status === "created")
        invalidateSessionBranchCache(scope.path, [
          input.expectedState.sessionId,
          candidate.result.entry.sessionId,
        ]);
      return candidate.result;
    },
  };
  if (captured)
    return runSessionNativeBindingWorkerOperation<
      CheckpointCandidate,
      CheckpointCandidate["result"]
    >({
      ...operation,
      captured,
      entries: captured.participants.map(({ sessionKey, entry }) => ({ sessionKey, entry })),
      execute: (worker, nativeBindings) =>
        worker.execute({
          type: "session.checkpoint.commit",
          input: { ...input, nativeBindings },
        }),
    });
  return runSessionEntryWorkerOperation<CheckpointCandidate, CheckpointCandidate["result"]>({
    ...operation,
    run: (worker, commit) =>
      commit(() =>
        executeSessionForkOperation(worker, scope.databaseAgentId ?? scope.agentId, {
          type: "session.checkpoint.commit",
          input,
        }),
      ),
  });
}

async function prepareLegacyCheckpointSource(
  scope: ReturnType<typeof checkpointScope>,
  prepared: CheckpointPreparation,
  checkpoint: SessionCompactionCheckpoint,
  assertCurrent: () => void,
): Promise<SqliteCompactionCheckpointLegacySource | undefined> {
  const directory = path.dirname(resolveSessionStorePathForScope(scope));
  for (const position of [checkpoint.preCompaction, checkpoint.postCompaction]) {
    const file = position.sessionFile?.trim();
    const boundaryId = position.entryId ?? position.leafId;
    if (!file || !boundaryId || !prepared.ownedSessionIds.includes(position.sessionId)) continue;
    assertCurrent();
    const witness = await captureCheckpointSnapshotWitness(file);
    if (!witness) continue;
    const events = await readOwnedLegacyCheckpoint({
      directory,
      file,
      sessionId: position.sessionId,
      boundaryId,
    });
    assertCurrent();
    if (!events || !isCheckpointSnapshotWitnessCurrent(file, witness)) continue;
    return {
      checkpointId: checkpoint.checkpointId,
      events,
      sessionFile: file,
      sourceLeafId: boundaryId,
      witness,
      ...(checkpoint.tokensVersion === SESSION_TOTAL_TOKENS_VERSION
        ? {
            totalTokens:
              position === checkpoint.preCompaction
                ? checkpoint.tokensBefore
                : checkpoint.tokensAfter,
          }
        : {}),
    };
  }
  return undefined;
}

/** Host owns lifecycle/currentness; the canonical worker owns every SQLite read and commit. */
export async function applySqliteCompactionCheckpointSessionOperation(
  operation: SqliteCompactionCheckpointSessionOperation,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  const sourceKey = normalizeSqliteSessionKey(
    operation.kind === "branch"
      ? (operation.sourceStoreKey ?? operation.sourceKey)
      : (operation.sessionStoreKey ?? operation.sessionKey),
  );
  const targetKey = normalizeSqliteSessionKey(
    operation.kind === "branch" ? operation.nextKey : operation.sessionKey,
  );
  if (
    operation.kind === "branch" &&
    isIncognitoSessionKey(sourceKey) !== isIncognitoSessionKey(targetKey)
  )
    return { status: "conflict" };
  if (hasExistingNativeIncognitoCheckpointOwner({ ...operation, sessionKey: sourceKey }))
    return applyNativeIncognitoCheckpointOperation(operation);
  if (
    isIncognitoSessionKey(sourceKey) &&
    !captureIncognitoSessionSource({ ...operation, sessionKey: sourceKey })
  ) {
    return (
      (await withAcquiredIncognitoSessionBinding(
        { ...operation, sessionKey: sourceKey },
        { assertCurrent: () => operation.commitGuard?.() },
        () => applySqliteCompactionCheckpointSessionOperation(operation),
      )) ?? { status: "missing-session" }
    );
  }
  const scope = checkpointScope(operation, sourceKey);
  const assertCurrent = () => operation.commitGuard?.();
  const binding = captureIncognitoSessionSource({ ...scope, sessionKey: sourceKey });
  if (binding)
    return applyIncognitoCheckpointOperation(scope, operation, sourceKey, targetKey, binding);
  assertCurrent();
  const prepared = await prepareCheckpointInWorker(
    scope,
    { sourceKey, expectedState: operation.expectedState },
    assertCurrent,
  );
  if (!prepared.entry) return { status: "missing-session" };
  if (!checkpointStateMatches(prepared.entry, operation.expectedState))
    return { status: "conflict" };
  const checkpoint = readSessionCompactionCheckpoint(prepared.entry, operation.checkpointId);
  if (!checkpoint) return { status: "missing-checkpoint" };
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  for (const position of [checkpoint.preCompaction, checkpoint.postCompaction]) {
    if (prepared.ownedSessionIds.includes(position.sessionId))
      await restoreSessionColdTranscript(
        { ...scope, sessionKey: sourceKey, sessionId: position.sessionId },
        assertCurrent,
      );
  }
  assertCurrent();
  const legacySource = await prepareLegacyCheckpointSource(
    scope,
    prepared,
    checkpoint,
    assertCurrent,
  );
  const { commitGuard: _guard, ...serializable } = operation;
  const input = {
    ...serializable,
    legacySource,
    sourceKey,
    targetKey,
    scope,
    expectedState: operation.expectedState,
  };
  const mutate = async (assertResetCurrent: () => void) => {
    const current = () => {
      assertCurrent();
      assertResetCurrent();
    };
    const captured =
      operation.kind === "restore"
        ? captureNativeSessionWorkerDeletion([{ sessionKey: sourceKey, entry: prepared.entry! }])
        : undefined;
    if (operation.kind === "restore" && hasPreparedNativeSessionDeletion() && !captured) {
      assertPreparedSessionDeletionNotMixed();
      // Released opaque SDK callbacks retain their original native transaction/rollback semantics.
      // Classification comes from the prepared lifecycle owner, never request data.
      assertNoOwnedSessionTranscriptWriteContextForNativeCompatibility();
      return applyNativeCheckpointCompatibility(scope, input, current, prepared.databaseIdentity);
    }
    return commitCheckpointInWorker(scope, input, current, captured, prepared.databaseIdentity);
  };
  const result =
    operation.kind === "restore"
      ? await withSqliteSessionContextReset(
          scope,
          { sessionKey: sourceKey, entry: prepared.entry },
          mutate,
          assertCurrent,
        )
      : await mutate(assertCurrent);
  if (result.status === "stored" || result.status === "invalid")
    throw new Error("Checkpoint lifecycle returned a metadata write");
  return result;
}

/** Exact pre-worker SDK compatibility, selected only by the prepared opaque lifecycle owner. */
async function applyNativeCheckpointCompatibility(
  scope: ReturnType<typeof checkpointScope>,
  input: CheckpointWorkerMutation,
  assertCurrent: () => void,
  expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined,
) {
  assertNoOwnedSessionTranscriptWriteContextForNativeCompatibility();
  if (input.kind !== "restore" || !expectedIdentity)
    throw new Error("Native checkpoint compatibility lost its prepared physical source");
  const assertHeld = () => {
    assertNoOwnedSessionTranscriptWriteContextForNativeCompatibility();
    assertCurrent();
    assertExistingDatabaseIdentity(
      scope.path,
      `file:${expectedIdentity.physicalIdentity}`,
      expectedIdentity.birthtime,
    );
  };
  return runExclusiveSqliteSessionWrite(
    scope,
    async () => {
      assertHeld();
      const committed = runSqliteSessionDeletionTransaction(
        (database) => {
          assertHeld();
          const keys = collectSessionEntryLookupKeys(input.sourceKey);
          const previous = readSessionIdentitySnapshot(database, keys);
          const result = applySqliteCompactionCheckpointSessionOperationInTransaction(
            database,
            scope,
            input,
            input.sourceKey,
            input.targetKey,
          );
          assertHeld();
          return {
            result,
            publish: prepareSessionIdentityPublication(
              database,
              scope.agentId,
              previous,
              readSessionIdentitySnapshot(database, keys),
            ),
          };
        },
        toDatabaseOptions(scope),
        { operationLabel: "session.checkpoint.restore" },
      );
      if (committed.result.status === "created")
        invalidateSessionBranchCache(scope.path, [
          input.expectedState.sessionId,
          committed.result.entry.sessionId,
        ]);
      committed.publish();
      return committed.result;
    },
    "session.checkpoint.restore",
  );
}

async function applyIncognitoCheckpointOperation(
  scope: ReturnType<typeof checkpointScope>,
  operation: SqliteCompactionCheckpointSessionOperation,
  sourceKey: string,
  targetKey: string,
  binding: NonNullable<ReturnType<typeof captureIncognitoSessionSource>>,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  if ("kind" in binding) {
    binding.assertCurrent();
    return { status: "missing-session" };
  }
  const { actor } = binding;
  const assertCurrent = () => {
    actor.assertCurrent();
    operation.commitGuard?.();
  };
  return actor.sessions.withSharedState(async () => {
    const prepared = await actor.sessions.lifecycle(
      { assertCurrent },
      { type: "session.lifecycle.checkpoint.prepare", input: { sourceKey } },
      binding.admissionSignal,
    );
    if (!prepared.entry) return { status: "missing-session" };
    if (!checkpointStateMatches(prepared.entry, operation.expectedState))
      return { status: "conflict" };
    const { commitGuard: _guard, ...serializable } = operation;
    const target = { sessionKey: sourceKey, entry: prepared.entry };
    const mutate = async (
      assertResetCurrent: () => void,
      capture?: Parameters<Parameters<typeof withSqliteSessionContextReset>[2]>[1],
    ) => {
      const authority = {
        assertCurrent() {
          assertCurrent();
          assertResetCurrent();
        },
      };
      binding.admissionSignal?.throwIfAborted();
      const settlement = operation.kind === "restore" ? capture?.([target]) : undefined;
      const { result } = await actor.sessions.lifecycle(
        authority,
        {
          type: "session.lifecycle.checkpoint.commit",
          input: {
            ...serializable,
            legacySource: undefined,
            sourceKey,
            targetKey,
            scope: { ...scope, path: actor.path },
            ...(operation.kind === "restore" ? { target } : {}),
          },
        },
        undefined,
        settlement ? () => settlement : undefined,
        (candidate) => {
          if (candidate.result.status === "created") {
            invalidateSessionBranchCache(actor.path, [
              prepared.entry!.sessionId,
              candidate.result.entry.sessionId,
            ]);
            publishIncognitoSessionEntry(
              actor,
              targetKey,
              operation.kind === "restore" ? prepared.entry : undefined,
              candidate.result.entry,
            );
          }
        },
      );
      if (result.status === "stored" || result.status === "invalid")
        throw new Error("Incognito checkpoint lifecycle returned a metadata write");
      return result;
    };
    return operation.kind === "restore"
      ? withSqliteSessionContextReset(
          { ...scope, path: actor.path },
          target,
          mutate,
          assertCurrent,
          actor,
        )
      : mutate(assertCurrent);
  });
}

/** Internal transaction primitive; callers must provide lifecycle and authority fences. */
export function captureSqliteCompactionCheckpointInTransaction(
  database: OpenClawAgentDatabase,
  sourceKey: string,
  expectedState: SessionEntryExpectedState,
): { sessionId: string; leafId: string } | null {
  const current = readSessionEntryRow(database, sourceKey)?.entry;
  if (!current || !checkpointStateMatches(current, expectedState)) return null;
  const events = loadTranscriptEventsFromDatabase(database, current.sessionId);
  const tree = scanSessionTranscriptTree(events);
  if (!tree.leafId || !resolveCheckpointBoundaryPath(events, tree.leafId)) return null;
  return { sessionId: current.sessionId, leafId: tree.leafId };
}

export type CapturedSqliteCompactionCheckpoint = SessionEntryExpectedState & {
  leafId: string;
  databaseIdentity?: AgentDatabaseExecutionFileIdentity;
  actorIdentity?: string;
  storageKind?: "native-incognito";
};

/** Capture a consistent durable boundary without opening a Gateway SQLite connection. */
export async function captureSqliteCompactionCheckpoint(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  sessionId: string;
  expectedState?: SessionEntryExpectedState;
  assertActive: () => void;
}): Promise<CapturedSqliteCompactionCheckpoint | null> {
  const sourceKey = normalizeSqliteSessionKey(params.sessionKey);
  if (hasExistingNativeIncognitoCheckpointOwner(params))
    return captureNativeIncognitoCompactionCheckpoint(params);
  if (isIncognitoSessionKey(sourceKey) && !captureIncognitoSessionSource(params)) {
    return (
      (await withAcquiredIncognitoSessionBinding(
        params,
        { assertCurrent: params.assertActive },
        () => captureSqliteCompactionCheckpoint(params),
      )) ?? null
    );
  }
  const scope = checkpointScope(params, sourceKey);
  const binding = captureIncognitoSessionSource({ ...scope, sessionKey: sourceKey });
  if (binding && "kind" in binding) {
    binding.assertCurrent();
    return null;
  }
  const input = { sourceKey, sessionId: params.sessionId, expectedState: params.expectedState };
  const prepared = binding
    ? await binding.actor.sessions.lifecycle(
        {
          assertCurrent() {
            binding.actor.assertCurrent();
            params.assertActive();
          },
        },
        {
          type: "session.lifecycle.checkpoint.prepare",
          input,
        },
        binding.admissionSignal,
      )
    : await prepareCheckpointInWorker(scope, input, params.assertActive);
  params.assertActive();
  return prepared.captured
    ? {
        ...prepared.captured,
        databaseIdentity: prepared.databaseIdentity,
        actorIdentity: binding?.actor.identity.incarnation,
      }
    : null;
}

/** Internal transaction primitive; callers must provide lifecycle and authority fences. */
export function selectRetainedCompactionCheckpoints(
  checkpoints: readonly SessionCompactionCheckpoint[],
  snapshotBytes: ReadonlyMap<string, number>,
): SessionCompactionCheckpoint[] | null {
  const countTrimmed = checkpoints.slice(-25);
  const kept: SessionCompactionCheckpoint[] = [];
  let total = 0;
  for (const checkpoint of countTrimmed.toReversed()) {
    const file = checkpoint.preCompaction.sessionFile?.trim();
    const bytes = file ? snapshotBytes.get(file) : 0;
    // Do not turn absent or invalid size evidence into permission to prune.
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    if (kept.length === 0 || total + bytes <= 128 * 1024 * 1024) {
      kept.push(checkpoint);
      total += bytes;
    }
  }
  return kept.toReversed();
}

/** Internal transaction primitive; callers must provide lifecycle and authority fences. */
export function persistSqliteCompactionCheckpointInTransaction(
  database: OpenClawAgentDatabase,
  sourceKey: string,
  expectedState: SessionEntryExpectedState,
  proposed: SessionCompactionCheckpoint,
  snapshotWitnesses: ReadonlyMap<string, CheckpointSnapshotWitness> = new Map(),
  predecessor?: { captured: SessionEntryExpectedState; transition: SessionAdmissionTransition },
): { status: "stored" | "conflict" | "invalid" } {
  const current = readSessionEntryRow(database, sourceKey)?.entry;
  if (!current || !checkpointStateMatches(current, expectedState)) return { status: "conflict" };
  if (
    !proposed ||
    typeof proposed.checkpointId !== "string" ||
    !readSessionCompactionCheckpoint(
      { compactionCheckpoints: [proposed] },
      proposed.checkpointId,
    ) ||
    proposed.sessionId !== current.sessionId ||
    (proposed.preCompaction.sessionId !== current.sessionId &&
      (!predecessor ||
        predecessor.captured.sessionId !== proposed.preCompaction.sessionId ||
        predecessor.transition.previous?.sessionId !== predecessor.captured.sessionId ||
        predecessor.transition.previous?.lifecycleRevision !==
          predecessor.captured.lifecycleRevision ||
        predecessor.transition.current.sessionId !== current.sessionId ||
        predecessor.transition.current.lifecycleRevision !== current.lifecycleRevision)) ||
    proposed.postCompaction.sessionId !== current.sessionId ||
    !collectSessionEntryLookupKeys(sourceKey).includes(
      normalizeSqliteSessionKey(proposed.sessionKey),
    ) ||
    proposed.preCompaction.sessionFile !== undefined ||
    proposed.postCompaction.sessionFile !== undefined
  )
    return { status: "invalid" };
  const before = proposed.preCompaction.entryId ?? proposed.preCompaction.leafId;
  const after = proposed.postCompaction.entryId ?? proposed.postCompaction.leafId;
  if (
    readSqliteTranscriptRowsForFork(
      database,
      { sessionId: proposed.preCompaction.sessionId, leafId: before },
      sourceKey,
    ).status !== "created" ||
    readSqliteTranscriptRowsForFork(
      database,
      { sessionId: current.sessionId, leafId: after },
      sourceKey,
    ).status !== "created"
  )
    return { status: "invalid" };
  const checkpoints = current.compactionCheckpoints ?? [];
  if (
    !Array.isArray(checkpoints) ||
    checkpoints.some(
      (item) =>
        !isRecord(item) ||
        typeof item.checkpointId !== "string" ||
        item.checkpointId === proposed.checkpointId ||
        !readSessionCompactionCheckpoint({ compactionCheckpoints: checkpoints }, item.checkpointId),
    )
  )
    return { status: "invalid" };
  const snapshotBytes = new Map<string, number>();
  for (const item of [...checkpoints, proposed].slice(-25)) {
    const file = item.preCompaction.sessionFile?.trim();
    if (!file || snapshotBytes.has(file)) continue;
    const window = readCheckpointWindowOwner(database, item.preCompaction.sessionId);
    if (window && !collectSessionEntryLookupKeys(sourceKey).includes(window.session_key))
      return { status: "invalid" };
    const captured = snapshotWitnesses.get(file);
    if (!captured || !isCheckpointSnapshotWitnessCurrent(file, captured))
      return { status: "invalid" };
    snapshotBytes.set(file, captured.size);
  }
  // File identity and ownership still require an authorized caller. This
  // recheck does not make filesystem and database commits atomic.
  const retained = selectRetainedCompactionCheckpoints([...checkpoints, proposed], snapshotBytes);
  if (!retained) return { status: "invalid" };
  writeSessionEntry(database, sourceKey, { ...current, compactionCheckpoints: retained });
  return { status: "stored" };
}

/** Publish only after the original writer's transaction and commit grants settle. */
export async function persistSqliteCompactionCheckpoint(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  source?: CapturedSqliteCompactionCheckpoint;
  expectedState: SessionEntryExpectedState;
  checkpoint: SessionCompactionCheckpoint;
  predecessor?: { captured: SessionEntryExpectedState; transition: SessionAdmissionTransition };
  assertActive: () => void;
}): Promise<{ status: "stored" | "conflict" | "invalid" }> {
  const sourceKey = normalizeSqliteSessionKey(params.sessionKey);
  if (params.source) {
    const original = params.predecessor?.captured ?? params.expectedState;
    if (
      params.source.sessionId !== original.sessionId ||
      params.source.lifecycleRevision !== original.lifecycleRevision ||
      params.source.activeWriterRunId !== original.activeWriterRunId
    )
      return { status: "conflict" };
  }
  if (hasExistingNativeIncognitoCheckpointOwner(params))
    return persistNativeIncognitoCompactionCheckpoint(params);
  if (isIncognitoSessionKey(sourceKey) && !captureIncognitoSessionSource(params)) {
    return (
      (await withAcquiredIncognitoSessionBinding(
        params,
        { assertCurrent: params.assertActive },
        () => persistSqliteCompactionCheckpoint(params),
      )) ?? { status: "conflict" }
    );
  }
  const scope = checkpointScope(params, sourceKey);
  const binding = captureIncognitoSessionSource({ ...scope, sessionKey: sourceKey });
  if (binding && "kind" in binding) {
    binding.assertCurrent();
    return { status: "conflict" };
  }
  const assertCurrent = () => {
    binding?.actor.assertCurrent();
    params.assertActive();
    if (
      params.source?.actorIdentity &&
      params.source.actorIdentity !== binding?.actor.identity.incarnation
    )
      throw new Error("Checkpoint source actor was replaced");
    const original = params.source?.databaseIdentity;
    if (original)
      assertExistingDatabaseIdentity(
        scope.path,
        `file:${original.physicalIdentity}`,
        original.birthtime,
      );
  };
  const prepared = binding
    ? await binding.actor.sessions.lifecycle(
        { assertCurrent },
        { type: "session.lifecycle.checkpoint.prepare", input: { sourceKey } },
        binding.admissionSignal,
      )
    : await prepareCheckpointInWorker(scope, { sourceKey }, assertCurrent);
  if (!prepared.entry || !checkpointStateMatches(prepared.entry, params.expectedState))
    return { status: "conflict" };
  const old = prepared.entry.compactionCheckpoints ?? [];
  if (
    !Array.isArray(old) ||
    old.some(
      (item) =>
        !isRecord(item) ||
        typeof item.checkpointId !== "string" ||
        !readSessionCompactionCheckpoint(prepared.entry!, item.checkpointId),
    )
  )
    return { status: "invalid" };
  const snapshots = old
    .slice(-24)
    .flatMap((item) =>
      item.preCompaction.sessionFile
        ? [{ sessionId: item.preCompaction.sessionId, file: item.preCompaction.sessionFile }]
        : [],
    );
  const witnesses = snapshots.length
    ? await captureOwnedCheckpointSnapshotWitnesses({
        directory: path.dirname(resolveSessionStorePathForScope(scope)),
        snapshots,
        isOwnedSessionId: (id) => prepared.ownedSessionIds.includes(id),
      })
    : new Map<string, CheckpointSnapshotWitness>();
  assertCurrent();
  if (!witnesses) return { status: "invalid" };
  const input: CheckpointWorkerMutation = {
    kind: "persist",
    scope,
    sourceKey,
    targetKey: sourceKey,
    expectedState: structuredClone(params.expectedState),
    checkpoint: structuredClone(params.checkpoint),
    witnesses,
    predecessor: params.predecessor ? structuredClone(params.predecessor) : undefined,
  };
  const result = binding
    ? (
        await binding.actor.sessions.lifecycle(
          { assertCurrent },
          { type: "session.lifecycle.checkpoint.commit", input },
          undefined,
          undefined,
          (candidate) => {
            if (candidate.result.status === "stored" && candidate.entry)
              publishIncognitoSessionEntry(
                binding.actor,
                sourceKey,
                prepared.entry,
                candidate.entry,
              );
          },
        )
      ).result
    : await commitCheckpointInWorker(
        scope,
        input,
        assertCurrent,
        undefined,
        prepared.databaseIdentity,
      );
  if (result.status !== "stored" && result.status !== "conflict" && result.status !== "invalid")
    throw new Error("Checkpoint metadata write returned a lifecycle mutation");
  return result;
}

/** Internal transaction primitive; callers must provide lifecycle and authority fences. */
export function applySqliteCompactionCheckpointSessionOperationInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  operation: SqliteCompactionCheckpointSessionOperation,
  sourceKey: string,
  targetKey: string,
): SqliteCompactionCheckpointSessionMutationResult {
  const currentEntry = readSessionEntryRow(database, sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  if (!checkpointStateMatches(currentEntry, operation.expectedState)) {
    return { status: "conflict" };
  }
  if (currentEntry.modelSelectionLocked === true) {
    return { status: "model-selection-locked" };
  }
  if (operation.kind === "branch" && readSessionEntryRow(database, targetKey)?.entry) {
    return { status: "conflict" };
  }
  const checkpoint = readSessionCompactionCheckpoint(currentEntry, operation.checkpointId);
  if (
    !checkpoint ||
    typeof checkpoint.sessionKey !== "string" ||
    !collectSessionEntryLookupKeys(sourceKey).includes(
      normalizeSqliteSessionKey(checkpoint.sessionKey),
    )
  ) {
    return { status: "missing-checkpoint" };
  }
  const forked = forkSqliteCheckpointTranscriptInTransaction(database, resolved, {
    checkpoint,
    sourceKey,
    legacySource: operation.legacySource,
    targetSessionKey: targetKey,
  });
  if (forked.status !== "created") {
    return forked;
  }
  if (operation.kind === "restore") commitSqliteSessionDeletion(sourceKey, currentEntry);

  const nextEntry =
    operation.kind === "branch"
      ? cloneSqliteCheckpointSessionEntry({
          currentEntry,
          creation: operation.creation,
          label: currentEntry.label?.trim()
            ? `${currentEntry.label.trim()} (checkpoint)`
            : "Checkpoint branch",
          nextSessionId: forked.sessionId,
          parentSessionKey: normalizeSqliteSessionKey(operation.sourceKey),
          totalTokens: forked.totalTokens,
        })
      : cloneSqliteCheckpointSessionEntry({
          currentEntry,
          nextSessionId: forked.sessionId,
          preserveCompactionCheckpoints: true,
          totalTokens: forked.totalTokens,
        });
  if (isIncognitoSessionKey(targetKey)) nextEntry.incognito = true;
  writeSessionEntry(database, targetKey, nextEntry);
  return {
    status: "created",
    key: targetKey,
    checkpoint,
    entry: nextEntry,
  };
}

function forkSqliteCheckpointTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    checkpoint: SessionCompactionCheckpoint;
    sourceKey: string;
    legacySource?: SqliteCompactionCheckpointLegacySource;
    targetSessionKey: string;
  },
):
  | {
      status: "created";
      sessionId: string;
      totalTokens?: number;
    }
  | { status: "missing-boundary" }
  | { status: "failed" } {
  const sources = resolveSqliteCheckpointTranscriptForkSources(params.checkpoint);
  if (sources.length === 0) {
    return { status: "missing-boundary" };
  }
  let lastFailure: { status: "missing-boundary" } | { status: "failed" } = {
    status: "missing-boundary",
  };
  let selected:
    | {
        source: SqliteCheckpointTranscriptForkSource;
        rows: TranscriptEvent[];
      }
    | undefined;
  let legacySource: SqliteCompactionCheckpointLegacySource | undefined;
  for (const source of sources) {
    const rows = readSqliteTranscriptRowsForFork(database, source, params.sourceKey);
    if (rows.status === "created") {
      selected = { source, rows: rows.events };
      break;
    }
    lastFailure = rows;
    const legacy = resolvePreparedLegacyCheckpointSource(params.checkpoint, params.legacySource);
    if (
      legacy &&
      [params.checkpoint.preCompaction, params.checkpoint.postCompaction].some(
        (position) =>
          position.sessionId === source.sessionId &&
          position.sessionFile === legacy.sessionFile &&
          (position.entryId ?? position.leafId) === source.leafId,
      )
    ) {
      legacySource = legacy;
      break;
    }
  }
  if (legacySource) {
    const position = [params.checkpoint.preCompaction, params.checkpoint.postCompaction].find(
      (position) => position.sessionFile === legacySource.sessionFile,
    );
    const window = position ? readCheckpointWindowOwner(database, position.sessionId) : undefined;
    if (
      !position ||
      (window && !collectSessionEntryLookupKeys(params.sourceKey).includes(window.session_key))
    )
      return { status: "missing-boundary" };
  }
  if (!selected && !legacySource) {
    return lastFailure;
  }

  const sessionId = randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: params.targetSessionKey,
  };
  const selectedEvents = selected?.rows ?? legacySource?.events ?? [];
  const totalTokens = selected?.source.totalTokens ?? legacySource?.totalTokens;
  appendTranscriptEventsInTransaction(database, targetScope, [
    createSessionTranscriptHeader({
      cwd: readTranscriptHeaderCwd(selectedEvents),
      sessionId,
      version: findSessionTranscriptHeader(selectedEvents)?.version ?? MIN_READABLE_SESSION_VERSION,
    }),
    ...selectedEvents.filter((event) => !isSessionTranscriptHeader(event)),
  ]);
  reconcileSessionTranscriptIndexInTransaction(database.db, sessionId);
  return {
    status: "created",
    sessionId,
    ...(typeof totalTokens === "number" ? { totalTokens } : {}),
  };
}

function resolvePreparedLegacyCheckpointSource(
  checkpoint: SessionCompactionCheckpoint,
  source: SqliteCompactionCheckpointLegacySource | undefined,
): SqliteCompactionCheckpointLegacySource | undefined {
  if (
    !source ||
    source.checkpointId !== checkpoint.checkpointId ||
    source.events.length === 0 ||
    !source.witness ||
    !isCheckpointSnapshotWitnessCurrent(source.sessionFile, source.witness)
  ) {
    return undefined;
  }
  const matches = [checkpoint.preCompaction, checkpoint.postCompaction].some((position) => {
    const sessionFile = position.sessionFile?.trim();
    const sourceLeafId = position.entryId?.trim() || position.leafId?.trim() || undefined;
    return sessionFile === source.sessionFile && sourceLeafId === source.sourceLeafId;
  });
  return matches ? source : undefined;
}

function resolveSqliteCheckpointTranscriptForkSources(
  checkpoint: SessionCompactionCheckpoint,
): SqliteCheckpointTranscriptForkSource[] {
  const sources: SqliteCheckpointTranscriptForkSource[] = [];
  const checkpointTokensTrusted = checkpoint.tokensVersion === SESSION_TOTAL_TOKENS_VERSION;
  if (checkpoint.preCompaction.sessionId) {
    const preLeafId = checkpoint.preCompaction.entryId ?? checkpoint.preCompaction.leafId;
    sources.push({
      sessionId: checkpoint.preCompaction.sessionId,
      ...(preLeafId ? { leafId: preLeafId } : {}),
      ...(checkpointTokensTrusted && typeof checkpoint.tokensBefore === "number"
        ? { totalTokens: checkpoint.tokensBefore }
        : {}),
    });
  }

  const postLeafId = checkpoint.postCompaction.entryId ?? checkpoint.postCompaction.leafId;
  if (checkpoint.postCompaction.sessionId && postLeafId) {
    sources.push({
      sessionId: checkpoint.postCompaction.sessionId,
      leafId: postLeafId,
      ...(checkpointTokensTrusted && typeof checkpoint.tokensAfter === "number"
        ? { totalTokens: checkpoint.tokensAfter }
        : {}),
    });
  }

  return sources;
}

function readSqliteTranscriptRowsForFork(
  database: OpenClawAgentDatabase,
  source: { sessionId: string; leafId?: string },
  sourceKey: string,
): { status: "created"; events: TranscriptEvent[] } | { status: "missing-boundary" | "failed" } {
  if (!source.leafId) return { status: "missing-boundary" };
  try {
    if (!isCheckpointWindowOwned(database, sourceKey, source.sessionId)) {
      return { status: "missing-boundary" };
    }
    const events = loadTranscriptEventsFromDatabase(database, source.sessionId);
    const header = findSessionTranscriptHeader(events);
    const path = resolveCheckpointBoundaryPath(events, source.leafId);
    if (!header || !path) return { status: "missing-boundary" };
    return { status: "created", events: [header, ...path] };
  } catch {
    return { status: "failed" };
  }
}

function readCheckpointWindowOwner(database: OpenClawAgentDatabase, sessionId: string) {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId),
  );
}

export function isCheckpointWindowOwned(
  database: OpenClawAgentDatabase,
  sourceKey: string,
  sessionId: string,
): boolean {
  const window = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId),
  );
  return Boolean(window && collectSessionEntryLookupKeys(sourceKey).includes(window.session_key));
}

export function readSessionCompactionCheckpoint(
  entry: Pick<SessionEntry, "compactionCheckpoints">,
  checkpointId: string,
): SessionCompactionCheckpoint | undefined {
  const normalizedCheckpointId = checkpointId.trim();
  if (!normalizedCheckpointId || !Array.isArray(entry.compactionCheckpoints)) {
    return undefined;
  }
  const matches: unknown[] = entry.compactionCheckpoints.filter(
    (checkpoint: unknown) =>
      isRecord(checkpoint) && checkpoint.checkpointId === normalizedCheckpointId,
  );
  if (matches.length !== 1 || !isRecord(matches[0])) return undefined;
  const checkpoint = matches[0];
  const nonBlank = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const optionalText = (value: unknown) => value === undefined || nonBlank(value);
  const optionalNumber = (value: unknown) =>
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const validPosition = (value: unknown) =>
    isRecord(value) &&
    nonBlank(value.sessionId) &&
    optionalText(value.sessionFile) &&
    optionalText(value.leafId) &&
    optionalText(value.entryId);
  if (
    !nonBlank(checkpoint.sessionKey) ||
    !nonBlank(checkpoint.sessionId) ||
    typeof checkpoint.createdAt !== "number" ||
    !Number.isSafeInteger(checkpoint.createdAt) ||
    checkpoint.createdAt < 0 ||
    !["manual", "auto-threshold", "overflow-retry", "timeout-retry"].includes(
      String(checkpoint.reason),
    ) ||
    !optionalNumber(checkpoint.tokensBefore) ||
    !optionalNumber(checkpoint.tokensAfter) ||
    !optionalNumber(checkpoint.tokensVersion) ||
    !optionalText(checkpoint.summary) ||
    !optionalText(checkpoint.firstKeptEntryId) ||
    !validPosition(checkpoint.preCompaction) ||
    !validPosition(checkpoint.postCompaction)
  )
    return undefined;
  if (
    checkpoint.tokensVersion !== undefined &&
    checkpoint.tokensVersion !== SESSION_TOTAL_TOKENS_VERSION
  ) {
    const { tokensVersion: _untrusted, ...withoutVersion } = checkpoint;
    return withoutVersion as SessionCompactionCheckpoint;
  }
  return checkpoint as SessionCompactionCheckpoint;
}

function cloneSqliteCheckpointSessionEntry(params: {
  currentEntry: SessionEntry;
  creation?: Parameters<typeof buildSessionCreationStamp>[0];
  nextSessionId: string;
  label?: string;
  parentSessionKey?: string;
  totalTokens?: number;
  preserveCompactionCheckpoints?: boolean;
}): SessionEntry {
  const hasTotalTokens =
    typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens);
  return {
    ...(params.parentSessionKey
      ? inheritSessionSelection(params.currentEntry)
      : params.currentEntry),
    // A new branch belongs to its requester, including an explicitly absent
    // sandbox floor. Restore and actorless branches retain the source stamp.
    ...(params.parentSessionKey && !params.creation
      ? {
          createdVia: params.currentEntry.createdVia,
          createdSurface: params.currentEntry.createdSurface,
          createdActor: params.currentEntry.createdActor,
          createdAt: params.currentEntry.createdAt,
          sandbox: params.currentEntry.sandbox,
        }
      : {}),
    ...(params.creation
      ? {
          ...buildSessionCreationStamp(params.creation),
          createdActor: params.creation.actor,
          sandbox: params.creation.sandbox,
        }
      : {}),
    sessionId: params.nextSessionId,
    ...(params.currentEntry.incognito ? { incognito: true } : {}),
    lifecycleRevision: params.parentSessionKey
      ? randomUUID()
      : params.currentEntry.lifecycleRevision,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    lifecycleRunId: undefined,
    activeWriterRunId: undefined,
    lastRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    transcriptByteCompactionLatch: undefined,
    contextTokens: undefined,
    contextTokensSource: undefined,
    contextBudgetStatus: undefined,
    compactionCount: undefined,
    memoryFlush: undefined,
    cliSessionBindings: undefined,
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
    agentHarnessId: undefined,
    modelSelectionLocked: undefined,
    skillsSnapshot: undefined,
    systemPromptReport: undefined,
    restartRecoveryRuns: undefined,
    restartRecoveryForceSafeTools: undefined,
    abortCutoffMessageSid: undefined,
    abortCutoffTimestamp: undefined,
    previousSessionId: params.parentSessionKey ? undefined : params.currentEntry.sessionId,
    totalTokens: hasTotalTokens ? params.totalTokens : undefined,
    totalTokensFresh: hasTotalTokens ? true : undefined,
    totalTokensVersion: hasTotalTokens ? SESSION_TOTAL_TOKENS_VERSION : undefined,
    label: params.label ?? params.currentEntry.label,
    parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
    compactionCheckpoints: params.preserveCompactionCheckpoints
      ? params.currentEntry.compactionCheckpoints
      : undefined,
  };
}

function readTranscriptHeaderCwd(events: readonly TranscriptEvent[]): string | undefined {
  const header = events.find(isSessionTranscriptHeader) as { cwd?: unknown } | undefined;
  return typeof header?.cwd === "string" && header.cwd.trim() ? header.cwd : undefined;
}

function isSessionTranscriptHeader(event: TranscriptEvent): boolean {
  return Boolean(
    event &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    (event as { type?: unknown }).type === "session",
  );
}
