/**
 * Authenticated user-runtime endpoint for model-free panorama construction.
 *
 * The endpoint accepts only one-shot Artifact grants and returns an ACK.
 * Source/output bytes stay on the Control API Artifact handoff path.
 */
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
import { MODEL_FREE_PANORAMA_CONTRACT_VERSION } from "./media-studio-spatial-environment-render/types.js";

export const MEDIA_STUDIO_SPATIAL_ENVIRONMENT_PANORAMA_RENDER_PATH =
  "/v1/runtime/media-studio/spatial-environment/panorama" as const;

const MAX_BODY_BYTES = 256 * 1024;

const OUTPUT_MIME: Readonly<Record<string, string>> = Object.freeze({
  environment_panorama: "image/png",
  generated_region_mask: "image/png",
  quality_report: "application/json",
});

export type SpatialEnvironmentPanoramaGrant = {
  grantToken: string;
  purpose: "source_download" | "output_upload";
  slot: "source_image" | "environment_panorama" | "generated_region_mask" | "quality_report";
  artifactId: string;
  allowedMimeTypes: readonly string[];
  expectedSha256Hex?: string;
  maxBytes: number;
  expiresAt: string;
};

export type SpatialEnvironmentPanoramaRuntimeRequest = {
  kind: "media_studio.spatial_environment_panorama";
  contractVersion: typeof MODEL_FREE_PANORAMA_CONTRACT_VERSION;
  workspaceId: string;
  runtimeId: string;
  taskId: string;
  materializationId: string;
  requestFingerprint: string;
  executionFingerprint: string;
  dispatchAttemptId: string;
  sequence: number;
  attempt: number;
  leaseExpiresAt: string;
  sourceGrant: SpatialEnvironmentPanoramaGrant;
  outputUploadGrants: readonly SpatialEnvironmentPanoramaGrant[];
  horizontalFovDegrees: number;
  outputWidth: number;
  centerYawDegrees?: number;
};

export type SpatialEnvironmentPanoramaRuntimeResult = {
  ok: true;
  accepted: true;
  deferredSettlement: true;
  runtimeId: string;
  executionId: string;
  taskId: string;
  materializationId: string;
  requestFingerprint: string;
  executionFingerprint: string;
  dispatchAttemptId: string;
  sequence: number;
  attempt: number;
  leaseExpiresAt: string;
};

export interface SpatialEnvironmentPanoramaRuntimeExecutor {
  dispatch(
    input: SpatialEnvironmentPanoramaRuntimeRequest,
  ): SpatialEnvironmentPanoramaRuntimeResult | Promise<SpatialEnvironmentPanoramaRuntimeResult>;
  cancel(input: { dispatchAttemptId: string }): {
    acknowledged: boolean;
    terminal: boolean;
  };
  /** Stops durable callback replay during gateway shutdown/tests. */
  stop?(): void;
  /** Deterministic one-shot drain used by startup recovery and focused tests. */
  flushCallbacksOnce?(): Promise<void>;
}

export type MediaStudioSpatialEnvironmentPanoramaHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  maxBodyBytes?: number;
  executor: SpatialEnvironmentPanoramaRuntimeExecutor;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function grant(
  value: unknown,
  purpose: SpatialEnvironmentPanoramaGrant["purpose"],
): SpatialEnvironmentPanoramaGrant | undefined {
  const raw = record(value);
  const grantToken = text(raw?.grantToken);
  const artifactId = text(raw?.artifactId);
  const slot = raw?.slot;
  const maxBytes = finite(raw?.maxBytes);
  const expiresAt = text(raw?.expiresAt);
  const allowedMimeTypes = Array.isArray(raw?.allowedMimeTypes)
    ? raw.allowedMimeTypes
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().toLowerCase())
    : [];
  const expectedSha256Hex = text(raw?.expectedSha256Hex);
  if (
    !raw ||
    raw.purpose !== purpose ||
    !grantToken ||
    !artifactId ||
    (slot !== "source_image" &&
      slot !== "environment_panorama" &&
      slot !== "generated_region_mask" &&
      slot !== "quality_report") ||
    !Number.isInteger(maxBytes) ||
    (maxBytes ?? 0) < 1 ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    allowedMimeTypes.length !== 1 ||
    allowedMimeTypes.length !== (raw?.allowedMimeTypes as unknown[])?.length ||
    (expectedSha256Hex !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256Hex))
  ) {
    return undefined;
  }
  const mimeType = allowedMimeTypes[0]!;
  const correctMime =
    purpose === "output_upload"
      ? OUTPUT_MIME[String(slot)] === mimeType
      : slot === "source_image" && mimeType.startsWith("image/");
  if (!correctMime || (purpose === "source_download" && !expectedSha256Hex)) {
    return undefined;
  }
  return {
    grantToken,
    purpose,
    slot,
    artifactId,
    allowedMimeTypes,
    ...(expectedSha256Hex ? { expectedSha256Hex } : {}),
    maxBytes: maxBytes!,
    expiresAt,
  };
}

