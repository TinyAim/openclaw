/** Rendering produces a durable receipt template before any upload can start. */
import { createHash } from "node:crypto";
import type {
  SpatialReferenceRelayDispatch,
  SpatialReferenceRelayDispatchAck,
} from "../media-studio-spatial-reference-render-http.js";
import { renderSpatialReferenceComposition } from "../media-studio-spatial-reference-render/index.js";
import { callbackBody, type SpatialReferenceTerminalCallback } from "./reference-callback.js";
import type {
  SpatialReferenceExpectedOutput,
  SpatialReferencePreparedOutput,
} from "./reference-journal-record.js";
import type { SpatialReferenceV2Renderer, SpatialReferenceV2MissingOutput } from "./v2-renderer.js";

export type ReferenceRenderedOutput = SpatialReferencePreparedOutput & { bytes: Buffer };
export type ReferencePrepared = {
  callback: SpatialReferenceTerminalCallback;
  outputs: ReferenceRenderedOutput[];
};
export type ReferenceLifecycle = Parameters<SpatialReferenceV2Renderer["render"]>[2];

export async function prepareReferenceRender(
  input: SpatialReferenceRelayDispatch,
  ack: SpatialReferenceRelayDispatchAck,
  expected: readonly SpatialReferenceExpectedOutput[],
  signal: AbortSignal,
  renderer?: SpatialReferenceV2Renderer,
  lifecycle?: ReferenceLifecycle,
): Promise<ReferencePrepared> {
  const outputs: ReferenceRenderedOutput[] = [];
  const proof = (slot: string, ordinal: number, bytes: Buffer) => {
    const descriptor = expected.find((item) => item.slot === slot && item.ordinal === ordinal);
    if (!descriptor) throw new Error("spatial_render_output_not_requested");
    const output = {
      slot,
      ordinal,
      artifactId: descriptor.artifactId,
      bytes,
      size: bytes.length,
      sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      mimeType: descriptor.expectedMimeType,
    };
    outputs.push(output);
    return { ...output, storageKey: "" };
  };
  if (input.contractVersion === "spatial_reference_render/v2") {
    if (!renderer) throw new Error("spatial_v2_renderer_unavailable");
    const result = await renderer.render(input, signal, lifecycle);
    const composition = proof("composition_frame", 0, result.compositionPng);
    const motion = proof("motion_reference_video", 0, result.motionMp4);
    const referenceFiles = result.referencePngs.map((file) => ({
      ...proof(file.slot, file.ordinal, file.png),
      slot: file.slot,
      ordinal: file.ordinal,
      ...(file.sourceTimeMs === undefined ? {} : { sourceTimeMs: file.sourceTimeMs }),
      width: result.width,
      height: result.height,
    }));
    const callback = callbackBody({
      dispatch: input,
      ack,
      status: "succeeded",
      receipt: {
        ...composition,
        width: result.width,
        height: result.height,
        profile: "proxy_previs",
        rendererContractVersion: input.renderIntent.rendererContractVersion,
        rendererBuildDigest: input.renderIntent.rendererBuildDigest,
        pixelDigest: result.compositionPixelDigest,
        usedProxySilhouettes: false,
      },
      motionReferenceReceipt: {
        ...motion,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        fps: result.fps,
        frameCount: result.frameCount,
        evaluatorVersion: result.evaluatorVersion,
      },
      referenceFileReceipts: referenceFiles,
    });
    if (outputs.length !== expected.length)
      throw new Error("spatial_render_required_output_missing");
    return { callback: withoutStorageKeys(callback), outputs };
  }
  if (input.sourceGrants?.length) throw new Error("source_grant_redemption_not_supported");
  const rendered = await renderSpatialReferenceComposition({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    materializationId: input.materializationId,
    runtimeIdempotencyKey: input.runtimeIdempotencyKey,
    profile: input.renderIntent.profile,
    width: input.renderIntent.width,
    height: input.renderIntent.height,
    camera: {
      position: input.blueprint.camera.position,
      targetPoint: input.blueprint.camera.targetPoint,
      focalLengthMm: input.blueprint.camera.focalLengthMm,
      sensorWidthMm: input.blueprint.camera.sensorWidthMm,
      frameAspectRatio: input.blueprint.frameAspectRatio,
    },
    nodes: input.blueprint.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      position: node.position,
      ...(node.scale ? { scale: node.scale } : {}),
      ...(node.label ? { label: node.label } : {}),
    })),
    backgroundPolicy: input.renderIntent.backgroundPolicy,
    rendererContractVersion: input.renderIntent.rendererContractVersion,
    rendererBuildDigest: input.renderIntent.rendererBuildDigest,
    ...(input.blueprint.environmentCrop
      ? { environmentCrop: input.blueprint.environmentCrop }
      : {}),
    ...(input.renderIntent.fitMode ? { fitMode: input.renderIntent.fitMode } : {}),
  });
  if (!rendered.ok) throw new Error(`${rendered.code}:${rendered.message}`);
  const upload = proof("composition_frame", 0, rendered.png);
  return {
    outputs,
    callback: withoutStorageKeys(
      callbackBody({
        dispatch: input,
        ack,
        status: "succeeded",
        receipt: {
          ...upload,
          width: rendered.width,
          height: rendered.height,
          profile: rendered.profile,
          rendererContractVersion: rendered.rendererContractVersion,
          rendererBuildDigest: rendered.rendererBuildDigest,
          pixelDigest: rendered.pixelDigest,
          usedProxySilhouettes: rendered.usedProxySilhouettes,
        },
      }),
    ),
  };
}

