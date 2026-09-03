import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SpawnSubagentResult } from "../../agents/subagents/spawn/subagent-spawn-contract.js";
import { resolveStateDir } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import { loadJsonFileThroughSymlink } from "../../infra/json-file.js";
import { writeJsonAtomic } from "../../infra/json-files.js";

type OperatorSpawnResult = Omit<SpawnSubagentResult, "status"> & {
  status: SpawnSubagentResult["status"] | "outcome_unknown" | "idempotency_conflict";
};

export type OperatorSubagentAcceptedTombstone = {
  runId: string;
  childSessionKey: string;
  acceptedAt: number;
};

type SpawnLedgerEntry = {
  idempotencyHash: string;
  fingerprint: string;
  /** SHA-256 requester-session fence. The raw requester key is never persisted here. */
  requesterScopeHash?: string;
  /**
   * Exact acceptance receipt. This proves a run was accepted for the scoped
   * requester; it deliberately does not claim to be a terminal-status store.
   */
  acceptedTombstone?: OperatorSubagentAcceptedTombstone;
  /** "terminal" means the spawn transaction settled, not that the child run ended. */
  state: "prepared" | "terminal" | "outcome_unknown";
  result?: OperatorSpawnResult;
  createdAt: number;
  updatedAt: number;
};

type SpawnLedgerFile = {
  version: 1;
  entries: Record<string, SpawnLedgerEntry>;
};

type InflightEntry = {
  fingerprint: string;
  promise: Promise<OperatorSpawnResult>;
};

type SpawnClaim =
  | { kind: "existing"; result: OperatorSpawnResult }
  | { kind: "prepared"; preparedAt: number };

const inflight = new Map<string, InflightEntry>();
const LEDGER_LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 1.4,
    minTimeout: 10,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 30_000,
} as const;

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function stableFingerprint(value: Readonly<Record<string, unknown>>): string {
  return hash(JSON.stringify(canonicalize(value)));
}

function normalizeRequesterSessionKey(request: Readonly<Record<string, unknown>>): string {
  const value = request.requesterSessionKey;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("requesterSessionKey is required for durable operator spawn.");
  }
  return value.trim();
}

function requesterScopeHash(requesterSessionKey: string): string {
  return hash(`requester-session:${requesterSessionKey}`);
}

function ledgerPath(): string {
  return path.join(resolveStateDir(process.env), "subagents", "operator-spawn-ledger.json");
}

function loadLedger(): SpawnLedgerFile {
  const pathname = ledgerPath();
  if (!fs.existsSync(pathname)) {
    return { version: 1, entries: {} };
  }
  const raw = loadJsonFileThroughSymlink(pathname);
  if (!raw || typeof raw !== "object") {
    throw new Error("Operator subagent spawn ledger is unreadable; refusing to dispatch.");
  }
  const candidate = raw as Partial<SpawnLedgerFile>;
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
    throw new Error(
      "Operator subagent spawn ledger has an unsupported shape; refusing to dispatch.",
    );
  }
  for (const [key, entry] of Object.entries(candidate.entries)) {
    if (!isLedgerEntry(key, entry)) {
      throw new Error(
        "Operator subagent spawn ledger contains an invalid entry; refusing to dispatch.",
      );
    }
  }
  return { version: 1, entries: candidate.entries };
}

function isOperatorSpawnResult(value: unknown): value is OperatorSpawnResult {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return (
    status === "accepted" ||
    status === "forbidden" ||
    status === "error" ||
    status === "outcome_unknown" ||
    status === "idempotency_conflict"
  );
}

function isLedgerEntry(key: string, value: unknown): value is SpawnLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SpawnLedgerEntry>;
  const state = entry.state;
  const resultValid = entry.result === undefined || isOperatorSpawnResult(entry.result);
  const scopeHashValid =
    entry.requesterScopeHash === undefined || /^[a-f0-9]{64}$/.test(entry.requesterScopeHash);
  const tombstone = entry.acceptedTombstone;
  const tombstoneValid =
    tombstone === undefined ||
    (typeof tombstone === "object" &&
      typeof tombstone.runId === "string" &&
      tombstone.runId.trim().length > 0 &&
      typeof tombstone.childSessionKey === "string" &&
      tombstone.childSessionKey.trim().length > 0 &&
      typeof tombstone.acceptedAt === "number" &&
      Number.isFinite(tombstone.acceptedAt) &&
      entry.requesterScopeHash !== undefined &&
      entry.result?.status === "accepted" &&
      entry.result.runId === tombstone.runId &&
      entry.result.childSessionKey === tombstone.childSessionKey);
  return (
    /^[a-f0-9]{64}$/.test(key) &&
    entry.idempotencyHash === key &&
    typeof entry.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(entry.fingerprint) &&
    (state === "prepared" || state === "terminal" || state === "outcome_unknown") &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    scopeHashValid &&
    tombstoneValid &&
    resultValid &&
    (state === "prepared" || entry.result !== undefined)
  );
}