export function parseSpatialEnvironmentPanoramaRuntimeRequest(
  value: unknown,
): SpatialEnvironmentPanoramaRuntimeRequest | null {
  const raw = record(value);
  if (!raw || raw.kind !== "media_studio.spatial_environment_panorama") {
    return null;
  }
  if (
    "sourceImageBase64" in raw ||
    "panoramaPngBase64" in raw ||
    "bytes" in raw ||
    "imageBase64" in raw
  ) {
    return null;
  }
  if (raw.contractVersion !== MODEL_FREE_PANORAMA_CONTRACT_VERSION) {
    return null;
  }
  const workspaceId = text(raw.workspaceId);
  const runtimeId = text(raw.runtimeId);
  const taskId = text(raw.taskId);
  const materializationId = text(raw.materializationId);
  const requestFingerprint = text(raw.requestFingerprint);
  const executionFingerprint = text(raw.executionFingerprint);
  const dispatchAttemptId = text(raw.dispatchAttemptId);
  const leaseExpiresAt = text(raw.leaseExpiresAt);
  const sequence = finite(raw.sequence);
  const attempt = finite(raw.attempt);
  const sourceGrant = grant(raw.sourceGrant, "source_download");
  const rawOutputGrantCount = Array.isArray(raw.outputUploadGrants)
    ? raw.outputUploadGrants.length
    : 0;
  const outputUploadGrants = Array.isArray(raw.outputUploadGrants)
    ? raw.outputUploadGrants
        .map((item) => grant(item, "output_upload"))
        .filter((item): item is SpatialEnvironmentPanoramaGrant => Boolean(item))
    : [];
  const horizontalFovDegrees = finite(raw.horizontalFovDegrees);
  const outputWidth = finite(raw.outputWidth);
  const centerYawDegrees = finite(raw.centerYawDegrees);
  if (
    !workspaceId ||
    !runtimeId ||
    !taskId ||
    !materializationId ||
    !requestFingerprint ||
    !executionFingerprint ||
    !dispatchAttemptId ||
    !leaseExpiresAt ||
    !Number.isInteger(sequence) ||
    (sequence ?? 0) < 1 ||
    !Number.isInteger(attempt) ||
    (attempt ?? 0) < 1 ||
    !Number.isFinite(Date.parse(leaseExpiresAt)) ||
    !sourceGrant ||
    sourceGrant.slot !== "source_image" ||
    rawOutputGrantCount !== 3 ||
    outputUploadGrants.length !== 3 ||
    new Set(outputUploadGrants.map((item) => item.slot)).size !== 3 ||
    !outputUploadGrants.some((item) => item.slot === "environment_panorama") ||
    !outputUploadGrants.some((item) => item.slot === "generated_region_mask") ||
    !outputUploadGrants.some((item) => item.slot === "quality_report") ||
    sourceGrant.expiresAt !== leaseExpiresAt ||
    outputUploadGrants.some((item) => item.expiresAt !== leaseExpiresAt) ||
    horizontalFovDegrees === undefined ||
    outputWidth === undefined
  ) {
    return null;
  }
  return {
    kind: "media_studio.spatial_environment_panorama",
    contractVersion: MODEL_FREE_PANORAMA_CONTRACT_VERSION,
    workspaceId,
    runtimeId,
    taskId,
    materializationId,
    requestFingerprint,
    executionFingerprint,
    dispatchAttemptId,
    sequence: sequence!,
    attempt: attempt!,
    leaseExpiresAt,
    sourceGrant,
    outputUploadGrants,
    horizontalFovDegrees,
    outputWidth,
    ...(centerYawDegrees !== undefined ? { centerYawDegrees } : {}),
  };
}

export async function executeSpatialEnvironmentPanoramaRuntimeRequest(
  input: SpatialEnvironmentPanoramaRuntimeRequest,
  executor: SpatialEnvironmentPanoramaRuntimeExecutor,
): Promise<SpatialEnvironmentPanoramaRuntimeResult> {
  return executor.dispatch(input);
}

function resolveConnectAuth(req: IncomingMessage) {
  const token = getBearerToken(req);
  const password = getHeader(req, "x-wisclaw-gateway-password");
  if (token && password) {
    return { token, password };
  }
  if (token) {
    return { token };
  }
  if (password) {
    return { password };
  }
  return null;
}

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioSpatialEnvironmentPanoramaHttpOptions,
): Promise<boolean> {
  const connectAuth = resolveConnectAuth(req);
  if (connectAuth?.token && connectAuth?.password) {
    sendInvalidRequest(
      res,
      "Spatial environment panorama accepts either bearer token or gateway password, not both",
    );
    return false;
  }
  const authResult = await authorizeHttpGatewayConnect({
    auth: options.auth,
    connectAuth,
    req,
    trustedProxies: options.trustedProxies,
    allowRealIpFallback: options.allowRealIpFallback,
    rateLimiter: options.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return false;
  }
  return true;
}

export async function handleMediaStudioSpatialEnvironmentPanoramaHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioSpatialEnvironmentPanoramaHttpOptions,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== MEDIA_STUDIO_SPATIAL_ENVIRONMENT_PANORAMA_RENDER_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  if (!(await authorizeRequest(req, res, options))) {
    return true;
  }
  const body = await readJsonBodyOrError(req, res, options.maxBodyBytes ?? MAX_BODY_BYTES);
  if (body === undefined) {
    return true;
  }
  const input = parseSpatialEnvironmentPanoramaRuntimeRequest(body);
  if (!input) {
    sendInvalidRequest(res, "Invalid model-free panorama request");
    return true;
  }
  try {
    sendJson(
      res,
      202,
      await executeSpatialEnvironmentPanoramaRuntimeRequest(input, options.executor),
    );
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      code: "panorama_render_failed",
      message: "model-free panorama construction failed",
    });
  }
  return true;
}
