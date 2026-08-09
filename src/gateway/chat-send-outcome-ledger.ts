import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import { loadJsonFile } from "../infra/json-file.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import {
  sanitizeDurableChatTerminal,
  type DurableChatTerminalInput,
} from "./chat-send-outcome-ledger-sanitize.js";

export type { DurableChatTerminalInput } from "./chat-send-outcome-ledger-sanitize.js";

const LEDGER_VERSION = 1 as const;
const MAX_LEDGER_ENTRIES = 10_000;
const LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 1.4,
    minTimeout: 10,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 30_000,
} as const;

type DurableChatTerminal = {
  ok: boolean;
  payload: Record<string, unknown>;
  errorMessage?: string;
};

type DurableChatOutcomeEntry = {
  idempotencyHash: string;
  fingerprint: string;
  state: "prepared" | "terminal" | "outcome_unknown";
  requestStartedAt?: number;
  terminal?: DurableChatTerminal;
  createdAt: number;
  updatedAt: number;
};

type DurableChatOutcomeFile = {
  version: typeof LEDGER_VERSION;
  entries: Record<string, DurableChatOutcomeEntry>;
};

export type DurableChatOutcomeClaim =
  | { kind: "disabled" }
  | { kind: "dispatch"; fingerprint: string }
  | { kind: "in_flight"; payload: { runId: string; status: "in_flight" } }
  | { kind: "terminal"; terminal: DurableChatTerminal }
  | {
      kind: "outcome_unknown";
      payload: {
        runId: string;
        status: "outcome_unknown";
        errorCode: "gateway_restart_outcome_unknown";
      };
    }
  | {
      kind: "idempotency_conflict";
      payload: {
        runId: string;
        status: "idempotency_conflict";
        errorCode: "idempotency_key_reused";
      };
    };

const activeRuns = new Map<string, { fingerprint: string; runId: string }>();
const localOutcomeUnknown = new Map<string, { fingerprint: string; runId: string }>();
const localLocks = new Map<string, Promise<void>>();

function sha256(value: string): string {
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

function requestFingerprint(request: Readonly<Record<string, unknown>>): string {
  return sha256(JSON.stringify(canonicalize(request)));
}

function ledgerPath(): string {
  return path.join(resolveStateDir(process.env), "gateway", "chat-send-outcomes.json");
}

function emptyLedger(): DurableChatOutcomeFile {
  return { version: LEDGER_VERSION, entries: {} };
}

function isTerminal(value: unknown): value is DurableChatTerminal {
  if (!value || typeof value !== "object") return false;
  const terminal = value as Partial<DurableChatTerminal>;
  return (
    typeof terminal.ok === "boolean" &&
    Boolean(terminal.payload) &&
    typeof terminal.payload === "object" &&
    (terminal.errorMessage === undefined || typeof terminal.errorMessage === "string")
  );
}

function isEntry(key: string, value: unknown): value is DurableChatOutcomeEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DurableChatOutcomeEntry>;
  return (
    /^[a-f0-9]{64}$/.test(key) &&
    entry.idempotencyHash === key &&
    typeof entry.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(entry.fingerprint) &&
    (entry.state === "prepared" ||
      entry.state === "terminal" ||
      entry.state === "outcome_unknown") &&
    (entry.requestStartedAt === undefined ||
      (typeof entry.requestStartedAt === "number" && Number.isFinite(entry.requestStartedAt))) &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    (entry.terminal === undefined || isTerminal(entry.terminal)) &&
    (entry.state !== "terminal" || isTerminal(entry.terminal))
  );
}

function loadLedger(): DurableChatOutcomeFile {
  const pathname = ledgerPath();
  if (!fs.existsSync(pathname)) {
    return emptyLedger();
  }
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    throw new Error("Durable chat outcome ledger is unreadable; refusing to dispatch.");
  }
  const candidate = raw as Partial<DurableChatOutcomeFile>;
  if (candidate.version !== LEDGER_VERSION || !candidate.entries) {
    throw new Error("Durable chat outcome ledger has an unsupported shape; refusing to dispatch.");
  }
  for (const [key, entry] of Object.entries(candidate.entries)) {
    if (!isEntry(key, entry)) {
      throw new Error(
        "Durable chat outcome ledger contains an invalid entry; refusing to dispatch.",
      );
    }
  }
  return { version: LEDGER_VERSION, entries: candidate.entries };
}

