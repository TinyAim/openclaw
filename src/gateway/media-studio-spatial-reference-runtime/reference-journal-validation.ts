import type { SpatialReferenceRelayDispatchAck } from "../media-studio-spatial-reference-render-http.js";
import type { SpatialReferenceTerminalCallback } from "./reference-callback.js";
import type {
  SpatialReferenceJournalAcceptInput,
  SpatialReferenceJournalClaimContext,
} from "./reference-journal-contract.js";
import {
  canonicalJson,
  outputKey,
  sameIdentity,
  sameOwner,
  SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
  type SpatialReferenceExpectedOutput,
  type SpatialReferenceFinalizedOutput,
  type SpatialReferenceJournalIdentity,
  type SpatialReferenceJournalOwner,
  type SpatialReferenceJournalRow,
  type SpatialReferenceJournalStoredValue,
  type SpatialReferenceJournalWorker,
  type SpatialReferencePreparedOutput,
} from "./reference-journal-record.js";

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function fail(code: string): never {
  throw new Error(`SPATIAL_REFERENCE_${code}`);
}

function assertText(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !value) fail(code);
}

function assertSafeInteger(value: unknown, code: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
}

export function assertIdentity(identity: SpatialReferenceJournalIdentity): void {
  const text = [
    identity.key,
    identity.runtimeId,
    identity.runtimeIdempotencyKey,
    identity.executionId,
    identity.workspaceId,
    identity.taskId,
    identity.materializationId,
    identity.dispatchAttemptId,
    identity.intentFingerprint,
    identity.executionFingerprint,
    identity.blueprintDigest,
    identity.rendererBuildDigest,
    identity.frozenDispatchDigest,
  ];
  if (
    text.some((value) => !value) ||
    identity.key !== identity.runtimeIdempotencyKey ||
    !Number.isSafeInteger(identity.sequence) ||
    !Number.isSafeInteger(identity.attempt)
  ) {
    fail("JOURNAL_IDENTITY_INVALID");
  }
}

export function assertOwner(owner: SpatialReferenceJournalOwner): void {
  assertText(owner.epoch, "JOURNAL_OWNER_INVALID");
  assertText(owner.ownerInstanceId, "JOURNAL_OWNER_INVALID");
  assertSafeInteger(owner.pid, "JOURNAL_OWNER_INVALID");
  assertSafeInteger(owner.pidStartTimeMs, "JOURNAL_OWNER_INVALID");
}

export function assertExpectedOutputs(outputs: readonly SpatialReferenceExpectedOutput[]): void {
  const keys = new Set<string>();
  for (const output of outputs) {
    assertText(output.slot, "JOURNAL_EXPECTED_OUTPUT_INVALID");
    assertText(output.artifactId, "JOURNAL_EXPECTED_OUTPUT_INVALID");
    assertSafeInteger(output.ordinal, "JOURNAL_EXPECTED_OUTPUT_INVALID");
    if (output.expectedMimeType !== "image/png" && output.expectedMimeType !== "video/mp4")
      fail("JOURNAL_EXPECTED_OUTPUT_INVALID");
    if (output.sourceTimeMs !== undefined)
      assertSafeInteger(output.sourceTimeMs, "JOURNAL_EXPECTED_OUTPUT_INVALID");
    const key = outputKey(output);
    if (keys.has(key)) fail("JOURNAL_EXPECTED_OUTPUT_DUPLICATE");
    keys.add(key);
  }
}

function expectedFor(
  row: SpatialReferenceJournalRow,
  output: Pick<SpatialReferencePreparedOutput, "slot" | "ordinal">,
): SpatialReferenceExpectedOutput {
  const expected = row.expectedOutputs?.find((item) => outputKey(item) === outputKey(output));
  if (!expected) fail("JOURNAL_OUTPUT_UNEXPECTED");
  return expected;
}

export function withoutStorageKey(
  output: SpatialReferenceFinalizedOutput,
): SpatialReferencePreparedOutput {
  const { storageKey: _storageKey, ...prepared } = output;
  return prepared;
}

