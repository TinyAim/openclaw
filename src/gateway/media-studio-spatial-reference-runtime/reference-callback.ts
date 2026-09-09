/** Receipt-only wire projection shared with the durable Runtime journal. */
import type {
  SpatialReferenceRelayDispatch,
  SpatialReferenceRelayDispatchAck,
} from "../media-studio-spatial-reference-render-http.js";
export type UploadReceipt = {
  artifactId: string;
  storageKey: string;
  size: number;
  sha256Hex: string;
  mimeType: string;
};

export function callbackBody(input: {
  dispatch: SpatialReferenceRelayDispatch;
  ack: SpatialReferenceRelayDispatchAck;
  status: "succeeded" | "failed" | "cancelled";
  receipt?: UploadReceipt & {
    width: number;
    height: number;
    profile: "proxy_previs" | "reference_composite";
    rendererContractVersion: string;
    rendererBuildDigest: string;
    pixelDigest?: string;
    usedProxySilhouettes: boolean;
  };
  motionReferenceReceipt?: UploadReceipt & {
    width: number;
    height: number;
    durationMs: number;
    fps: number;
    frameCount: number;
    evaluatorVersion: string;
  };
  referenceFileReceipts?: Array<
    UploadReceipt & {
      slot: "start_frame" | "end_frame" | "topdown_frame" | "keyframe";
      ordinal: number;
      sourceTimeMs?: number;
      width: number;
      height: number;
    }
  >;
  errorCode?: string;
  errorMessage?: string;
}) {
  return {
    kind: "media_studio.spatial_reference_render.callback" as const,
    workspaceId: input.dispatch.workspaceId,
    runtimeId: input.dispatch.runtimeId,
    taskId: input.dispatch.taskId,
    materializationId: input.dispatch.materializationId,
    executionId: input.ack.executionId,
    dispatchAttemptId: input.dispatch.dispatchAttemptId,
    sequence: input.dispatch.sequence,
    attempt: input.dispatch.attempt,
    status: input.status,
    intentFingerprint: input.dispatch.intentFingerprint,
    executionFingerprint: input.dispatch.executionFingerprint,
    ...(input.receipt
      ? {
          receipt: {
            artifactId: input.receipt.artifactId,
            ...(input.receipt.storageKey ? { storageKey: input.receipt.storageKey } : {}),
            mimeType: "image/png" as const,
            byteLength: input.receipt.size,
            sha256Hex: input.receipt.sha256Hex,
            ...(input.receipt.pixelDigest ? { pixelDigest: input.receipt.pixelDigest } : {}),
            width: input.receipt.width,
            height: input.receipt.height,
            profile: input.receipt.profile,
            rendererContractVersion: input.receipt.rendererContractVersion,
            rendererBuildDigest: input.receipt.rendererBuildDigest,
            usedProxySilhouettes: input.receipt.usedProxySilhouettes,
          },
        }
      : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.motionReferenceReceipt
      ? {
          motionReferenceReceipt: {
            artifactId: input.motionReferenceReceipt.artifactId,
            ...(input.motionReferenceReceipt.storageKey
              ? { storageKey: input.motionReferenceReceipt.storageKey }
              : {}),
            mimeType: "video/mp4" as const,
            byteLength: input.motionReferenceReceipt.size,
            sha256Hex: input.motionReferenceReceipt.sha256Hex,
            width: input.motionReferenceReceipt.width,
            height: input.motionReferenceReceipt.height,
            durationMs: input.motionReferenceReceipt.durationMs,
            fps: input.motionReferenceReceipt.fps,
            frameCount: input.motionReferenceReceipt.frameCount,
            evaluatorVersion: input.motionReferenceReceipt.evaluatorVersion,
          },
        }
      : {}),
    ...(input.referenceFileReceipts?.length
      ? {
          referenceFileReceipts: input.referenceFileReceipts.map((receipt) => ({
            artifactId: receipt.artifactId,
            ...(receipt.storageKey ? { storageKey: receipt.storageKey } : {}),
            mimeType: "image/png" as const,
            byteLength: receipt.size,
            sha256Hex: receipt.sha256Hex,
            slot: receipt.slot,
            ordinal: receipt.ordinal,
            ...(typeof receipt.sourceTimeMs === "number"
              ? { sourceTimeMs: receipt.sourceTimeMs }
              : {}),
            width: receipt.width,
            height: receipt.height,
          })),
        }
      : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 200) } : {}),
  };
}

export type SpatialReferenceTerminalCallback = ReturnType<typeof callbackBody>;
