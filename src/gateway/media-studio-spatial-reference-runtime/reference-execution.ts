/** Secret-free frozen execution identity and receipt projections. */
import { createHash } from "node:crypto";
import type {
  SpatialReferenceRelayDispatch,
  SpatialReferenceRelayDispatchAck,
} from "../media-studio-spatial-reference-render-http.js";
import { callbackBody, type SpatialReferenceTerminalCallback } from "./reference-callback.js";
import {
  canonicalJson,
  outputKey,
  type SpatialReferenceExpectedOutput,
  type SpatialReferenceJournalIdentity,
  type SpatialReferencePreparedOutput,
  type SpatialReferenceFinalizedOutput,
} from "./reference-journal-record.js";

export function referenceExpectedOutputs(
  input: SpatialReferenceRelayDispatch,
): SpatialReferenceExpectedOutput[] {
  if (input.contractVersion === "spatial_reference_render/v2") {
    const expected = input.expectedOutputs.map((output) => ({
      slot: output.slot,
      ordinal: output.ordinal,
      artifactId: output.artifactId,
      expectedMimeType: output.mimeType,
      ...(output.sourceTimeMs === undefined ? {} : { sourceTimeMs: output.sourceTimeMs }),
    }));
    const keys = new Set<string>();
    const expectedShape = [
      { slot: "composition_frame", ordinal: 0, expectedMimeType: "image/png" as const },
      { slot: "motion_reference_video", ordinal: 0, expectedMimeType: "video/mp4" as const },
      ...(input.motionReference.referenceFrames ?? []).map(({ slot, ordinal, sourceTimeMs }) => ({
        slot,
        ordinal,
        expectedMimeType: "image/png" as const,
        ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
      })),
    ];
    const same = (
      left: { slot: string; ordinal: number; sourceTimeMs?: number },
      right: { slot: string; ordinal: number; sourceTimeMs?: number },
    ) =>
      left.slot === right.slot &&
      left.ordinal === right.ordinal &&
      left.sourceTimeMs === right.sourceTimeMs;
    if (
      expected.length !== expectedShape.length ||
      expected.some((output) => {
        const key = outputKey(output);
        return (
          keys.has(key) ||
          !keys.add(key) ||
          !output.artifactId ||
          !expectedShape.some(
            (shape) => same(output, shape) && output.expectedMimeType === shape.expectedMimeType,
          )
        );
      }) ||
      expectedShape.some((shape) => !expected.some((output) => same(output, shape)))
    ) {
      throw new Error("spatial_reference_expected_output_package_invalid");
    }
    for (const output of expected) {
      const grant = referenceGrant(input, output);
      if (grant?.artifactId && grant.artifactId !== output.artifactId) {
        throw new Error("spatial_reference_output_identity_conflict");
      }
    }
    return expected;
  }
  const slots = [{ slot: "composition_frame", ordinal: 0 }];
  return slots.map((slot) => {
    const grant = referenceGrant(input, slot);
    if (!grant?.artifactId) throw new Error("output_upload_grant_required");
    return {
      ...slot,
      artifactId: grant.artifactId,
      expectedMimeType: slot.slot === "motion_reference_video" ? "video/mp4" : "image/png",
    };
  });
}

/**
 * Build the ordinary success callback from a complete server-read-back set.
 * This is the v2 zero-missing terminal path: no renderer, encoder, or upload
 * grant is touched after the frozen package has already been finalized.
 */
