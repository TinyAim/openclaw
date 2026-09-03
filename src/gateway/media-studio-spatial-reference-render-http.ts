/** Authenticated ACK-only Spatial reference render relay. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendGatewayAuthFailure,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";

export const MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH =
  "/v1/runtime/media-studio/spatial-reference/render" as const;
export const MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH =
  "/v1/runtime/media-studio/spatial-reference/render/cancel" as const;
const CONTRACT = "spatial_reference_render/v1" as const;
const MAX_BODY_BYTES = 1024 * 1024;

type Vector3 = { x: number; y: number; z: number };
type ArtifactGrant = {
  grantToken: string;
  purpose: "source_download" | "output_upload";
  artifactId?: string;
  expiresAt?: string;
  sha256?: string;
  mimeType?: string;
};

export type SpatialReferenceRelayDispatch = {
  kind: "media_studio.spatial_reference_render";
  contractVersion: typeof CONTRACT;
  workspaceId: string;
  runtimeId: string;
  projectId: string;
  shotId: string;
  taskId: string;
  materializationId: string;
  runtimeIdempotencyKey: string;
  requestId: string;
  attempt: number;
  dispatchAttemptId: string;
  sequence: number;
  leaseExpiresAt: string;
  intentFingerprint: string;
  executionFingerprint: string;
  blueprint: {
    blueprintId: string;
    version: number;
    blueprintDigest: string;
    frameAspectRatio: number;
    camera: {
      position: Vector3;
      targetPoint: Vector3;
      focalLengthMm: number;
      sensorWidthMm: number;
    };
    nodes: Array<{
      nodeId: string;
      kind: string;
      label?: string;
      position: Vector3;
      scale?: Vector3;
    }>;
    environmentCrop?: { x: number; y: number; width: number; height: number };
  };
  renderIntent: {
    profile: "proxy_previs" | "reference_composite";
    width: number;
    height: number;
    fitMode?: "cover" | "contain";
    backgroundPolicy: "environment_plate" | "neutral_studio" | "transparent";
    rendererContractVersion: string;
    rendererBuildDigest: string;
    renderSpecDigest: string;
  };
  environmentRevisionId?: string;
  environmentRevisionChecksum?: string;
  sourceGrants: ArtifactGrant[];
  outputUploadGrant: ArtifactGrant;
  callback: { path: string; controlApiBaseUrl?: string };
};

export type SpatialReferenceRelayDispatchAck = {
  ok: true;
  accepted: true;
  deferredSettlement: true;
  runtimeId: string;
  executionId: string;
  taskId: string;
  materializationId: string;
  attempt: number;
  dispatchAttemptId: string;
  sequence: number;
  leaseExpiresAt: string;
  intentFingerprint: string;
  executionFingerprint: string;
  blueprintDigest: string;
  environmentRevisionId?: string;
  environmentRevisionChecksum?: string;
};

export interface MediaStudioSpatialReferenceRenderHttpExecutor {
  dispatch(
    input: SpatialReferenceRelayDispatch,
  ): SpatialReferenceRelayDispatchAck | Promise<SpatialReferenceRelayDispatchAck>;
  cancel(input: { runtimeIdempotencyKey: string; dispatchAttemptId: string }): {
    acknowledged: boolean;
    terminal: boolean;
  };
}

export type MediaStudioSpatialReferenceRenderHttpOptions = {
  auth: ResolvedGatewayAuth;
  executor: MediaStudioSpatialReferenceRenderHttpExecutor;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  maxBodyBytes?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function vector(value: unknown): Vector3 | undefined {
  const raw = record(value);
  const x = number(raw?.x);
  const y = number(raw?.y);
  const z = number(raw?.z);
  return x === undefined || y === undefined || z === undefined ? undefined : { x, y, z };
}

function artifactGrant(
  value: unknown,
  purpose: ArtifactGrant["purpose"],
): ArtifactGrant | undefined {
  const raw = record(value);
  const grantToken = text(raw?.grantToken);
  const artifactId = text(raw?.artifactId);
  if (!raw || raw.purpose !== purpose || !grantToken) return undefined;
  return {
    grantToken,
    purpose,
    ...(artifactId ? { artifactId } : {}),
    ...(text(raw.expiresAt) ? { expiresAt: text(raw.expiresAt) } : {}),
    ...(text(raw.sha256) ? { sha256: text(raw.sha256) } : {}),
    ...(text(raw.mimeType) ? { mimeType: text(raw.mimeType) } : {}),
  };
}

export function parseSpatialReferenceRelayDispatch(
  value: unknown,
): SpatialReferenceRelayDispatch | null {
  const raw = record(value);
  if (
    !raw ||
    raw.kind !== "media_studio.spatial_reference_render" ||
    raw.contractVersion !== CONTRACT ||
    "png" in raw ||
    "pngBase64" in raw ||
    "bytes" in raw
  ) {
    return null;
  }
  const blueprint = record(raw.blueprint);
  const camera = record(blueprint?.camera);
  const renderIntent = record(raw.renderIntent);
  const callback = record(raw.callback);
  const sourceValues = Array.isArray(raw.sourceGrants) ? raw.sourceGrants : null;
  const sourceGrants = sourceValues
    ?.map((grant) => artifactGrant(grant, "source_download"))
    .filter((grant): grant is ArtifactGrant => Boolean(grant));
  const outputUploadGrant = artifactGrant(raw.outputUploadGrant, "output_upload");
  const nodes = Array.isArray(blueprint?.nodes)
    ? blueprint.nodes.map((value) => {
        const node = record(value);
        const position = vector(node?.position);
        const scale = vector(node?.scale);
        return node && text(node.nodeId) && text(node.kind) && position
          ? {
              nodeId: text(node.nodeId),
              kind: text(node.kind),
              ...(text(node.label) ? { label: text(node.label) } : {}),
              position,
              ...(scale ? { scale } : {}),
            }
          : undefined;
      })
    : [];
  const position = vector(camera?.position);
  const targetPoint = vector(camera?.targetPoint);
  const crop = record(blueprint?.environmentCrop);
  const cropValue =
    crop &&
    number(crop.x) !== undefined &&
    number(crop.y) !== undefined &&
    number(crop.width) !== undefined &&
    number(crop.height) !== undefined
      ? {
          x: number(crop.x)!,
          y: number(crop.y)!,
          width: number(crop.width)!,
          height: number(crop.height)!,
        }
      : undefined;
  const requiredText = [
    raw.workspaceId,
    raw.runtimeId,
    raw.projectId,
    raw.shotId,
    raw.taskId,
    raw.materializationId,
    raw.runtimeIdempotencyKey,
    raw.requestId,
    raw.dispatchAttemptId,
    raw.leaseExpiresAt,
    raw.intentFingerprint,
    raw.executionFingerprint,
    blueprint?.blueprintId,
    blueprint?.blueprintDigest,
    renderIntent?.rendererContractVersion,
    renderIntent?.rendererBuildDigest,
    renderIntent?.renderSpecDigest,
    callback?.path,
  ].map(text);
  if (
    requiredText.some((item) => !item) ||
    !Number.isInteger(raw.attempt) ||
    !Number.isInteger(raw.sequence) ||
    !Number.isInteger(blueprint?.version) ||
    number(blueprint?.frameAspectRatio) === undefined ||
    !position ||
    !targetPoint ||
    number(camera?.focalLengthMm) === undefined ||
    number(camera?.sensorWidthMm) === undefined ||
    nodes.some((node) => !node) ||
    !sourceValues ||
    sourceGrants?.length !== sourceValues.length ||
    !outputUploadGrant?.artifactId ||
    (renderIntent?.profile !== "proxy_previs" && renderIntent?.profile !== "reference_composite") ||
    !Number.isInteger(renderIntent.width) ||
    !Number.isInteger(renderIntent.height) ||
    (renderIntent.backgroundPolicy !== "environment_plate" &&
      renderIntent.backgroundPolicy !== "neutral_studio" &&
      renderIntent.backgroundPolicy !== "transparent")
  ) {
    return null;
  }
  return {
    ...(raw as unknown as SpatialReferenceRelayDispatch),
    blueprint: {
      ...(blueprint as unknown as SpatialReferenceRelayDispatch["blueprint"]),
      camera: {
        position,
        targetPoint,
        focalLengthMm: number(camera.focalLengthMm)!,
        sensorWidthMm: number(camera.sensorWidthMm)!,
      },
      nodes: nodes as SpatialReferenceRelayDispatch["blueprint"]["nodes"],
      ...(cropValue ? { environmentCrop: cropValue } : {}),
    },
    sourceGrants: sourceGrants!,
    outputUploadGrant,
  };
}

function connectAuth(req: IncomingMessage) {
  const token = getBearerToken(req);
  const password = getHeader(req, "x-wisclaw-gateway-password");
  return token ? { token } : password ? { password } : null;
}

export async function handleMediaStudioSpatialReferenceRenderHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioSpatialReferenceRenderHttpOptions,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (
    path !== MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH &&
    path !== MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH
  ) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  const authResult = await authorizeHttpGatewayConnect({
    auth: options.auth,
    connectAuth: connectAuth(req),
    req,
    trustedProxies: options.trustedProxies,
    allowRealIpFallback: options.allowRealIpFallback,
    rateLimiter: options.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }
  const body = await readJsonBodyOrError(req, res, options.maxBodyBytes ?? MAX_BODY_BYTES);
  if (body === undefined) return true;
  if (path === MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH) {
    const raw = record(body);
    const runtimeIdempotencyKey = text(raw?.runtimeIdempotencyKey);
    const dispatchAttemptId = text(raw?.dispatchAttemptId);
    if (!runtimeIdempotencyKey || !dispatchAttemptId) {
      sendInvalidRequest(res, "Invalid Spatial cancel request");
      return true;
    }
    sendJson(res, 200, options.executor.cancel({ runtimeIdempotencyKey, dispatchAttemptId }));
    return true;
  }
  const dispatch = parseSpatialReferenceRelayDispatch(body);
  if (!dispatch) {
    sendInvalidRequest(res, "Invalid Spatial reference render request");
    return true;
  }
  sendJson(res, 202, await options.executor.dispatch(dispatch));
  return true;
}
