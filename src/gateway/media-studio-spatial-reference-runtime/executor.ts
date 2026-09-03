/**
 * OpenClaw execution-plane adapter for Spatial reference rendering.
 *
 * The gateway returns a metadata ACK immediately. The background job renders a
 * PNG, redeems the Control API one-shot upload grant, then posts a receipt-only
 * callback. PNG/base64 bytes never enter callback JSON.
 */
import { createHash } from "node:crypto";
import type {
  MediaStudioSpatialReferenceRenderHttpExecutor,
  SpatialReferenceRelayDispatch,
  SpatialReferenceRelayDispatchAck,
} from "../media-studio-spatial-reference-render-http.js";
import { renderSpatialReferenceComposition } from "../media-studio-spatial-reference-render/index.js";

const RUNTIME_TOKEN_HEADER = "x-wisclaw-media-gen-runtime-token";
const UPLOAD_GRANT_HEADER = "x-wisclaw-spatial-upload-grant";
const UPLOAD_PATH = "/v1/control/media-gen/runtime/spatial-reference/upload";
const CALLBACK_PATH = "/v1/control/media-gen/runtime/spatial-reference/callback";

type RuntimeFetch = typeof fetch;

type UploadReceipt = {
  artifactId: string;
  storageKey: string;
  size: number;
  sha256Hex: string;
  mimeType: string;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function executionId(input: SpatialReferenceRelayDispatch): string {
  const digest = createHash("sha256")
    .update(`${input.runtimeId}:${input.runtimeIdempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `spatial_${digest}`;
}

function buildAck(input: SpatialReferenceRelayDispatch): SpatialReferenceRelayDispatchAck {
  return {
    ok: true,
    accepted: true,
    deferredSettlement: true,
    runtimeId: input.runtimeId,
    executionId: executionId(input),
    taskId: input.taskId,
    materializationId: input.materializationId,
    attempt: input.attempt,
    dispatchAttemptId: input.dispatchAttemptId,
    sequence: input.sequence,
    leaseExpiresAt: input.leaseExpiresAt,
    intentFingerprint: input.intentFingerprint,
    executionFingerprint: input.executionFingerprint,
    blueprintDigest: input.blueprint.blueprintDigest,
    ...(input.environmentRevisionId ? { environmentRevisionId: input.environmentRevisionId } : {}),
    ...(input.environmentRevisionChecksum
      ? { environmentRevisionChecksum: input.environmentRevisionChecksum }
      : {}),
  };
}

async function readEnvelopeData<T>(response: Response): Promise<T> {
  const raw = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok || !raw?.data) {
    const code = raw?.error?.code ?? `http_${response.status}`;
    throw new Error(`spatial_control_api_rejected:${code}`);
  }
  return raw.data;
}

function callbackBody(input: {
  dispatch: SpatialReferenceRelayDispatch;
  ack: SpatialReferenceRelayDispatchAck;
  status: "succeeded" | "failed" | "cancelled";
  receipt?: UploadReceipt & {
    width: number;
    height: number;
    profile: "proxy_previs" | "reference_composite";
    rendererContractVersion: string;
    rendererBuildDigest: string;
    pixelDigest: string;
    usedProxySilhouettes: boolean;
  };
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
            storageKey: input.receipt.storageKey,
            mimeType: "image/png" as const,
            byteLength: input.receipt.size,
            sha256Hex: input.receipt.sha256Hex,
            pixelDigest: input.receipt.pixelDigest,
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
    ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 200) } : {}),
  };
}

export function createMediaStudioSpatialReferenceRuntimeExecutor(options: {
  controlApiUrl: string;
  runtimeId: string;
  token: string;
  fetchImpl?: RuntimeFetch;
  log?: { warn?: (message: string) => void };
}): MediaStudioSpatialReferenceRenderHttpExecutor {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controlApiUrl = options.controlApiUrl.replace(/\/+$/, "");
  const acknowledgements = new Map<string, SpatialReferenceRelayDispatchAck>();
  const cancelled = new Set<string>();

  const postCallback = async (body: unknown): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(joinUrl(controlApiUrl, CALLBACK_PATH), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [RUNTIME_TOKEN_HEADER]: options.token,
          },
          body: JSON.stringify(body),
        });
        await readEnvelopeData(response);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const run = async (
    input: SpatialReferenceRelayDispatch,
    ack: SpatialReferenceRelayDispatchAck,
  ): Promise<void> => {
    try {
      if (cancelled.has(input.runtimeIdempotencyKey)) {
        await postCallback(callbackBody({ dispatch: input, ack, status: "cancelled" }));
        return;
      }
      if (input.runtimeId !== options.runtimeId) {
        throw new Error("runtime_id_mismatch");
      }
      if (input.sourceGrants && input.sourceGrants.length > 0) {
        throw new Error("source_grant_redemption_not_supported");
      }
      const grant = input.outputUploadGrant;
      if (!grant?.grantToken || grant.purpose !== "output_upload" || !grant.artifactId) {
        throw new Error("output_upload_grant_required");
      }
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
      if (!rendered.ok) {
        throw new Error(`${rendered.code}:${rendered.message}`);
      }
      if (cancelled.has(input.runtimeIdempotencyKey)) {
        await postCallback(callbackBody({ dispatch: input, ack, status: "cancelled" }));
        return;
      }
      const uploadUrl = new URL(joinUrl(controlApiUrl, UPLOAD_PATH));
      uploadUrl.searchParams.set("workspaceId", input.workspaceId);
      uploadUrl.searchParams.set("runtimeId", input.runtimeId);
      const uploadResponse = await fetchImpl(uploadUrl, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          [RUNTIME_TOKEN_HEADER]: options.token,
          [UPLOAD_GRANT_HEADER]: grant.grantToken,
        },
        body: rendered.png as unknown as BodyInit,
      });
      const uploaded = await readEnvelopeData<UploadReceipt>(uploadResponse);
      if (
        uploaded.artifactId !== grant.artifactId ||
        uploaded.size !== rendered.byteLength ||
        uploaded.sha256Hex !== rendered.sha256Hex ||
        uploaded.mimeType !== "image/png"
      ) {
        throw new Error("upload_receipt_integrity_mismatch");
      }
      await postCallback(
        callbackBody({
          dispatch: input,
          ack,
          status: "succeeded",
          receipt: {
            ...uploaded,
            width: rendered.width,
            height: rendered.height,
            profile: rendered.profile,
            rendererContractVersion: rendered.rendererContractVersion,
            rendererBuildDigest: rendered.rendererBuildDigest,
            pixelDigest: rendered.pixelDigest,
            usedProxySilhouettes: rendered.usedProxySilhouettes,
          },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await postCallback(
        callbackBody({
          dispatch: input,
          ack,
          status: cancelled.has(input.runtimeIdempotencyKey) ? "cancelled" : "failed",
          errorCode: message.split(":", 1)[0] || "spatial_render_failed",
          errorMessage: message,
        }),
      ).catch((callbackError) => {
        options.log?.warn?.(
          `spatial reference callback failed task=${input.taskId}: ${
            callbackError instanceof Error ? callbackError.message : String(callbackError)
          }`,
        );
      });
    }
  };

  return {
    dispatch(input) {
      const prior = acknowledgements.get(input.runtimeIdempotencyKey);
      if (prior) return prior;
      const ack = buildAck(input);
      acknowledgements.set(input.runtimeIdempotencyKey, ack);
      void run(input, ack);
      return ack;
    },
    cancel(input) {
      cancelled.add(input.runtimeIdempotencyKey);
      return { acknowledged: true, terminal: false };
    },
  };
}