export function assertPreparedOutput(
  row: SpatialReferenceJournalRow,
  output: SpatialReferencePreparedOutput,
): void {
  const expected = expectedFor(row, output);
  if (
    output.artifactId !== expected.artifactId ||
    output.mimeType !== expected.expectedMimeType ||
    !Number.isSafeInteger(output.size) ||
    output.size < 0 ||
    !/^[a-f0-9]{64}$/iu.test(output.sha256Hex) ||
    "storageKey" in output
  )
    fail("JOURNAL_PREPARED_OUTPUT_INVALID");
}

function assertFinalizedOutput(
  row: SpatialReferenceJournalRow,
  output: SpatialReferenceFinalizedOutput,
  requirePrepared: boolean,
): void {
  assertPreparedOutput(row, withoutStorageKey(output));
  assertText(output.storageKey, "JOURNAL_FINALIZED_OUTPUT_INVALID");
  if (!requirePrepared) return;
  const prepared = row.prepared?.outputs.find((item) => outputKey(item) === outputKey(output));
  if (!prepared || canonicalJson(prepared) !== canonicalJson(withoutStorageKey(output)))
    fail("JOURNAL_FINALIZED_OUTPUT_UNPREPARED");
}

export function appendFinalized(
  row: SpatialReferenceJournalRow,
  outputs: readonly SpatialReferenceFinalizedOutput[],
  requirePrepared = true,
): void {
  const merged = new Map((row.knownFinalizedReceipts ?? []).map((item) => [outputKey(item), item]));
  for (const output of outputs) {
    assertFinalizedOutput(row, output, requirePrepared);
    const previous = merged.get(outputKey(output));
    if (previous && canonicalJson(previous) !== canonicalJson(output))
      fail("JOURNAL_OUTPUT_CONFLICT");
    merged.set(outputKey(output), clone(output));
  }
  row.knownFinalizedReceipts = [...merged.values()];
}

export function allOutputsFinalized(row: SpatialReferenceJournalRow): boolean {
  const outputs = row.knownFinalizedReceipts ?? [];
  return (row.expectedOutputs ?? []).every((expected) =>
    outputs.some((output) => outputKey(output) === outputKey(expected)),
  );
}

export function missingOutputs(row: SpatialReferenceJournalRow): SpatialReferenceExpectedOutput[] {
  const finalized = new Set((row.knownFinalizedReceipts ?? []).map(outputKey));
  return (row.expectedOutputs ?? []).filter((output) => !finalized.has(outputKey(output)));
}

export function sameAck(
  left: SpatialReferenceRelayDispatchAck,
  right: SpatialReferenceRelayDispatchAck,
): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.executionId === right.executionId &&
    left.taskId === right.taskId &&
    left.materializationId === right.materializationId &&
    left.attempt === right.attempt &&
    left.dispatchAttemptId === right.dispatchAttemptId &&
    left.sequence === right.sequence &&
    left.intentFingerprint === right.intentFingerprint &&
    left.executionFingerprint === right.executionFingerprint &&
    left.blueprintDigest === right.blueprintDigest
  );
}

export function assertAck(
  identity: SpatialReferenceJournalIdentity,
  ack: SpatialReferenceRelayDispatchAck,
): void {
  if (
    ack.runtimeId !== identity.runtimeId ||
    ack.executionId !== identity.executionId ||
    ack.taskId !== identity.taskId ||
    ack.materializationId !== identity.materializationId ||
    ack.attempt !== identity.attempt ||
    ack.dispatchAttemptId !== identity.dispatchAttemptId ||
    ack.sequence !== identity.sequence ||
    ack.intentFingerprint !== identity.intentFingerprint ||
    ack.executionFingerprint !== identity.executionFingerprint ||
    ack.blueprintDigest !== identity.blueprintDigest
  ) {
    fail("JOURNAL_RECEIPT_IDENTITY_CONFLICT");
  }
}

export function createAcceptedRow(
  input: SpatialReferenceJournalAcceptInput,
): SpatialReferenceJournalRow {
  return {
    recordType: "execution",
    schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
    key: input.identity.key,
    dispatchAttemptId: input.identity.dispatchAttemptId,
    cancelled: false,
    phase: "accepted",
    acceptedAtMs: Date.now(),
    requestDigest: input.requestDigest,
    ack: clone(input.ack),
    identity: clone(input.identity),
    expectedOutputs: clone([...input.expectedOutputs]),
    knownFinalizedReceipts: clone([...(input.knownFinalizedReceipts ?? [])]),
  };
}

