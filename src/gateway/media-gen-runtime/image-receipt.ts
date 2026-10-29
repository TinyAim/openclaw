import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import {
  FILE_LOCK_STALE_ERROR_CODE,
  reclaimDefinitelyStaleFileLock,
} from "../../plugin-sdk/file-lock.js";
import { isRecord } from "../media-gen-runtime-dispatch.js";
import type {
  MediaGenRuntimeArtifactRef,
  MediaGenRuntimeImageLifecycleReceiptV1,
} from "./types.js";

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
function token(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

/** Closed vendored wire parser; the contracts drift tests consume this exact output. */
export function parseImageLifecycleReceipt(
  raw: unknown,
): MediaGenRuntimeImageLifecycleReceiptV1 | undefined {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some(
      (key) =>
        ![
          "schemaVersion",
          "executionAttempt",
          "frozenPlanDigest",
          "submissionCorrelationId",
          "observedAt",
          "sequence",
          "providerOutcome",
          "retryDisposition",
        ].includes(key),
    ) ||
    raw.schemaVersion !== 1 ||
    !Number.isSafeInteger(raw.executionAttempt) ||
    (raw.executionAttempt as number) < 1 ||
    typeof raw.frozenPlanDigest !== "string" ||
    !SHA256.test(raw.frozenPlanDigest) ||
    !token(raw.submissionCorrelationId) ||
    typeof raw.observedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.observedAt)) ||
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 1 ||
    !["unknown", "processing", "succeeded", "failed", "canceled", "not_submitted"].includes(
      String(raw.providerOutcome),
    ) ||
    (raw.retryDisposition !== undefined &&
      !["replacement_allowed", "reconcile_only"].includes(String(raw.retryDisposition))) ||
    (raw.retryDisposition !== undefined &&
      raw.providerOutcome !== "failed" &&
      raw.providerOutcome !== "not_submitted")
  )
    return undefined;
  return raw as unknown as MediaGenRuntimeImageLifecycleReceiptV1;
}

export type ImageReceipt = {
  schemaVersion: 1;
  runtimeId: string;
  taskId: string;
  workspaceId: string;
  presetId: string;
  executionAttempt: number;
  frozenPlanDigest: string;
  runtimeJobId: string;
  // Optional only for historical rows; never backfilled from a read request.
  submissionCorrelationId?: string;
  observedAt?: string;
  sequence?: number;
  providerOutcome?: MediaGenRuntimeImageLifecycleReceiptV1["providerOutcome"];
  retryDisposition?: MediaGenRuntimeImageLifecycleReceiptV1["retryDisposition"];
  providerDispatchStarted?: true;
  stopRequested?: true;
  handoffStarted?: true;
  state: "started" | "succeeded" | "failed" | "canceled";
  bytesBase64?: string;
  mimeType?: string;
  sha256?: string;
  artifact?: MediaGenRuntimeArtifactRef;
  snapshot?: {
    executionOwner: "user_runtime";
    moderationStatus: "not_enforced" | "runtime_enforced";
    labelingStatus: "absent" | "runtime_applied";
    registrationDisclosureStatus: "undeclared" | "operator_self_declared";
    capturedAt: string;
  };
  failureMessage?: string;
};

