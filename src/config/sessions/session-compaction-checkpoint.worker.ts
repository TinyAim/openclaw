import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseExecutionFileIdentity } from "../../state/openclaw-agent-execution-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  applySqliteCompactionCheckpointSessionOperationInTransaction,
  captureSqliteCompactionCheckpointInTransaction,
  checkpointStateMatches,
  persistSqliteCompactionCheckpointInTransaction,
  readSessionCompactionCheckpoint,
  type CapturedSqliteCompactionCheckpoint,
  type SessionEntryExpectedState,
  type SqliteCompactionCheckpointSessionMutationResult,
  type SqliteCompactionCheckpointSessionOperation,
} from "./session-accessor.sqlite-checkpoint.js";
import { withSqliteSessionDeletionWorkerParticipant } from "./session-accessor.sqlite-deletion.js";
import type { SessionAdmissionTransition } from "./session-accessor.sqlite-entry-admission.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  readSessionEntryRow,
  readSessionIdentitySnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { CheckpointSnapshotWitness } from "./session-checkpoint-snapshot-witness.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import type { InternalSessionEntry, SessionCompactionCheckpoint } from "./types.js";

export type CheckpointPreparation = {
  entry?: InternalSessionEntry;
  captured?: CapturedSqliteCompactionCheckpoint;
  ownedSessionIds: string[];
  databaseIdentity?: AgentDatabaseExecutionFileIdentity;
};
export type CheckpointPreparationInput = {
  sourceKey: string;
  sessionId?: string;
  expectedState?: SessionEntryExpectedState;
};
export type CheckpointWorkerMutation = (
  | (SqliteCompactionCheckpointSessionOperation & { sourceKey: string })
  | {
      kind: "persist";
      checkpoint: SessionCompactionCheckpoint;
      witnesses: ReadonlyMap<string, CheckpointSnapshotWitness>;
      predecessor?: { captured: SessionEntryExpectedState; transition: SessionAdmissionTransition };
    }
) & {
  scope: ResolvedSqliteScope;
  sourceKey: string;
  targetKey: string;
  expectedState: SessionEntryExpectedState;
  nativeBindings?: SessionNativeBindingParticipants;
};
export type CheckpointCandidate = {
  kind: "session-checkpoint";
  result:
    | SqliteCompactionCheckpointSessionMutationResult
    | { status: "stored" }
    | { status: "invalid" };
  publication?: SessionEntryReplacementPublication;
};

export function prepareCompactionCheckpoint(
  input: CheckpointPreparationInput,
  { open }: Pick<AgentWorkerOperationContext, "open">,
): CheckpointPreparation {
  const database = open();
  return runSqlitePinnedReadSnapshotSync(database.db, () => {
    const entry = readSessionEntryRow(database, input.sourceKey)?.entry;
    if (!entry) return { ownedSessionIds: [] };
    const aliases = collectSessionEntryLookupKeys(input.sourceKey);
    const references = Array.isArray(entry.compactionCheckpoints)
      ? entry.compactionCheckpoints.flatMap((raw) =>
          [raw?.preCompaction?.sessionId, raw?.postCompaction?.sessionId].filter(
            (id): id is string => typeof id === "string",
          ),
        )
      : [];
    const windows = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_windows")
        .select(["session_id", "session_key"])
        .where((eb) =>
          eb.or([
            eb("session_key", "in", aliases),
            ...(references.length ? [eb("session_id", "in", references)] : []),
          ]),
        ),
    ).rows;
    const ownedSessionIds = windows
      .filter((window) => aliases.includes(window.session_key))
      .map((window) => window.session_id);
    // Pre-SQLite snapshots have no window row. Their recorded, key-bound metadata
    // may authorize a confined legacy file, never another key's existing window.
    for (const raw of Array.isArray(entry.compactionCheckpoints)
      ? entry.compactionCheckpoints
      : []) {
      const checkpoint = readSessionCompactionCheckpoint(entry, raw.checkpointId);
      if (!checkpoint || !aliases.includes(checkpoint.sessionKey)) continue;
      for (const position of [checkpoint.preCompaction, checkpoint.postCompaction]) {
        if (
          position.sessionFile &&
          !windows.some((window) => window.session_id === position.sessionId)
        )
          ownedSessionIds.push(position.sessionId);
      }
    }
    const matches =
      (!input.sessionId || entry.sessionId === input.sessionId) &&
      (!input.expectedState || checkpointStateMatches(entry, input.expectedState));
    const captured =
      matches && input.sessionId !== undefined
        ? captureSqliteCompactionCheckpointInTransaction(database, input.sourceKey, {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          })
        : null;
    return {
      entry,
      ownedSessionIds: uniqueStrings(ownedSessionIds),
      ...(captured
        ? {
            captured: {
              ...captured,
              lifecycleRevision: entry.lifecycleRevision,
              activeWriterRunId: entry.activeWriterRunId,
            },
          }
        : {}),
    };
  });
}

export function mutateCompactionCheckpointInTransaction(
  database: OpenClawAgentDatabase,
  input: CheckpointWorkerMutation,
): CheckpointCandidate["result"] {
  return input.kind === "persist"
    ? persistSqliteCompactionCheckpointInTransaction(
        database,
        input.sourceKey,
        input.expectedState,
        input.checkpoint,
        input.witnesses,
        input.predecessor,
      )
    : applySqliteCompactionCheckpointSessionOperationInTransaction(
        database,
        input.scope,
        input,
        input.sourceKey,
        input.targetKey,
      );
}

export function commitCompactionCheckpoint(
  input: CheckpointWorkerMutation,
  context: AgentWorkerOperationContext,
) {
  const mutate = (database: OpenClawAgentDatabase): CheckpointCandidate => {
    const keys = uniqueStrings([
      ...collectSessionEntryLookupKeys(input.sourceKey),
      ...collectSessionEntryLookupKeys(input.targetKey),
    ]);
    const previous = readSessionIdentitySnapshot(database, keys);
    const result = mutateCompactionCheckpointInTransaction(database, input);
    return {
      kind: "session-checkpoint",
      result,
      publication:
        result.status === "created" || result.status === "stored"
          ? prepareSessionEntryReplacementPublication(
              {
                previous,
                current: readSessionIdentitySnapshot(database, keys),
                pendingArchiveRecovery: false,
                membershipInvalidatedKeys: result.status === "created" ? [input.targetKey] : [],
                maintenancePlans: [],
              },
              database,
            )
          : undefined,
    };
  };
  if (input.nativeBindings)
    return runSessionNativeBindingTransaction(
      input.nativeBindings,
      context,
      "session.checkpoint.commit",
      "Session compaction checkpoint",
      (database, wrapReceipt) =>
        transferSessionEntryWorkerCandidate(database, context.admit, mutate(database), wrapReceipt),
    );
  return withSqliteSessionDeletionWorkerParticipant(
    () => {},
    () =>
      context.writeTransaction(
        "session.checkpoint.commit",
        "Session compaction checkpoint",
        (database) =>
          transferSessionEntryWorkerCandidate(database, context.admit, mutate(database)),
      ),
  );
}
