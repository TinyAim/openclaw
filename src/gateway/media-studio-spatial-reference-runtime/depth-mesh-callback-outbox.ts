/** Durable, receipt-only terminal callback outbox for depth-mesh Runtime jobs. */
import { createHash } from "node:crypto";
import { readDurableJsonFile } from "../../infra/json-files.js";
import { writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";

export type DepthMeshTerminalCallbackPayload = {
  kind: "media_studio.spatial_environment_depth_mesh.callback";
  workspaceId: string;
  runtimeId: string;
  taskId: string;
  materializationId: string;
  executionId: string;
  requestFingerprint: string;
  executionFingerprint: string;
  dispatchAttemptId: string;
  sequence: number;
  attempt: number;
  status: "succeeded" | "failed" | "cancelled";
  receipts?: readonly {
    slot: string;
    artifactId: string;
    mimeType: string;
    byteLength: number;
    sha256Hex: string;
  }[];
  errorCode?: string;
  errorMessage?: string;
};

export type DepthMeshCallbackOutboxEntry = {
  identity: string;
  payloadDigest: string;
  payload: DepthMeshTerminalCallbackPayload;
};

export interface DepthMeshCallbackOutbox {
  authority: "memory" | "file";
  enqueue(payload: DepthMeshTerminalCallbackPayload): Promise<DepthMeshCallbackOutboxEntry>;
  list(): Promise<readonly DepthMeshCallbackOutboxEntry[]>;
  remove(input: { identity: string; payloadDigest: string }): Promise<boolean>;
}

function identity(payload: DepthMeshTerminalCallbackPayload): string {
  return [
    payload.workspaceId,
    payload.runtimeId,
    payload.taskId,
    payload.materializationId,
    payload.executionId,
    payload.requestFingerprint,
    payload.executionFingerprint,
    payload.dispatchAttemptId,
    payload.sequence,
    payload.attempt,
  ].join("\n");
}

function digest(payload: DepthMeshTerminalCallbackPayload): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isEntry(value: unknown): value is DepthMeshCallbackOutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  if (
    typeof raw.identity !== "string" ||
    typeof raw.payloadDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(raw.payloadDigest) ||
    !payload ||
    payload.kind !== "media_studio.spatial_environment_depth_mesh.callback" ||
    (payload.status !== "succeeded" &&
      payload.status !== "failed" &&
      payload.status !== "cancelled") ||
    "grantToken" in payload ||
    "bytes" in payload ||
    "imageBase64" in payload
  )
    return false;
  const candidate = payload as DepthMeshTerminalCallbackPayload;
  return raw.identity === identity(candidate) && raw.payloadDigest === digest(candidate);
}

function addEntry(
  entries: readonly DepthMeshCallbackOutboxEntry[],
  payload: DepthMeshTerminalCallbackPayload,
): { entries: DepthMeshCallbackOutboxEntry[]; entry: DepthMeshCallbackOutboxEntry } {
  const entry = {
    identity: identity(payload),
    payloadDigest: digest(payload),
    payload: clone(payload),
  };
  const existing = entries.find((item) => item.identity === entry.identity);
  if (existing) {
    if (existing.payloadDigest !== entry.payloadDigest) {
      throw new Error("DEPTH_MESH_CALLBACK_OUTBOX_IDENTITY_CONFLICT");
    }
    return { entries: [...entries], entry: clone(existing) };
  }
  return { entries: [...entries, entry], entry: clone(entry) };
}

export function createInMemoryDepthMeshCallbackOutbox(): DepthMeshCallbackOutbox {
  let entries: DepthMeshCallbackOutboxEntry[] = [];
  return {
    authority: "memory",
    async enqueue(payload) {
      const added = addEntry(entries, payload);
      entries = added.entries;
      return added.entry;
    },
    async list() {
      return clone(entries);
    },
    async remove(input) {
      const before = entries.length;
      entries = entries.filter(
        (entry) => entry.identity !== input.identity || entry.payloadDigest !== input.payloadDigest,
      );
      return entries.length !== before;
    },
  };
}

export function createFileDepthMeshCallbackOutbox(input: {
  filePath: string;
}): DepthMeshCallbackOutbox {
  let chain = Promise.resolve() as Promise<unknown>;
  async function load(): Promise<DepthMeshCallbackOutboxEntry[]> {
    const raw = await readDurableJsonFile<unknown>(input.filePath);
    if (raw == null) return [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("DEPTH_MESH_CALLBACK_OUTBOX_INVALID");
    }
    const state = raw as { version?: unknown; entries?: unknown };
    if (state.version !== 1 || !Array.isArray(state.entries) || !state.entries.every(isEntry)) {
      throw new Error("DEPTH_MESH_CALLBACK_OUTBOX_INVALID");
    }
    return clone(state.entries);
  }
  function atomic<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  async function save(entries: readonly DepthMeshCallbackOutboxEntry[]): Promise<void> {
    await writeJsonFileAtomically(input.filePath, { version: 1, entries });
  }
  return {
    authority: "file",
    enqueue(payload) {
      return atomic(async () => {
        const added = addEntry(await load(), payload);
        await save(added.entries);
        return added.entry;
      });
    },
    list() {
      return atomic(load);
    },
    remove(input) {
      return atomic(async () => {
        const entries = await load();
        const next = entries.filter(
          (entry) =>
            entry.identity !== input.identity || entry.payloadDigest !== input.payloadDigest,
        );
        if (next.length === entries.length) return false;
        await save(next);
        return true;
      });
    },
  };
}
