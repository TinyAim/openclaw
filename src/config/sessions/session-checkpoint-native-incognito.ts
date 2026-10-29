import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  listOpenIncognitoAgentDatabases,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { invalidateSessionBranchCache } from "./session-accessor.sqlite-branches.js";
import {
  applySqliteCompactionCheckpointSessionOperationInTransaction,
  captureSqliteCompactionCheckpointInTransaction,
  checkpointStateMatches,
  persistSqliteCompactionCheckpointInTransaction,
  readSessionCompactionCheckpoint,
  type CapturedSqliteCompactionCheckpoint,
  type SessionEntryExpectedState,
  type SqliteCompactionCheckpointSessionOperation,
  type SqliteCompactionCheckpointSessionMutationResult,
} from "./session-accessor.sqlite-checkpoint.js";
import {
  assertNoPreparedNativeSessionDeletionWorkerParticipant,
  runSqliteSessionDeletionTransaction,
  withSqliteSessionContextReset,
} from "./session-accessor.sqlite-deletion.js";
import type { SessionAdmissionTransition } from "./session-accessor.sqlite-entry-admission.js";
import {
  readSessionEntryRow,
  readSessionIdentitySnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { isNativeSessionEntryRead } from "./session-entry-read-request.js";
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";
import { collectSessionEntryLookupKeys, normalizeStoreSessionKey } from "./store-entry.js";
import { assertNoOwnedSessionTranscriptWriteContextForNativeCompatibility } from "./transcript-write-context.js";
import type { SessionCompactionCheckpoint } from "./types.js";

type Scope = { agentId?: string; env?: NodeJS.ProcessEnv; storePath?: string; sessionKey: string };
type NativeOwner = {
  database: OpenClawAgentDatabase;
  scope: ReturnType<typeof resolveSqliteScope>;
  assertCurrent(): void;
};
const captureOwners = new WeakMap<CapturedSqliteCompactionCheckpoint, NativeOwner>();

/** Classification borrows existing process facts; it never opens or creates a database. */
export function hasExistingNativeIncognitoCheckpointOwner(params: Scope): boolean {
  if (!isMainThread || captureIncognitoSessionSource(params)) return false;
  const scope = resolveSqliteScope(params);
  const pathname = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  return (
    isNativeSessionEntryRead(params, scope.agentId) &&
    listOpenIncognitoAgentDatabases().some(
      (owner) =>
        owner.agentId === (scope.databaseAgentId ?? scope.agentId) && owner.storePath === pathname,
    )
  );
}
function captureOwner(params: Scope): NativeOwner {
  assertNoOwnedSessionTranscriptWriteContextForNativeCompatibility();
  if (!hasExistingNativeIncognitoCheckpointOwner(params))
    throw new Error("Native incognito checkpoint lost its existing owner");
  const scope = resolveSqliteScope(params);
  const options = toDatabaseOptions(scope);
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database) throw new Error("Native incognito checkpoint cannot create a database");
  const identity = readOpenClawAgentDatabaseIdentity(database);
  return {
    database,
    scope,
    assertCurrent() {
      assertNoOwnedSessionTranscriptWriteContextForNativeCompatibility();
      if (
        !database.db.isOpen ||
        captureIncognitoSessionSource(params) ||
        getOpenClawAgentDatabaseIfOpen(options) !== database ||
        readOpenClawAgentDatabaseIdentity(database).incarnation !== identity.incarnation ||
        !hasExistingNativeIncognitoCheckpointOwner(params)
      ) {
        throw new Error("Native incognito checkpoint owner changed");
      }
    },
  };
}
export function captureNativeIncognitoCompactionCheckpoint(
  params: Scope & {
    sessionId: string;
    expectedState?: SessionEntryExpectedState;
    assertActive(): void;
  },
): CapturedSqliteCompactionCheckpoint | null {
  const owner = captureOwner(params);
  params.assertActive();
  return runSqliteDeferredTransactionSync(
    owner.database.db,
    () => {
      owner.assertCurrent();
      params.assertActive();
      const key = normalizeStoreSessionKey(params.sessionKey);
      const entry = readSessionEntryRow(owner.database, key)?.entry;
      if (
        !entry ||
        entry.sessionId !== params.sessionId ||
        (params.expectedState && !checkpointStateMatches(entry, params.expectedState))
      )
        return null;
      const expected = {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      };
      const boundary = captureSqliteCompactionCheckpointInTransaction(
        owner.database,
        key,
        expected,
      );
      if (!boundary) return null;
      const captured: CapturedSqliteCompactionCheckpoint = {
        ...expected,
        leafId: boundary.leafId,
        storageKind: "native-incognito",
      };
      captureOwners.set(captured, owner);
      return captured;
    },
    { operationLabel: "session.checkpoint.capture" },
  );
}
/** SQL-free check of the Host's actual pre-capture, never a caller's structural witness. */
export function isNativeIncognitoCheckpointCaptureForTarget(
  captured: CapturedSqliteCompactionCheckpoint,
  params: Scope & { sessionId: string },
): boolean {
  const owner = captureOwners.get(captured);
  if (!owner || captured.sessionId !== params.sessionId) return false;
  const selected = resolveSqliteScope(params);
  return (
    selected.agentId === owner.scope.agentId &&
    normalizeStoreSessionKey(params.sessionKey) === owner.scope.sessionKey &&
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(selected)) === owner.database.path
  );
}
export async function persistNativeIncognitoCompactionCheckpoint(
  params: Scope & {
    expectedState: SessionEntryExpectedState;
    checkpoint: SessionCompactionCheckpoint;
    source?: CapturedSqliteCompactionCheckpoint;
    predecessor?: { captured: SessionEntryExpectedState; transition: SessionAdmissionTransition };
    assertActive(): void;
  },
): Promise<{ status: "stored" | "conflict" | "invalid" }> {
  const owner = captureOwner(params);
  if (params.source) {
    const original = captureOwners.get(params.source);
    if (
      !original ||
      original.database !== owner.database ||
      original.scope.sessionKey !== owner.scope.sessionKey
    )
      return { status: "conflict" };
    original.assertCurrent();
  }
  const release = retainAgentDatabase(owner.database.db);
  const key = normalizeStoreSessionKey(params.sessionKey);
  const assertCurrent = () => {
    owner.assertCurrent();
    params.assertActive();
  };
  try {
    const result = await runExclusiveSqliteSessionWrite(
      owner.scope,
      async () => {
        assertCurrent();
        const committed = runSqliteSessionDeletionTransaction(
          (database) => {
            assertCurrent();
            if (database !== owner.database)
              throw new Error("Native checkpoint changed its admitted connection");
            const keys = collectSessionEntryLookupKeys(key);
            const previous = readSessionIdentitySnapshot(database, keys);
            const result = persistSqliteCompactionCheckpointInTransaction(
              database,
              key,
              params.expectedState,
              params.checkpoint,
              new Map(),
              params.predecessor,
            );
            assertCurrent();
            return {
              result,
              publish: prepareSessionIdentityPublication(
                database,
                owner.scope.agentId,
                previous,
                readSessionIdentitySnapshot(database, keys),
              ),
            };
          },
          toDatabaseOptions(owner.scope),
          { operationLabel: "session.checkpoint.persist" },
        );
        committed.publish();
        return committed.result;
      },
      "session-entry.patch",
    );
    assertCurrent();
    if (result.status !== "stored") return result;
    // Native manual compaction is terminal only after real persisted metadata readback.
    const entry = readSessionEntryRow(owner.database, key)?.entry;
    return entry &&
      checkpointStateMatches(entry, params.expectedState) &&
      isDeepStrictEqual(
        readSessionCompactionCheckpoint(entry, params.checkpoint.checkpointId),
        params.checkpoint,
      )
      ? { status: "stored" }
      : { status: "conflict" };
  } finally {
    release();
  }
}
export async function applyNativeIncognitoCheckpointOperation(
  operation: SqliteCompactionCheckpointSessionOperation,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  const sourceKey = normalizeStoreSessionKey(
    operation.kind === "branch"
      ? (operation.sourceStoreKey ?? operation.sourceKey)
      : (operation.sessionStoreKey ?? operation.sessionKey),
  );
  const targetKey = normalizeStoreSessionKey(
    operation.kind === "branch" ? operation.nextKey : operation.sessionKey,
  );
  const owner = captureOwner({ ...operation, sessionKey: sourceKey });
  const release = retainAgentDatabase(owner.database.db);
  const assertCurrent = () => {
    owner.assertCurrent();
    operation.commitGuard?.();
  };
  try {
    assertCurrent();
    const prepared = readSessionEntryRow(owner.database, sourceKey)?.entry;
    if (!prepared) return { status: "missing-session" };
    if (!checkpointStateMatches(prepared, operation.expectedState)) return { status: "conflict" };
    const mutate = (assertResetCurrent: () => void) => {
      if (operation.kind === "restore") assertNoPreparedNativeSessionDeletionWorkerParticipant();
      return runExclusiveSqliteSessionWrite(
        owner.scope,
        async () => {
          const assertHeld = () => {
            assertCurrent();
            assertResetCurrent();
          };
          assertHeld();
          const committed = runSqliteSessionDeletionTransaction(
            (database) => {
              assertHeld();
              if (database !== owner.database)
                throw new Error("Native checkpoint changed its admitted connection");
              const keys = [
                ...new Set([
                  ...collectSessionEntryLookupKeys(sourceKey),
                  ...collectSessionEntryLookupKeys(targetKey),
                ]),
              ];
              const previous = readSessionIdentitySnapshot(database, keys);
              const result = applySqliteCompactionCheckpointSessionOperationInTransaction(
                database,
                owner.scope,
                operation,
                sourceKey,
                targetKey,
              );
              assertHeld();
              return {
                result,
                publish: prepareSessionIdentityPublication(
                  database,
                  owner.scope.agentId,
                  previous,
                  readSessionIdentitySnapshot(database, keys),
                ),
              };
            },
            toDatabaseOptions(owner.scope),
            { operationLabel: `session.checkpoint.${operation.kind}` },
          );
          if (committed.result.status === "created")
            invalidateSessionBranchCache(owner.database.path, [
              prepared.sessionId,
              committed.result.entry.sessionId,
            ]);
          committed.publish();
          return committed.result;
        },
        operation.kind === "branch" ? "session.checkpoint.branch" : "session.checkpoint.restore",
      );
    };
    return operation.kind === "restore"
      ? await withSqliteSessionContextReset(
          owner.scope,
          { sessionKey: sourceKey, entry: prepared },
          mutate,
          assertCurrent,
        )
      : await mutate(assertCurrent);
  } finally {
    release();
  }
}