async function saveLedger(ledger: DurableChatOutcomeFile): Promise<void> {
  // Never silently evict a key. Payload compaction may be added later, but a
  // tombstone must remain or an old retry could create a second provider run.
  const pathname = ledgerPath();
  const directory = path.dirname(pathname);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  await writeJsonAtomic(pathname, ledger, {
    mode: 0o600,
    trailingNewline: true,
  });
}

async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  return await withFileLock(ledgerPath(), LOCK_OPTIONS, fn);
}

async function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  localLocks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (localLocks.get(key) === current) {
      localLocks.delete(key);
    }
  }
}

function unknownPayload(runId: string) {
  return {
    runId,
    status: "outcome_unknown" as const,
    errorCode: "gateway_restart_outcome_unknown" as const,
  };
}

function conflictPayload(runId: string) {
  return {
    runId,
    status: "idempotency_conflict" as const,
    errorCode: "idempotency_key_reused" as const,
  };
}

export async function claimDurableChatOutcome(input: {
  idempotencyKey: string;
  request: Readonly<Record<string, unknown>>;
  durableOutcome: boolean;
}): Promise<DurableChatOutcomeClaim> {
  // Opt-out must preserve the pre-existing process-local chat.send behavior.
  // In particular, it must not let a corrupt or conflicting durable ledger
  // break ordinary interactive chat traffic.
  if (!input.durableOutcome) {
    return { kind: "disabled" };
  }
  const runId = input.idempotencyKey.trim();
  const idempotencyHash = sha256(runId);
  const fingerprint = requestFingerprint(input.request);

  return await withLocalLock(idempotencyHash, async () => {
    const uncertain = localOutcomeUnknown.get(idempotencyHash);
    if (uncertain) {
      return uncertain.fingerprint === fingerprint
        ? { kind: "outcome_unknown", payload: unknownPayload(runId) }
        : { kind: "idempotency_conflict", payload: conflictPayload(runId) };
    }
    const active = activeRuns.get(idempotencyHash);
    if (active) {
      return active.fingerprint === fingerprint
        ? { kind: "in_flight", payload: { runId, status: "in_flight" } }
        : { kind: "idempotency_conflict", payload: conflictPayload(runId) };
    }

    const claim = await withLedgerLock(async (): Promise<DurableChatOutcomeClaim> => {
      const ledger = loadLedger();
      const existing = ledger.entries[idempotencyHash];
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return { kind: "idempotency_conflict", payload: conflictPayload(runId) };
        }
        if (existing.state === "terminal" && existing.terminal) {
          return {
            kind: "terminal",
            terminal: {
              ...existing.terminal,
              payload: { ...existing.terminal.payload, runId },
            },
          };
        }
        if (existing.state === "outcome_unknown") {
          return { kind: "outcome_unknown", payload: unknownPayload(runId) };
        }
        // A prepared record may belong to another gateway process in the tiny
        // window between prepare and mark-started. Never grant a second
        // dispatcher merely because this process cannot see its in-memory
        // owner. Conservatively freeze it as unknown across processes/restarts.
        const now = Date.now();
        ledger.entries[idempotencyHash] = {
          ...existing,
          state: "outcome_unknown",
          updatedAt: now,
        };
        await saveLedger(ledger);
        return { kind: "outcome_unknown", payload: unknownPayload(runId) };
      }
      const now = Date.now();
      if (Object.keys(ledger.entries).length >= MAX_LEDGER_ENTRIES) {
        throw new Error("Durable chat outcome ledger is full; refusing a new dispatch.");
      }
      ledger.entries[idempotencyHash] = {
        idempotencyHash,
        fingerprint,
        state: "prepared",
        createdAt: now,
        updatedAt: now,
      };
      await saveLedger(ledger);
      return { kind: "dispatch", fingerprint };
    });
    if (claim.kind === "dispatch") {
      activeRuns.set(idempotencyHash, { fingerprint, runId });
    }
    return claim;
  });
}