export function parseImageReceipt(raw: unknown): ImageReceipt | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = new Set([
    "schemaVersion",
    "runtimeId",
    "taskId",
    "workspaceId",
    "presetId",
    "executionAttempt",
    "frozenPlanDigest",
    "runtimeJobId",
    "state",
    "submissionCorrelationId",
    "observedAt",
    "sequence",
    "providerOutcome",
    "retryDisposition",
    "providerDispatchStarted",
    "stopRequested",
    "handoffStarted",
    "bytesBase64",
    "mimeType",
    "sha256",
    "artifact",
    "snapshot",
    "failureMessage",
  ]);
  if (Object.keys(raw).some((key) => !keys.has(key))) return undefined;
  if (
    raw.schemaVersion !== 1 ||
    token(raw.runtimeId) === undefined ||
    token(raw.taskId) === undefined ||
    token(raw.workspaceId) === undefined ||
    token(raw.presetId) === undefined ||
    typeof raw.executionAttempt !== "number" ||
    !Number.isSafeInteger(raw.executionAttempt) ||
    raw.executionAttempt < 1 ||
    !SHA256.test(String(raw.frozenPlanDigest)) ||
    token(raw.runtimeJobId) === undefined ||
    !["started", "succeeded", "failed", "canceled"].includes(String(raw.state))
  )
    return undefined;
  if (
    raw.bytesBase64 !== undefined &&
    (typeof raw.bytesBase64 !== "string" ||
      raw.bytesBase64.length === 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(raw.bytesBase64))
  )
    return undefined;
  if (
    raw.mimeType !== undefined &&
    (typeof raw.mimeType !== "string" || !/^image\/(?:png|jpeg|webp)$/u.test(raw.mimeType))
  )
    return undefined;
  if (
    raw.sha256 !== undefined &&
    (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256))
  )
    return undefined;
  if (raw.artifact !== undefined) {
    if (!isRecord(raw.artifact)) return undefined;
    const artifactKeys = new Set(["artifactId", "sha256", "durationSec", "resolution", "mimeType"]);
    if (
      Object.keys(raw.artifact).some((key) => !artifactKeys.has(key)) ||
      token(raw.artifact.artifactId) === undefined ||
      typeof raw.artifact.mimeType !== "string" ||
      !/^image\/(?:png|jpeg|webp)$/u.test(raw.artifact.mimeType) ||
      typeof raw.artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.artifact.sha256) ||
      raw.artifact.sha256 !== raw.sha256
    )
      return undefined;
  }
  if (raw.snapshot !== undefined) {
    if (
      !isRecord(raw.snapshot) ||
      Object.keys(raw.snapshot).some(
        (key) =>
          !new Set([
            "executionOwner",
            "moderationStatus",
            "labelingStatus",
            "registrationDisclosureStatus",
            "capturedAt",
          ]).has(key),
      ) ||
      raw.snapshot.executionOwner !== "user_runtime" ||
      (raw.snapshot.moderationStatus !== "not_enforced" &&
        raw.snapshot.moderationStatus !== "runtime_enforced") ||
      (raw.snapshot.labelingStatus !== "absent" &&
        raw.snapshot.labelingStatus !== "runtime_applied") ||
      (raw.snapshot.registrationDisclosureStatus !== "undeclared" &&
        raw.snapshot.registrationDisclosureStatus !== "operator_self_declared") ||
      typeof raw.snapshot.capturedAt !== "string" ||
      Number.isNaN(Date.parse(raw.snapshot.capturedAt))
    )
      return undefined;
  }
  if (
    raw.state === "succeeded" &&
    (typeof raw.bytesBase64 !== "string" ||
      typeof raw.mimeType !== "string" ||
      typeof raw.sha256 !== "string" ||
      !raw.snapshot ||
      createHash("sha256").update(Buffer.from(raw.bytesBase64, "base64")).digest("hex") !==
        raw.sha256)
  )
    return undefined;
  if (
    raw.failureMessage !== undefined &&
    (typeof raw.failureMessage !== "string" ||
      raw.failureMessage.length === 0 ||
      raw.failureMessage.length > 2000)
  )
    return undefined;
  for (const flag of ["providerDispatchStarted", "stopRequested", "handoffStarted"]) {
    if (raw[flag] !== undefined && raw[flag] !== true) return undefined;
  }
  const lifecycleFields = [
    "submissionCorrelationId",
    "observedAt",
    "sequence",
    "providerOutcome",
    "retryDisposition",
  ];
  if (lifecycleFields.some((key) => raw[key] !== undefined)) {
    const lifecycle = parseImageLifecycleReceipt({
      schemaVersion: 1,
      executionAttempt: raw.executionAttempt,
      frozenPlanDigest: raw.frozenPlanDigest,
      submissionCorrelationId: raw.submissionCorrelationId,
      observedAt: raw.observedAt,
      sequence: raw.sequence,
      providerOutcome: raw.providerOutcome,
      ...(raw.retryDisposition !== undefined ? { retryDisposition: raw.retryDisposition } : {}),
    });
    if (
      !lifecycle ||
      (raw.state === "started" && !["unknown", "processing"].includes(lifecycle.providerOutcome)) ||
      (raw.state === "succeeded" && lifecycle.providerOutcome !== "succeeded") ||
      (raw.state === "failed" &&
        !["failed", "not_submitted"].includes(lifecycle.providerOutcome)) ||
      (raw.state === "canceled" && lifecycle.providerOutcome !== "canceled") ||
      (raw.artifact !== undefined && raw.state !== "succeeded") ||
      (raw.handoffStarted && raw.state !== "succeeded") ||
      (lifecycle.providerOutcome === "not_submitted" &&
        ["bytesBase64", "mimeType", "sha256", "artifact", "snapshot"].some(
          (key) => raw[key] !== undefined,
        ))
    )
      return undefined;
  }
  return raw as unknown as ImageReceipt;
}

export function imageLifecycleReceipt(
  record: ImageReceipt,
): MediaGenRuntimeImageLifecycleReceiptV1 | undefined {
  return parseImageLifecycleReceipt({
    schemaVersion: 1,
    executionAttempt: record.executionAttempt,
    frozenPlanDigest: record.frozenPlanDigest,
    submissionCorrelationId: record.submissionCorrelationId,
    observedAt: new Date().toISOString(),
    sequence: record.sequence,
    providerOutcome: record.providerOutcome,
    ...(record.retryDisposition !== undefined ? { retryDisposition: record.retryDisposition } : {}),
  });
}

type ReceiptIdentity = Pick<
  ImageReceipt,
  "workspaceId" | "taskId" | "executionAttempt" | "frozenPlanDigest" | "presetId"
