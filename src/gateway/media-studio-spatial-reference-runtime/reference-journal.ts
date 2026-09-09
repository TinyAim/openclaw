/** Durable execution metadata and receipt-only outbox; never persists grants or media bytes. */
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import {
  createCorePluginStateSyncKeyedStore,
  type CorePluginStateSyncKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
import { PluginStateStoreError } from "../../plugin-state/plugin-state-store.types.js";
import type { SpatialReferenceRelayDispatchAck } from "../media-studio-spatial-reference-render-http.js";
import type { SpatialReferenceTerminalCallback } from "./reference-callback.js";
import {
  SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
  type SpatialReferenceJournalMigration,
  type SpatialReferenceJournalRow,
  type SpatialReferenceJournalStoredValue,
} from "./reference-journal-record.js";
import {
  createSpatialReferenceJournalStore,
  type SpatialReferenceJournal,
  type SpatialReferenceJournalBackend,
} from "./reference-journal-store.js";

export {
  SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
  type SpatialReferenceExpectedOutput,
  type SpatialReferenceFinalizedOutput,
  type SpatialReferenceJournalIdentity,
  type SpatialReferenceJournalOwner,
  type SpatialReferenceJournalRenderProof,
  type SpatialReferenceJournalRow,
  type SpatialReferenceJournalWorker,
  type SpatialReferenceJournalScopeGuardian,
  type SpatialReferenceJournalScopeRecovery,
  type SpatialReferencePreparedOutput,
} from "./reference-journal-record.js";
export type {
  SpatialReferenceExclusiveAdmissionClaimInput,
  SpatialReferenceExclusiveAdmissionClaimResult,
  SpatialReferenceExclusiveAdmissionReleaseInput,
  SpatialReferenceExclusiveAdmissionReleaseResult,
  SpatialReferenceJournal,
  SpatialReferenceJournalAcceptDetails,
  SpatialReferenceJournalAcceptInput,
  SpatialReferenceJournalCheckpointInput,
  SpatialReferenceJournalClaimContext,
  SpatialReferenceJournalClaimInput,
  SpatialReferenceJournalClaimResult,
  SpatialReferenceJournalReleaseInput,
  SpatialReferenceJournalArmScopeGuardianInput,
  SpatialReferenceJournalScopeObservationInput,
  SpatialReferenceJournalReconcileScopeInput,
  SpatialReferenceJournalReconcileScopeResult,
} from "./reference-journal-store.js";
export type {
  SpatialReferenceJournalRecordSpawnIntentInput,
  SpatialReferenceJournalRecordWorkerPreparedInput,
  SpatialReferenceJournalAuthorizeWorkerStartInput,
} from "./reference-journal-contract.js";
export {
  SPATIAL_REFERENCE_QUALIFICATION_KEY,
  SPATIAL_REFERENCE_RUNTIME_LOCK_KEY,
} from "./reference-journal-store.js";

const CORE_OWNER_ID = "core:media-studio-spatial-reference-runtime" as const;
const JOURNAL_MAX_ENTRIES = 512;
const MIGRATION_KEY = "@legacy-json-migration";

export type SpatialReferenceJournalOptions = {
  env: NodeJS.ProcessEnv;
  namespace: string;
  /** Explicit v1 import source. It is never a live journal file path. */
  legacyFilePath?: string;
};

type LegacyRow = {
  key: string;
  dispatchAttemptId: string;
  cancelled: boolean;
  requestDigest?: string;
  ack?: SpatialReferenceRelayDispatchAck;
  callback?: SpatialReferenceTerminalCallback;
  delivered?: boolean;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLegacy(raw: string): LegacyRow[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_INVALID");
  }
  if (
    !isObject(decoded) ||
    decoded.version !== 1 ||
    !Array.isArray(decoded.rows) ||
    !Object.keys(decoded).every((key) => key === "version" || key === "rows")
  ) {
    throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_INVALID");
  }
  const rows: LegacyRow[] = [];
  const keys = new Set<string>();
  for (const value of decoded.rows) {
    if (
      !isObject(value) ||
      !Object.keys(value).every((key) =>
        [
          "key",
          "dispatchAttemptId",
          "cancelled",
          "requestDigest",
          "ack",
          "callback",
          "delivered",
        ].includes(key),
      )
    ) {
      throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_INVALID");
    }
    if (
      typeof value.key !== "string" ||
      !value.key ||
      typeof value.dispatchAttemptId !== "string" ||
      !value.dispatchAttemptId ||
      typeof value.cancelled !== "boolean" ||
      (value.requestDigest !== undefined && typeof value.requestDigest !== "string") ||
      (value.delivered !== undefined && typeof value.delivered !== "boolean")
    ) {
      throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_INVALID");
    }
    if (
      value.ack !== undefined &&
      (!isObject(value.ack) || value.ack.dispatchAttemptId !== value.dispatchAttemptId)
    ) {
      throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_INVALID");
    }
    if (
      value.callback !== undefined &&
      (!isObject(value.callback) ||
        value.callback.kind !== "media_studio.spatial_reference_render.callback" ||
        value.callback.dispatchAttemptId !== value.dispatchAttemptId)
    ) {
      throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_INVALID");
    }
    if (keys.has(value.key)) throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_INVALID");
    keys.add(value.key);
    rows.push(clone(value) as LegacyRow);
  }
  return rows;
}

function legacyRecord(row: LegacyRow): SpatialReferenceJournalRow {
  return {
    recordType: "execution",
    schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
    key: row.key,
    dispatchAttemptId: row.dispatchAttemptId,
    cancelled: row.cancelled,
    phase: row.callback ? "terminal" : "legacy_nonresumable",
    ...(row.requestDigest ? { requestDigest: row.requestDigest } : {}),
    ...(row.ack ? { ack: row.ack } : {}),
    ...(row.callback ? { callback: row.callback } : {}),
    ...(row.delivered === undefined ? {} : { delivered: row.delivered }),
  };
}

function memoryBackend(): SpatialReferenceJournalBackend {
  const values = new Map<string, SpatialReferenceJournalStoredValue>();
  return {
    lookup: (key) => (values.get(key) === undefined ? undefined : clone(values.get(key)!)),
    update: (key, updater) =>
      values.set(
        key,
        clone(updater(values.get(key) === undefined ? undefined : clone(values.get(key)!))),
      ),
    transaction: (keys, mutate) => {
      const staged = new Map<string, SpatialReferenceJournalStoredValue | undefined>();
      const transaction = {
        lookup: (key: string) => {
          if (!keys.includes(key))
            throw new Error("SPATIAL_REFERENCE_JOURNAL_TRANSACTION_KEY_INVALID");
          return staged.has(key)
            ? staged.get(key)
            : values.get(key) === undefined
              ? undefined
              : clone(values.get(key)!);
        },
        set: (key: string, value: SpatialReferenceJournalStoredValue) => {
          if (!keys.includes(key))
            throw new Error("SPATIAL_REFERENCE_JOURNAL_TRANSACTION_KEY_INVALID");
          staged.set(key, clone(value));
        },
        delete: (key: string) => {
          if (!keys.includes(key))
            throw new Error("SPATIAL_REFERENCE_JOURNAL_TRANSACTION_KEY_INVALID");
          staged.set(key, undefined);
        },
      };
      const result = mutate(transaction);
      if (result && typeof result === "object" && "then" in (result as object)) {
        throw new Error("SPATIAL_REFERENCE_JOURNAL_TRANSACTION_ASYNC_MUTATOR");
      }
      for (const [key, value] of staged) {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      }
      return result;
    },
    entries: () => [...values.values()].map(clone),
  };
}

function rethrowJournalDomainError(error: unknown): never {
  const cause = error instanceof PluginStateStoreError ? error.cause : undefined;
  if (cause instanceof Error && cause.message.startsWith("SPATIAL_REFERENCE_")) throw cause;
  throw error;
}

function sqliteBackend(options: SpatialReferenceJournalOptions): SpatialReferenceJournalBackend {
  const state: CorePluginStateSyncKeyedStore<SpatialReferenceJournalStoredValue> =
    createCorePluginStateSyncKeyedStore({
      ownerId: CORE_OWNER_ID,
      namespace: options.namespace,
      maxEntries: JOURNAL_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: options.env,
    });
  return {
    lookup: (key) => state.lookup(key),
    update: (key, updater) => {
      try {
        if (!state.update(key, updater)) throw new Error("SPATIAL_REFERENCE_JOURNAL_WRITE_FAILED");
      } catch (error) {
        rethrowJournalDomainError(error);
      }
    },
    transaction: (keys, mutate) => {
      try {
        return state.transaction(keys, (transaction) =>
          mutate({
            lookup: (key) => transaction.lookup(key),
            set: (key, value) => transaction.set(key, value),
            delete: (key) => transaction.delete(key),
          }),
        );
      } catch (error) {
        rethrowJournalDomainError(error);
      }
    },
    entries: () => state.entries().map((entry) => entry.value),
  };
}

async function migrateLegacy(
  backend: SpatialReferenceJournalBackend,
  filePath: string,
): Promise<void> {
  const marker = backend.lookup(MIGRATION_KEY);
  if (marker) {
    if (marker.recordType !== "migration" || marker.state !== "complete")
      throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_MIGRATION_INCOMPLETE");
    return;
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const rows = parseLegacy(raw);
  const sourceDigest = createHash("sha256").update(raw).digest("hex");
  const started: SpatialReferenceJournalMigration = {
    recordType: "migration",
    schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
    state: "in_progress",
    sourceDigest,
  };
  backend.update(MIGRATION_KEY, (current) => {
    if (current) throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_MIGRATION_INCOMPLETE");
    return started;
  });
  for (const old of rows) {
    const imported = legacyRecord(old);
    backend.update(old.key, (current) => {
      if (current) throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_MIGRATION_CONFLICT");
      return imported;
    });
    if (JSON.stringify(backend.lookup(old.key)) !== JSON.stringify(imported)) {
      throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_MIGRATION_READBACK_FAILED");
    }
  }
  try {
    await rename(filePath, `${filePath}.spatial-reference-journal.v1-archived`);
  } catch (error) {
    throw new Error(
      `SPATIAL_REFERENCE_JOURNAL_LEGACY_ARCHIVE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  backend.update(MIGRATION_KEY, (current) => {
    if (
      !current ||
      current.recordType !== "migration" ||
      current.state !== "in_progress" ||
      current.sourceDigest !== sourceDigest
    ) {
      throw new Error("SPATIAL_REFERENCE_JOURNAL_LEGACY_MIGRATION_INCOMPLETE");
    }
    return { ...current, state: "complete" };
  });
}

function gateJournal(
  journal: SpatialReferenceJournal,
  ready: Promise<void>,
): SpatialReferenceJournal {
  const gate = async <T>(operation: () => Promise<T>): Promise<T> => {
    await ready;
    return operation();
  };
  return {
    ...journal,
    accept: ((...args: unknown[]) =>
      gate(() =>
        (journal.accept as (...input: unknown[]) => Promise<unknown>)(...args),
      )) as SpatialReferenceJournal["accept"],
    cancel: (...args) => gate(() => journal.cancel(...args)),
    finish: (...args) => gate(() => journal.finish(...args)),
    list: () => gate(() => journal.list()),
    get: (key) => gate(() => journal.get(key)),
    getRuntimeAdmission: () => gate(() => journal.getRuntimeAdmission()),
    claimExclusiveAdmission: (input) => gate(() => journal.claimExclusiveAdmission(input)),
    releaseExclusiveAdmission: (input) => gate(() => journal.releaseExclusiveAdmission(input)),
    delivered: (...args) => gate(() => journal.delivered(...args)),
    claim: (input) => gate(() => journal.claim(input)),
    checkClaim: (input) => gate(() => journal.checkClaim(input)),
    checkpoint: (input) => gate(() => journal.checkpoint(input)),
    release: (input) => gate(() => journal.release(input)),
    armScopeGuardian: (input) => gate(() => journal.armScopeGuardian(input)),
    recordSpawnIntent: (input) => gate(() => journal.recordSpawnIntent(input)),
    recordWorkerPrepared: (input) => gate(() => journal.recordWorkerPrepared(input)),
    authorizeWorkerStart: (input) => gate(() => journal.authorizeWorkerStart(input)),
    recordScopeObservation: (input) => gate(() => journal.recordScopeObservation(input)),
    reconcileScope: (input) => gate(() => journal.reconcileScope(input)),
  };
}

/** No options is an in-memory compatibility seam for tests only. */
export function createSpatialReferenceJournal(
  options?: SpatialReferenceJournalOptions | string,
): SpatialReferenceJournal {
  if (!options)
    return createSpatialReferenceJournalStore({ authority: "memory", backend: memoryBackend() });
  if (typeof options === "string") throw new Error("SPATIAL_REFERENCE_JOURNAL_OPTIONS_REQUIRED");
  const backend = sqliteBackend(options);
  return gateJournal(
    createSpatialReferenceJournalStore({ authority: "sqlite", backend }),
    options.legacyFilePath ? migrateLegacy(backend, options.legacyFilePath) : Promise.resolve(),
  );
}