export async function releaseDurableChatOutcomeBeforeStart(input: {
  idempotencyKey: string;
  fingerprint: string;
}): Promise<boolean> {
  const runId = input.idempotencyKey.trim();
  const idempotencyHash = sha256(runId);
  return await withLocalLock(idempotencyHash, async () => {
    const active = activeRuns.get(idempotencyHash);
    if (!active || active.fingerprint !== input.fingerprint) return false;
    const removed = await withLedgerLock(async () => {
      const ledger = loadLedger();
      const entry = ledger.entries[idempotencyHash];
      if (
        !entry ||
        entry.fingerprint !== input.fingerprint ||
        entry.state !== "prepared" ||
        entry.requestStartedAt !== undefined
      ) {
        return false;
      }
      delete ledger.entries[idempotencyHash];
      await saveLedger(ledger);
      return true;
    });
    if (removed) {
      activeRuns.delete(idempotencyHash);
      localOutcomeUnknown.delete(idempotencyHash);
    }
    return removed;
  });
}

export async function markDurableChatRequestStarted(input: {
  idempotencyKey: string;
  fingerprint: string;
}): Promise<void> {
  const runId = input.idempotencyKey.trim();
  const idempotencyHash = sha256(runId);
  await withLocalLock(idempotencyHash, async () => {
    const active = activeRuns.get(idempotencyHash);
    if (!active || active.fingerprint !== input.fingerprint) {
      throw new Error("Durable chat outcome claim is not active; refusing to dispatch.");
    }
    await withLedgerLock(async () => {
      const ledger = loadLedger();
      const entry = ledger.entries[idempotencyHash];
      if (!entry || entry.fingerprint !== input.fingerprint || entry.state !== "prepared") {
        throw new Error(
          "Durable chat outcome prepare record is unavailable; refusing to dispatch.",
        );
      }
      const now = Date.now();
      ledger.entries[idempotencyHash] = {
        ...entry,
        requestStartedAt: entry.requestStartedAt ?? now,
        updatedAt: now,
      };
      await saveLedger(ledger);
    });
  }).catch((error) => {
    activeRuns.delete(idempotencyHash);
    throw error;
  });
}

export function isDurableChatOutcomeActive(runId: string): boolean {
  return activeRuns.has(sha256(runId.trim()));
}

export async function settleDurableChatOutcome(input: {
  runId: string;
  terminal: DurableChatTerminalInput;
}): Promise<boolean> {
  const runId = input.runId.trim();
  const idempotencyHash = sha256(runId);
  if (!activeRuns.has(idempotencyHash)) return false;

  try {
    return await withLocalLock(idempotencyHash, async () => {
      const active = activeRuns.get(idempotencyHash);
      if (!active) return false;
      await withLedgerLock(async () => {
        const ledger = loadLedger();
        const entry = ledger.entries[idempotencyHash];
        if (
          !entry ||
          entry.fingerprint !== active.fingerprint ||
          (entry.state !== "prepared" && entry.state !== "outcome_unknown")
        ) {
          throw new Error(
            "Durable chat outcome entry is unavailable; refusing terminal overwrite.",
          );
        }
        const now = Date.now();
        ledger.entries[idempotencyHash] = {
          ...entry,
          state: "terminal",
          terminal: sanitizeDurableChatTerminal(input.terminal),
          updatedAt: now,
        };
        await saveLedger(ledger);
      });
      activeRuns.delete(idempotencyHash);
      localOutcomeUnknown.delete(idempotencyHash);
      return true;
    });
  } catch (error) {
    const active = activeRuns.get(idempotencyHash);
    if (active) localOutcomeUnknown.set(idempotencyHash, active);
    activeRuns.delete(idempotencyHash);
    throw error;
  }
}

export const __testing = {
  ledgerPath,
  maxEntries: MAX_LEDGER_ENTRIES,
  resetMemory(): void {
    activeRuns.clear();
    localOutcomeUnknown.clear();
    localLocks.clear();
  },
};