function withoutStorageKeys(
  callback: SpatialReferenceTerminalCallback,
): SpatialReferenceTerminalCallback {
  if (callback.receipt) delete callback.receipt.storageKey;
  if (callback.motionReferenceReceipt) delete callback.motionReferenceReceipt.storageKey;
  for (const receipt of callback.referenceFileReceipts ?? []) delete receipt.storageKey;
  return callback;
}

/** On restart a missing item is rendered alone; finalized outputs are never passed to the worker. */
export async function prepareMissingReferenceRender(
  input: SpatialReferenceRelayDispatch,
  expected: readonly SpatialReferenceExpectedOutput[],
  missing: readonly SpatialReferenceExpectedOutput[],
  prepared: {
    callback: SpatialReferenceTerminalCallback;
    outputs: readonly SpatialReferencePreparedOutput[];
  },
  signal: AbortSignal,
  renderer?: SpatialReferenceV2Renderer,
  lifecycle?: ReferenceLifecycle,
): Promise<ReferencePrepared> {
  if (input.contractVersion !== "spatial_reference_render/v2" || !renderer?.renderMissing) {
    throw new Error("spatial_recovery_missing_renderer_unavailable");
  }
  const slots = missing.map((item): SpatialReferenceV2MissingOutput => {
    const slot = item.slot;
    if (
      slot !== "composition_frame" &&
      slot !== "motion_reference_video" &&
      slot !== "start_frame" &&
      slot !== "end_frame" &&
      slot !== "topdown_frame" &&
      slot !== "keyframe"
    )
      throw new Error("spatial_recovery_output_slot_invalid");
    return { slot, ordinal: item.ordinal };
  });
  const partial = await renderer.renderMissing(input, signal, slots, lifecycle);
  const outputs = partial.map((item): ReferenceRenderedOutput => {
    const descriptor = missing.find((d) => d.slot === item.slot && d.ordinal === item.ordinal);
    const bytes = item.slot === "motion_reference_video" ? item.motionMp4 : item.png;
    if (!descriptor || !bytes) throw new Error("spatial_recovery_unrequested_output");
    const original = prepared.outputs.find(
      (d) => d.slot === descriptor.slot && d.ordinal === descriptor.ordinal,
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (
      !original ||
      original.sha256Hex !== hash ||
      original.size !== bytes.length ||
      original.artifactId !== descriptor.artifactId ||
      original.mimeType !== descriptor.expectedMimeType
    ) {
      throw new Error("spatial_recovery_render_proof_mismatch");
    }
    return { ...original, bytes };
  });
  if (
    outputs.length !== missing.length ||
    new Set(outputs.map((o) => `${o.slot}:${o.ordinal}`)).size !== missing.length ||
    prepared.outputs.length !== expected.length
  )
    throw new Error("spatial_recovery_required_output_missing");
  return { callback: prepared.callback, outputs };
}