>;
const constructedReceiptStores = new WeakSet<object>();
export function isConstructedImageReceiptStore(value: unknown): boolean {
  return !!value && typeof value === "object" && constructedReceiptStores.has(value);
}
function receiptKey(input: ReceiptIdentity): string {
  return createHash("sha256")
    .update(
      `${input.workspaceId}\u0000${input.taskId}\u0000${input.executionAttempt}\u0000${input.frozenPlanDigest}`,
    )
    .digest("hex");
}

/** The original Image receipt directory remains the only Native attempt journal. */
export function createImageReceiptStore(options: { env: NodeJS.ProcessEnv; runtimeId: string }) {
  const dir = path.join(resolveStateDir(options.env), "media-gen-image-receipts-v1");
  const fileFor = (input: ReceiptIdentity) => path.join(dir, `${receiptKey(input)}.json`);
  async function read(input: ReceiptIdentity): Promise<ImageReceipt | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(fileFor(input), "utf8"));
      const record = parseImageReceipt(raw);
      if (
        !record ||
        record.runtimeId !== options.runtimeId ||
        record.workspaceId !== input.workspaceId ||
        record.taskId !== input.taskId ||
        record.presetId !== input.presetId ||
        record.executionAttempt !== input.executionAttempt ||
        record.frozenPlanDigest !== input.frozenPlanDigest
      ) {
        throw new Error("media_image_runtime_receipt_identity_or_schema_invalid");
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("media_image_runtime_receipt_corrupt");
    }
  }
  async function writeAtomic(record: ImageReceipt): Promise<void> {
    const target = fileFor(record);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, target);
      const directory = await fs.open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  async function transact<T>(
    input: ReceiptIdentity,
    action: (
      current: ImageReceipt | undefined,
      commit: (next: ImageReceipt) => Promise<ImageReceipt>,
    ) => Promise<T>,
  ): Promise<T> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Age alone never grants recovery. The ordinary lock fails closed, then
    // the shared reclaim primitive rechecks a definitely dead owner's exact
    // file identity and payload before a single acquisition retry.
    const locked = () =>
      withFileLock(
        fileFor(input),
        {
          stale: 30_000,
          staleRecovery: "fail-closed",
          retries: { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
        },
        async () => {
          let current = await read(input);
          const commit = async (candidate: ImageReceipt): Promise<ImageReceipt> => {
            if (current && JSON.stringify(current) === JSON.stringify(candidate)) return current;
            if (current) {
              const fixed = [
                "runtimeId",
                "workspaceId",
                "taskId",
                "presetId",
                "executionAttempt",
                "frozenPlanDigest",
                "runtimeJobId",
                "submissionCorrelationId",
              ] as const;
              if (
                fixed.some((key) => current![key] !== candidate[key]) ||
                (current.state !== candidate.state &&
                  (current.state !== "started" ||
                    !["succeeded", "failed"].includes(candidate.state))) ||
                (current.stopRequested && !candidate.stopRequested) ||
                (current.providerDispatchStarted && !candidate.providerDispatchStarted) ||
                (current.handoffStarted && !candidate.handoffStarted) ||
                (current.artifact &&
                  JSON.stringify(current.artifact) !== JSON.stringify(candidate.artifact)) ||
                (current.providerOutcome &&
                  !["unknown", "processing"].includes(current.providerOutcome) &&
                  current.providerOutcome !== candidate.providerOutcome) ||
                (current.state !== "started" &&
                  (
                    [
                      "bytesBase64",
                      "mimeType",
                      "sha256",
                      "snapshot",
                      "failureMessage",
                      "retryDisposition",
                    ] as const
                  ).some((key) => JSON.stringify(current![key]) !== JSON.stringify(candidate[key])))
              ) {
                throw new Error("media_image_runtime_receipt_cas_conflict");
              }
            }
            const next =
              current?.sequence !== undefined
                ? {
                    ...candidate,
                    sequence: current.sequence + 1,
                    observedAt: new Date().toISOString(),
                  }
                : candidate;
            if (
              !parseImageReceipt(next) ||
              (current && next.sequence !== undefined && !Number.isSafeInteger(next.sequence))
            ) {
              throw new Error("media_image_runtime_receipt_schema_invalid");
            }
            await writeAtomic(next);
            current = next;
            return next;
          };
          return action(current, commit);
        },
      );
    try {
      return await locked();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_LOCK_STALE_ERROR_CODE) throw error;
      const reclaimed = await reclaimDefinitelyStaleFileLock(`${fileFor(input)}.lock`);
      if (reclaimed === "retained") throw error;
      return locked();
    }
  }
  const store = {
    read,
    transact,
    reserve: (record: ImageReceipt) =>
      transact(record, async (existing, commit) =>
        existing
          ? { created: false, record: existing }
          : { created: true, record: await commit(record) },
      ),
    update: (input: ReceiptIdentity, edit: (current: ImageReceipt) => ImageReceipt) =>
      transact(input, async (current, commit) => (current ? commit(edit(current)) : undefined)),
  };
  constructedReceiptStores.add(store);
  return store;
}