async function saveLedger(ledger: SpawnLedgerFile): Promise<void> {
  // Idempotency hashes are never silently evicted. Forgetting an old accepted
  // key would turn a later retry into a duplicate engine side effect. A future
  // retention policy must preserve tombstones or explicitly fail closed.
  await writeJsonAtomic(ledgerPath(), ledger, {
    mode: 0o600,
    ensureDirMode: 0o700,
    trailingNewline: true,
  });
}

async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  return await withFileLock(ledgerPath(), LEDGER_LOCK_OPTIONS, fn);
}

function unknownResult(error: string): OperatorSpawnResult {
  return { status: "outcome_unknown", error };
}

/**
 * Operator-plane spawn fence. The raw idempotency key and task are never
 * persisted. A prepared record is durable before the first engine side effect;
 * after a process crash it becomes outcome_unknown and is never auto-replayed.
 */
export async function runIdempotentOperatorSubagentSpawn(input: {
  idempotencyKey: string;
  request: Readonly<Record<string, unknown>>;
  spawn: () => Promise<SpawnSubagentResult>;
}): Promise<OperatorSpawnResult> {
  const normalizedRequesterSessionKey = normalizeRequesterSessionKey(input.request);
  const expectedRequesterScopeHash = requesterScopeHash(normalizedRequesterSessionKey);
  const idempotencyHash = hash(input.idempotencyKey);
  const fingerprint = stableFingerprint(input.request);
  const active = inflight.get(idempotencyHash);
  if (active) {
    if (active.fingerprint !== fingerprint) {
      return {
        status: "idempotency_conflict",
        error: "Idempotency key was already used with a different spawn request.",
      };
    }
    return active.promise;
  }

  const claim = await withLedgerLock(async (): Promise<SpawnClaim> => {
    const ledger = loadLedger();
    const existing = ledger.entries[idempotencyHash];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          kind: "existing",
          result: {
            status: "idempotency_conflict",
            error: "Idempotency key was already used with a different spawn request.",
          } satisfies OperatorSpawnResult,
        };
      }
      if (existing.state === "terminal" && existing.result) {
        if (
          existing.result.status === "accepted" &&
          (!existing.result.runId?.trim() || !existing.result.childSessionKey?.trim())
        ) {
          const result: OperatorSpawnResult = {
            ...existing.result,
            status: "outcome_unknown",
            error: "The prior accepted spawn has no exact run/session references.",
          };
          ledger.entries[idempotencyHash] = {
            ...existing,
            requesterScopeHash: expectedRequesterScopeHash,
            state: "outcome_unknown",
            result,
            updatedAt: Date.now(),
          };
          await saveLedger(ledger);
          return { kind: "existing", result };
        }
        if (
          existing.result.status === "accepted" &&
          existing.result.runId?.trim() &&
          existing.result.childSessionKey?.trim() &&
          !existing.acceptedTombstone
        ) {
          const acceptedAt = existing.updatedAt;
          ledger.entries[idempotencyHash] = {
            ...existing,
            requesterScopeHash: expectedRequesterScopeHash,
            acceptedTombstone: {
              runId: existing.result.runId,
              childSessionKey: existing.result.childSessionKey,
              acceptedAt,
            },
          };
          await saveLedger(ledger);
        }
        return { kind: "existing", result: existing.result };
      }
      if (existing.state === "prepared") {
        const result = unknownResult(
          "A prior spawn was prepared but its acceptance outcome is unknown; automatic replay is forbidden.",
        );
        ledger.entries[idempotencyHash] = {
          ...existing,
          state: "outcome_unknown",
          result,
          updatedAt: Date.now(),
        };
        await saveLedger(ledger);
        return { kind: "existing", result };
      }
      return {
        kind: "existing",
        result: existing.result ?? unknownResult("The prior spawn outcome is unknown."),
      };
    }

    const now = Date.now();
    ledger.entries[idempotencyHash] = {
      idempotencyHash,
      fingerprint,
      requesterScopeHash: expectedRequesterScopeHash,
      state: "prepared",
      createdAt: now,
      updatedAt: now,
    };
    await saveLedger(ledger);
    return { kind: "prepared", preparedAt: now };
  });
  if (claim.kind === "existing") {
    return claim.result;
  }
  const now = claim.preparedAt;

  const promise = (async (): Promise<OperatorSpawnResult> => {
    let result: OperatorSpawnResult;
    try {
      const spawned = await input.spawn();
      result =
        spawned.status === "accepted" &&
        (!spawned.runId?.trim() || !spawned.childSessionKey?.trim())
          ? {
              ...spawned,
              status: "outcome_unknown",
              error: "The engine accepted the child run without exact run/session references.",
            }
          : spawned.status === "error" && (spawned.runId || spawned.childSessionKey)
            ? {
                ...spawned,
                status: "outcome_unknown",
                error: spawned.error ?? "The engine may have accepted the child run.",
              }
            : spawned;
    } catch (error) {
      result = unknownResult(
        error instanceof Error ? error.message : "The spawn transport outcome is unknown.",
      );
    }
    await withLedgerLock(async () => {
      const latest = loadLedger();
      const prior = latest.entries[idempotencyHash];
      const settledAt = Date.now();
      const acceptedTombstone =
        result.status === "accepted" && result.runId && result.childSessionKey
          ? {
              runId: result.runId,
              childSessionKey: result.childSessionKey,
              acceptedAt: settledAt,
            }
          : undefined;
      latest.entries[idempotencyHash] = {
        idempotencyHash,
        fingerprint,
        requesterScopeHash: prior?.requesterScopeHash ?? expectedRequesterScopeHash,
        acceptedTombstone,
        state: result.status === "outcome_unknown" ? "outcome_unknown" : "terminal",
        result,
        createdAt: prior?.createdAt ?? now,
        updatedAt: settledAt,
      };
      await saveLedger(latest);
    });
    return result;
  })();
  inflight.set(idempotencyHash, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    inflight.delete(idempotencyHash);
  }
}