export function callbackFromFinalizedReceipts(input: {
  dispatch: Extract<
    SpatialReferenceRelayDispatch,
    { contractVersion: "spatial_reference_render/v2" }
  >;
  ack: SpatialReferenceRelayDispatchAck;
  expectedOutputs: readonly SpatialReferenceExpectedOutput[];
  finalized: readonly SpatialReferenceFinalizedOutput[];
}): SpatialReferenceTerminalCallback {
  const byKey = new Map(input.finalized.map((output) => [outputKey(output), output]));
  if (
    byKey.size !== input.expectedOutputs.length ||
    input.expectedOutputs.some((expected) => {
      const output = byKey.get(outputKey(expected));
      return (
        !output ||
        output.artifactId !== expected.artifactId ||
        output.mimeType !== expected.expectedMimeType
      );
    })
  ) {
    throw new Error("spatial_reference_terminal_receipts_incomplete");
  }
  const requireOutput = (slot: string, ordinal: number) => {
    const output = byKey.get(`${slot}:${ordinal}`);
    if (!output || !output.storageKey)
      throw new Error("spatial_reference_terminal_receipt_missing");
    return output;
  };
  const composition = requireOutput("composition_frame", 0);
  const motion = requireOutput("motion_reference_video", 0);
  const references = (input.dispatch.motionReference.referenceFrames ?? []).map((frame) => {
    const output = requireOutput(frame.slot, frame.ordinal);
    return {
      ...output,
      slot: frame.slot,
      ordinal: frame.ordinal,
      ...(frame.sourceTimeMs === undefined ? {} : { sourceTimeMs: frame.sourceTimeMs }),
      width: input.dispatch.renderIntent.width,
      height: input.dispatch.renderIntent.height,
    };
  });
  return callbackBody({
    dispatch: input.dispatch,
    ack: input.ack,
    status: "succeeded",
    receipt: {
      ...composition,
      width: input.dispatch.renderIntent.width,
      height: input.dispatch.renderIntent.height,
      profile: input.dispatch.renderIntent.profile,
      rendererContractVersion: input.dispatch.renderIntent.rendererContractVersion,
      rendererBuildDigest: input.dispatch.renderIntent.rendererBuildDigest,
      usedProxySilhouettes: input.dispatch.renderIntent.profile === "proxy_previs",
    },
    motionReferenceReceipt: {
      ...motion,
      width: input.dispatch.renderIntent.width,
      height: input.dispatch.renderIntent.height,
      durationMs: input.dispatch.motionReference.encodedDurationMs,
      fps: input.dispatch.motionReference.fps,
      frameCount: input.dispatch.motionReference.frames.length,
      evaluatorVersion: input.dispatch.motionReference.evaluatorVersion,
    },
    referenceFileReceipts: references,
  });
}

export function referenceGrant(
  input: SpatialReferenceRelayDispatch,
  output: { slot: string; ordinal: number },
) {
  const listed = input.outputUploadGrants?.find(
    (g) => g.slot === output.slot && g.ordinal === output.ordinal,
  );
  const named =
    output.slot === "composition_frame"
      ? input.outputUploadGrant
      : output.slot === "motion_reference_video" &&
          input.contractVersion === "spatial_reference_render/v2"
        ? input.motionReferenceUploadGrant
        : undefined;
  if (listed && named && listed.artifactId !== named.artifactId)
    throw new Error("spatial_reference_output_identity_conflict");
  return listed ?? named;
}

export function referenceIdentity(
  input: SpatialReferenceRelayDispatch,
  ack: SpatialReferenceRelayDispatchAck,
) {
  const expectedOutputs = referenceExpectedOutputs(input);
  const frozenDispatchDigest = createHash("sha256")
    .update(
      canonicalJson({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        shotId: input.shotId,
        blueprint: input.blueprint,
        renderIntent: input.renderIntent,
        contractVersion: input.contractVersion,
        environmentRevisionId: input.environmentRevisionId ?? null,
        environmentRevisionChecksum: input.environmentRevisionChecksum ?? null,
        motionReference:
          input.contractVersion === "spatial_reference_render/v2" ? input.motionReference : null,
        expectedOutputs,
      }),
    )
    .digest("hex");
  const identity: SpatialReferenceJournalIdentity = {
    key: input.runtimeIdempotencyKey,
    runtimeIdempotencyKey: input.runtimeIdempotencyKey,
    runtimeId: input.runtimeId,
    executionId: ack.executionId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    materializationId: input.materializationId,
    dispatchAttemptId: input.dispatchAttemptId,
    sequence: input.sequence,
    attempt: input.attempt,
    intentFingerprint: input.intentFingerprint,
    executionFingerprint: input.executionFingerprint,
    blueprintDigest: input.blueprint.blueprintDigest,
    contractVersion: input.contractVersion,
    rendererBuildDigest: input.renderIntent.rendererBuildDigest,
    frozenDispatchDigest,
  };
  return { identity, expectedOutputs };
}

export function referenceTerminal(
  identity: SpatialReferenceJournalIdentity,
  status: "failed" | "cancelled",
  errorCode?: string,
): SpatialReferenceTerminalCallback {
  return {
    kind: "media_studio.spatial_reference_render.callback",
    workspaceId: identity.workspaceId,
    runtimeId: identity.runtimeId,
    taskId: identity.taskId,
    materializationId: identity.materializationId,
    executionId: identity.executionId,
    dispatchAttemptId: identity.dispatchAttemptId,
    sequence: identity.sequence,
    attempt: identity.attempt,
    status,
    intentFingerprint: identity.intentFingerprint,
    executionFingerprint: identity.executionFingerprint,
    ...(errorCode ? { errorCode, errorMessage: errorCode } : {}),
  };
}