export function isExecution(
  value: SpatialReferenceJournalStoredValue | undefined,
): value is SpatialReferenceJournalRow {
  return value?.recordType === "execution";
}

export function asExecution(
  value: SpatialReferenceJournalStoredValue | undefined,
): SpatialReferenceJournalRow | undefined {
  if (value === undefined) return undefined;
  if (
    !isExecution(value) ||
    (value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION)
  )
    fail("JOURNAL_INVALID");
  return clone(value);
}

export function assertClaim(
  row: SpatialReferenceJournalRow,
  context: SpatialReferenceJournalClaimContext,
): void {
  if (
    !row.identity ||
    !sameIdentity(row.identity, context.identity) ||
    !row.claim ||
    !sameOwner(row.claim, context.owner)
  )
    fail("JOURNAL_STALE_CLAIM");
  if (row.cancelFence || row.cancelled) fail("JOURNAL_CANCEL_FENCED");
  if (row.phase === "terminal") fail("JOURNAL_TERMINAL");
}

export function assertWorker(worker: SpatialReferenceJournalWorker): void {
  assertSafeInteger(worker.pid, "JOURNAL_WORKER_INVALID");
  assertSafeInteger(worker.startTime, "JOURNAL_WORKER_INVALID");
  assertText(worker.scopeId, "JOURNAL_WORKER_INVALID");
  if (!/^[a-f0-9]{64}$/iu.test(worker.workerTokenDigest)) fail("JOURNAL_WORKER_INVALID");
  if (worker.exited) assertSafeInteger(worker.exited.atMs, "JOURNAL_WORKER_INVALID");
}

export function recomposePreparedCallback(
  row: SpatialReferenceJournalRow,
): SpatialReferenceTerminalCallback {
  if (!row.prepared || !allOutputsFinalized(row)) fail("JOURNAL_TERMINAL_OUTPUTS_INCOMPLETE");
  const finalized = new Map(
    (row.knownFinalizedReceipts ?? []).map((item) => [outputKey(item), item]),
  );
  const callback = clone(row.prepared.callback) as Record<string, unknown>;
  const patch = (candidate: unknown, slot: string, ordinal: number): void => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      fail("JOURNAL_PREPARED_CALLBACK_INVALID");
    const output = finalized.get(`${slot}:${ordinal}`);
    const receipt = candidate as Record<string, unknown>;
    if (
      !output ||
      receipt.artifactId !== output.artifactId ||
      receipt.mimeType !== output.mimeType ||
      receipt.byteLength !== output.size ||
      receipt.sha256Hex !== output.sha256Hex ||
      "storageKey" in receipt
    ) {
      fail("JOURNAL_PREPARED_CALLBACK_INVALID");
    }
    receipt.storageKey = output.storageKey;
  };
  patch(callback.receipt, "composition_frame", 0);
  if (callback.motionReferenceReceipt !== undefined)
    patch(callback.motionReferenceReceipt, "motion_reference_video", 0);
  if (callback.referenceFileReceipts !== undefined) {
    if (!Array.isArray(callback.referenceFileReceipts)) fail("JOURNAL_PREPARED_CALLBACK_INVALID");
    for (const candidate of callback.referenceFileReceipts) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        fail("JOURNAL_PREPARED_CALLBACK_INVALID");
      const receipt = candidate as Record<string, unknown>;
      if (typeof receipt.slot !== "string" || !Number.isSafeInteger(receipt.ordinal))
        fail("JOURNAL_PREPARED_CALLBACK_INVALID");
      patch(receipt, receipt.slot, receipt.ordinal as number);
    }
  }
  return callback as SpatialReferenceTerminalCallback;
}

export function cancelledCallback(
  callback: SpatialReferenceTerminalCallback,
): SpatialReferenceTerminalCallback {
  return {
    kind: callback.kind,
    workspaceId: callback.workspaceId,
    runtimeId: callback.runtimeId,
    taskId: callback.taskId,
    materializationId: callback.materializationId,
    executionId: callback.executionId,
    dispatchAttemptId: callback.dispatchAttemptId,
    sequence: callback.sequence,
    attempt: callback.attempt,
    status: "cancelled",
    intentFingerprint: callback.intentFingerprint,
    executionFingerprint: callback.executionFingerprint,
  };
}