/**
 * Resolve an exact accepted-run tombstone without revealing runs accepted for
 * another requester. Missing registry/session state is handled by subagents.get;
 * this ledger only proves acceptance and scope ownership.
 */
export async function findOperatorSubagentAcceptedTombstone(input: {
  requesterSessionKey: string;
  runId: string;
}): Promise<OperatorSubagentAcceptedTombstone | undefined> {
  const expectedScopeHash = requesterScopeHash(input.requesterSessionKey.trim());
  const runId = input.runId.trim();
  if (!runId || !input.requesterSessionKey.trim()) {
    return undefined;
  }
  return await withLedgerLock(async () => {
    const ledger = loadLedger();
    for (const entry of Object.values(ledger.entries)) {
      if (
        entry.requesterScopeHash === expectedScopeHash &&
        entry.acceptedTombstone?.runId === runId
      ) {
        return { ...entry.acceptedTombstone };
      }
    }
    return undefined;
  });
}

export const OPERATOR_SUBAGENT_SPAWN_CAPABILITY = {
  schemaVersion: "openclaw-subagent-spawn-capability/v3",
  method: "subagents.spawn",
  durablePrepare: true,
  durableIdempotency: true,
  acceptedRunRef: true,
  statusQuery: true,
  typedTerminalStatus: true,
  exactStatusQuery: true,
  statusMethod: "subagents.get",
  statusDurability: "registry_with_accepted_tombstone_reconcile",
  restartRecovery: "outcome_unknown",
  acceptanceRetention: "no_silent_eviction",
  hiddenSystemContextAtSpawn: true,
  hiddenSystemContextReceipt: "sha256",
} as const;

export const __testing = {
  ledgerPath,
  async seedPrepared(input: {
    idempotencyKey: string;
    request: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const idempotencyHash = hash(input.idempotencyKey);
    const now = Date.now();
    await withLedgerLock(async () => {
      const ledger = loadLedger();
      ledger.entries[idempotencyHash] = {
        idempotencyHash,
        fingerprint: stableFingerprint(input.request),
        requesterScopeHash: requesterScopeHash(normalizeRequesterSessionKey(input.request)),
        state: "prepared",
        createdAt: now,
        updatedAt: now,
      };
      await saveLedger(ledger);
    });
  },
  resetInflight(): void {
    inflight.clear();
  },
};