export function callbackWithFinalizedReceipts(
  template: SpatialReferenceTerminalCallback,
  outputs: readonly SpatialReferenceFinalizedOutput[],
): SpatialReferenceTerminalCallback {
  const receipt = <
    T extends { artifactId: string; byteLength: number; sha256Hex: string; mimeType: string },
  >(
    item: T,
  ): T & { storageKey: string } => {
    const output = outputs.find((o) => o.artifactId === item.artifactId);
    if (
      !output ||
      output.size !== item.byteLength ||
      output.sha256Hex !== item.sha256Hex ||
      output.mimeType !== item.mimeType
    )
      throw new Error("spatial_recovery_receipt_mismatch");
    return { ...item, storageKey: output.storageKey };
  };
  return {
    ...template,
    ...(template.receipt ? { receipt: receipt(template.receipt) } : {}),
    ...(template.motionReferenceReceipt
      ? { motionReferenceReceipt: receipt(template.motionReferenceReceipt) }
      : {}),
    ...(template.referenceFileReceipts
      ? { referenceFileReceipts: template.referenceFileReceipts.map(receipt) }
      : {}),
  };
}

export type SpatialReferenceReadback = {
  cancelled: boolean;
  pendingSlots: string[];
  receipts: SpatialReferenceFinalizedOutput[];
};
export function parseReferenceReadback(
  raw: unknown,
  identity: SpatialReferenceJournalIdentity,
  expected: readonly SpatialReferenceExpectedOutput[],
  prepared: readonly SpatialReferencePreparedOutput[] = [],
): SpatialReferenceReadback {
  if (!raw || typeof raw !== "object") throw new Error("spatial_recovery_readback_invalid");
  const data = raw as Record<string, unknown>;
  if (
    !Array.isArray(data.expectedOutputs) ||
    canonicalJson(data.expectedOutputs) !== canonicalJson(expected)
  ) {
    throw new Error("spatial_recovery_expected_outputs_mismatch");
  }
  if (
    data.runtimeId !== identity.runtimeId ||
    data.taskId !== identity.taskId ||
    data.materializationId !== identity.materializationId ||
    data.dispatchAttemptId !== identity.dispatchAttemptId ||
    data.executionFingerprint !== identity.executionFingerprint ||
    typeof data.cancelled !== "boolean" ||
    !Array.isArray(data.receipts) ||
    !Array.isArray(data.pendingSlots) ||
    data.receipts.length > expected.length ||
    data.pendingSlots.some(
      (v) =>
        typeof v !== "string" ||
        !expected.some((e) => (e.slot === "keyframe" ? `${e.slot}:${e.ordinal}` : e.slot) === v),
    )
  ) {
    throw new Error("spatial_recovery_readback_identity_mismatch");
  }
  const seen = new Set<string>();
  const receipts = data.receipts.map((value: unknown): SpatialReferenceFinalizedOutput => {
    if (!value || typeof value !== "object") throw new Error("spatial_recovery_receipt_invalid");
    const r = value as Record<string, unknown>;
    const e = expected.find(
      (item) => (item.slot === "keyframe" ? `${item.slot}:${item.ordinal}` : item.slot) === r.slot,
    );
    if (
      !e ||
      r.artifactId !== e.artifactId ||
      r.mimeType !== e.expectedMimeType ||
      typeof r.size !== "number" ||
      !Number.isSafeInteger(r.size) ||
      r.size < 1 ||
      typeof r.sha256Hex !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.sha256Hex) ||
      typeof r.storageKey !== "string" ||
      !r.storageKey ||
      seen.has(outputKey(e))
    ) {
      throw new Error("spatial_recovery_receipt_mismatch");
    }
    seen.add(outputKey(e));
    const proof = prepared.find((p) => outputKey(p) === outputKey(e));
    if (
      proof &&
      (proof.sha256Hex !== r.sha256Hex ||
        proof.size !== r.size ||
        proof.artifactId !== r.artifactId ||
        proof.mimeType !== r.mimeType)
    ) {
      throw new Error("spatial_recovery_render_proof_mismatch");
    }
    return {
      slot: e.slot,
      ordinal: e.ordinal,
      artifactId: e.artifactId,
      size: r.size,
      sha256Hex: r.sha256Hex,
      mimeType: e.expectedMimeType,
      storageKey: r.storageKey,
    };
  });
  return { cancelled: data.cancelled, pendingSlots: data.pendingSlots as string[], receipts };
}
