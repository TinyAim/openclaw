/** Grant-only Runtime contract for deterministic depth-mesh construction. */
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
import {
  DEPTH_ADAPTER_CONTRACT_VERSION,
  DEPTH_MESH_CONTRACT_VERSION,
  type DepthMeshManualCalibration,
  type DepthMeshScaleAnchor,
} from "./media-studio-spatial-depth-mesh-render/types.js";

export const MEDIA_STUDIO_SPATIAL_ENVIRONMENT_DEPTH_MESH_RENDER_PATH =
  "/v1/runtime/media-studio/spatial-environment/depth-mesh" as const;

export type SpatialDepthMeshSlot =
  | "source_image"
  | "depth_adapter"
  | "environment_depth_mesh"
  | "generated_region_mask"
  | "collision"
  | "quality_report";

export type SpatialDepthMeshGrant = {
  grantToken: string;
  purpose: "source_download" | "output_upload";
  slot: SpatialDepthMeshSlot;
  artifactId: string;
  allowedMimeTypes: readonly string[];
  expectedSha256Hex?: string;
  maxBytes: number;
  expiresAt: string;
};

export type SpatialDepthAdapterMetadata = {
  contractVersion: typeof DEPTH_ADAPTER_CONTRACT_VERSION;
  encoding: "normalized_depth_u16le" | "normalized_inverse_depth_u16le";
  width: number;
  height: number;
  confidence: number;
  componentManifestDigest: string;
  checkpointDigests: readonly string[];
  noticeRefs: readonly string[];
};

export type SpatialEnvironmentDepthMeshRuntimeRequest = {
  kind: "media_studio.spatial_environment_depth_mesh";
  contractVersion: typeof DEPTH_MESH_CONTRACT_VERSION;
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
  sourceGrant: SpatialDepthMeshGrant;
  depthGrant?: SpatialDepthMeshGrant;
  outputUploadGrants: readonly SpatialDepthMeshGrant[];
  calibration: DepthMeshManualCalibration;
  depthAdapter?: SpatialDepthAdapterMetadata;
  scaleAnchor?: DepthMeshScaleAnchor;
};

export type SpatialEnvironmentDepthMeshRuntimeResult = {
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

export interface SpatialEnvironmentDepthMeshRuntimeExecutor {
  dispatch(
    input: SpatialEnvironmentDepthMeshRuntimeRequest,
  ): SpatialEnvironmentDepthMeshRuntimeResult | Promise<SpatialEnvironmentDepthMeshRuntimeResult>;
  cancel(input: { dispatchAttemptId: string }): {
    acknowledged: boolean;
    terminal: boolean;
  };
  /** Stop callback replay when the owning Runtime host shuts down. */
  stop?(): void;
  /** Deterministic recovery hook used by startup and focused tests. */
  flushCallbacksOnce?(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function point(value: unknown): { x: number; y: number } | undefined {
  const raw = record(value);
  return raw && unit(raw.x) && unit(raw.y) ? { x: raw.x, y: raw.y } : undefined;
}

const OUTPUT_MIME: Readonly<Record<string, string>> = Object.freeze({
  environment_depth_mesh: "model/gltf-binary",
  generated_region_mask: "image/png",
  collision: "application/json",
  quality_report: "application/json",
});

function grant(
  value: unknown,
  purpose: SpatialDepthMeshGrant["purpose"],
): SpatialDepthMeshGrant | undefined {
  const raw = record(value);
  const grantToken = text(raw?.grantToken);
  const artifactId = text(raw?.artifactId);
  const slot = text(raw?.slot) as SpatialDepthMeshSlot | undefined;
  const maxBytes = finite(raw?.maxBytes);
  const expiresAt = text(raw?.expiresAt);
  const allowedMimeTypes = Array.isArray(raw?.allowedMimeTypes)
    ? raw.allowedMimeTypes.filter((item): item is string => typeof item === "string")
    : [];
  const expectedSha256Hex = text(raw?.expectedSha256Hex);
  if (
    raw?.purpose !== purpose ||
    !grantToken ||
    !artifactId ||
    !slot ||
    !Number.isInteger(maxBytes) ||
    (maxBytes ?? 0) < 1 ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    allowedMimeTypes.length !== 1 ||
    (expectedSha256Hex !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256Hex))
  )
    return undefined;
  const mime = allowedMimeTypes[0]!;
  const correctMime =
    purpose === "output_upload"
      ? OUTPUT_MIME[slot] === mime
      : slot === "source_image"
        ? mime === "image/png" || mime === "image/jpeg"
        : slot === "depth_adapter" && mime === "application/octet-stream";
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

function calibration(value: unknown): DepthMeshManualCalibration | undefined {
  const raw = record(value);
  const vanishingPointNormalized = point(raw?.vanishingPointNormalized);
  const depth = record(raw?.relativeDepthRange);
  if (
    !raw ||
    !Number.isInteger(raw.sourceWidthPx) ||
    !Number.isInteger(raw.sourceHeightPx) ||
    Number(raw.sourceWidthPx) < 1 ||
    Number(raw.sourceHeightPx) < 1 ||
    raw.orientationNormalized !== true ||
    !unit(raw.horizonYNormalized) ||
    !vanishingPointNormalized ||
    !(
      typeof raw.focalLengthMm === "number" &&
      raw.focalLengthMm >= 8 &&
      raw.focalLengthMm <= 300
    ) ||
    !(
      typeof raw.sensorWidthMm === "number" &&
      raw.sensorWidthMm >= 4 &&
      raw.sensorWidthMm <= 100
    ) ||
    !depth ||
    !(typeof depth.near === "number" && depth.near > 0) ||
    !(typeof depth.far === "number" && depth.far > depth.near && depth.far <= 100) ||
    !Number.isInteger(raw.gridResolution) ||
    Number(raw.gridResolution) < 8 ||
    Number(raw.gridResolution) > 64 ||
    !unit(raw.confidence) ||
    !Array.isArray(raw.walkableRegionNormalized) ||
    raw.walkableRegionNormalized.length < 3 ||
    raw.walkableRegionNormalized.length > 32
  )
    return undefined;
  const walkableRegionNormalized = raw.walkableRegionNormalized.map(point);
  if (walkableRegionNormalized.some((item) => !item)) return undefined;
  return {
    sourceWidthPx: raw.sourceWidthPx as number,
    sourceHeightPx: raw.sourceHeightPx as number,
    orientationNormalized: true,
    horizonYNormalized: raw.horizonYNormalized as number,
    vanishingPointNormalized,
    walkableRegionNormalized: walkableRegionNormalized as Array<{ x: number; y: number }>,
    focalLengthMm: raw.focalLengthMm as number,
    sensorWidthMm: raw.sensorWidthMm as number,
    relativeDepthRange: { near: depth.near as number, far: depth.far as number },
    gridResolution: raw.gridResolution as number,
    confidence: raw.confidence as number,
  };
}

function depthAdapter(value: unknown): SpatialDepthAdapterMetadata | undefined {
  const raw = record(value);
  const componentManifestDigest = text(raw?.componentManifestDigest);
  const checkpointDigests = Array.isArray(raw?.checkpointDigests)
    ? raw.checkpointDigests.filter(
        (item): item is string => typeof item === "string" && /^sha256:[0-9a-f]{64}$/.test(item),
      )
    : [];
  const noticeRefs = Array.isArray(raw?.noticeRefs)
    ? raw.noticeRefs.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : [];
  if (
    raw?.contractVersion !== DEPTH_ADAPTER_CONTRACT_VERSION ||
    (raw.encoding !== "normalized_depth_u16le" &&
      raw.encoding !== "normalized_inverse_depth_u16le") ||
    !Number.isInteger(raw.width) ||
    !Number.isInteger(raw.height) ||
    Number(raw.width) < 2 ||
    Number(raw.height) < 2 ||
    Number(raw.width) * Number(raw.height) > 16_777_216 ||
    !unit(raw.confidence) ||
    !componentManifestDigest ||
    !/^sha256:[0-9a-f]{64}$/.test(componentManifestDigest) ||
    checkpointDigests.length !== (raw.checkpointDigests as unknown[])?.length ||
    noticeRefs.length < 1 ||
    noticeRefs.length !== (raw.noticeRefs as unknown[])?.length
  )
    return undefined;
  return {
    contractVersion: DEPTH_ADAPTER_CONTRACT_VERSION,
    encoding: raw.encoding,
    width: raw.width as number,
    height: raw.height as number,
    confidence: raw.confidence as number,
    componentManifestDigest,
    checkpointDigests,
    noticeRefs,
  };
}

function scaleAnchor(value: unknown): DepthMeshScaleAnchor | undefined {
  const raw = record(value);
  const evidenceRef = text(raw?.evidenceRef);
  const fromNormalized = point(raw?.fromNormalized);
  const toNormalized = point(raw?.toNormalized);
  if (
    !raw ||
    (raw.kind !== "known_distance" && raw.kind !== "known_height") ||
    !(typeof raw.meters === "number" && raw.meters > 0 && raw.meters <= 100000) ||
    !unit(raw.confidence) ||
    raw.confidence < 0.5 ||
    !evidenceRef ||
    !fromNormalized ||
    !toNormalized ||
    Math.hypot(fromNormalized.x - toNormalized.x, fromNormalized.y - toNormalized.y) < 0.01
  )
    return undefined;
  return {
    kind: raw.kind,
    meters: raw.meters,
    confidence: raw.confidence,
    evidenceRef,
    fromNormalized,
    toNormalized,
  };
}

export function parseSpatialEnvironmentDepthMeshRuntimeRequest(
  value: unknown,
): SpatialEnvironmentDepthMeshRuntimeRequest | null {
  const raw = record(value);
  if (
    raw?.kind !== "media_studio.spatial_environment_depth_mesh" ||
    raw.contractVersion !== DEPTH_MESH_CONTRACT_VERSION ||
    "sourceImageBase64" in raw ||
    "depthBytesBase64" in raw ||
    "glbBase64" in raw ||
    "bytes" in raw ||
    "url" in raw
  )
    return null;
  const identity = {
    workspaceId: text(raw.workspaceId),
    runtimeId: text(raw.runtimeId),
    taskId: text(raw.taskId),
    materializationId: text(raw.materializationId),
    requestFingerprint: text(raw.requestFingerprint),
    executionFingerprint: text(raw.executionFingerprint),
    dispatchAttemptId: text(raw.dispatchAttemptId),
    leaseExpiresAt: text(raw.leaseExpiresAt),
  };
  if (Object.values(identity).some((entry) => !entry)) return null;
  const sequence = finite(raw.sequence);
  const attempt = finite(raw.attempt);
  const sourceGrant = grant(raw.sourceGrant, "source_download");
  const parsedCalibration = calibration(raw.calibration);
  if (
    !Number.isInteger(sequence) ||
    !Number.isInteger(attempt) ||
    !sourceGrant ||
    sourceGrant.slot !== "source_image" ||
    !parsedCalibration ||
    !Array.isArray(raw.outputUploadGrants) ||
    raw.outputUploadGrants.length !== 4
  )
    return null;
  const outputs = raw.outputUploadGrants.map((item) => grant(item, "output_upload"));
  if (
    outputs.some((item) => !item) ||
    new Set(outputs.map((item) => item!.slot)).size !== 4 ||
    Object.keys(OUTPUT_MIME).some((slot) => !outputs.some((item) => item?.slot === slot))
  )
    return null;
  const parsedAdapter = raw.depthAdapter === undefined ? undefined : depthAdapter(raw.depthAdapter);
  const parsedDepthGrant =
    raw.depthGrant === undefined ? undefined : grant(raw.depthGrant, "source_download");
  if (
    Boolean(parsedAdapter) !== Boolean(parsedDepthGrant) ||
    (parsedDepthGrant && parsedDepthGrant.slot !== "depth_adapter") ||
    (parsedAdapter &&
      parsedDepthGrant &&
      parsedDepthGrant.maxBytes !== parsedAdapter.width * parsedAdapter.height * 2)
  )
    return null;
  const parsedScaleAnchor =
    raw.scaleAnchor === undefined ? undefined : scaleAnchor(raw.scaleAnchor);
  if (raw.scaleAnchor !== undefined && !parsedScaleAnchor) return null;
  return {
    kind: "media_studio.spatial_environment_depth_mesh",
    contractVersion: DEPTH_MESH_CONTRACT_VERSION,
    workspaceId: identity.workspaceId!,
    runtimeId: identity.runtimeId!,
    taskId: identity.taskId!,
    materializationId: identity.materializationId!,
    requestFingerprint: identity.requestFingerprint!,
    executionFingerprint: identity.executionFingerprint!,
    dispatchAttemptId: identity.dispatchAttemptId!,
    sequence: sequence!,
    attempt: attempt!,
    leaseExpiresAt: identity.leaseExpiresAt!,
    sourceGrant,
    ...(parsedDepthGrant ? { depthGrant: parsedDepthGrant } : {}),
    outputUploadGrants: outputs as SpatialDepthMeshGrant[],
    calibration: parsedCalibration,
    ...(parsedAdapter ? { depthAdapter: parsedAdapter } : {}),
    ...(parsedScaleAnchor ? { scaleAnchor: parsedScaleAnchor } : {}),
  };
}

export function executeSpatialEnvironmentDepthMeshRuntimeRequest(
  input: SpatialEnvironmentDepthMeshRuntimeRequest,
  executor: SpatialEnvironmentDepthMeshRuntimeExecutor,
): Promise<SpatialEnvironmentDepthMeshRuntimeResult> {
  return Promise.resolve(executor.dispatch(input));
}

export type MediaStudioSpatialEnvironmentDepthMeshHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  maxBodyBytes?: number;
  executor: SpatialEnvironmentDepthMeshRuntimeExecutor;
};

function resolveConnectAuth(req: IncomingMessage) {
  const token = getBearerToken(req);
  const password = getHeader(req, "x-wisclaw-gateway-password");
  if (token && password) return { token, password };
  if (token) return { token };
  if (password) return { password };
  return null;
}

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioSpatialEnvironmentDepthMeshHttpOptions,
): Promise<boolean> {
  const connectAuth = resolveConnectAuth(req);
  if (connectAuth?.token && connectAuth?.password) {
    sendInvalidRequest(
      res,
      "Spatial depth mesh accepts either bearer token or gateway password, not both",
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

export async function handleMediaStudioSpatialEnvironmentDepthMeshHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioSpatialEnvironmentDepthMeshHttpOptions,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== MEDIA_STUDIO_SPATIAL_ENVIRONMENT_DEPTH_MESH_RENDER_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  if (!(await authorizeRequest(req, res, options))) return true;
  const body = await readJsonBodyOrError(req, res, options.maxBodyBytes ?? 512 * 1024);
  if (body === undefined) return true;
  const input = parseSpatialEnvironmentDepthMeshRuntimeRequest(body);
  if (!input) {
    sendInvalidRequest(res, "Invalid deterministic depth mesh request");
    return true;
  }
  try {
    sendJson(
      res,
      202,
      await executeSpatialEnvironmentDepthMeshRuntimeRequest(input, options.executor),
    );
  } catch {
    sendJson(res, 500, {
      ok: false,
      code: "depth_mesh_dispatch_failed",
      message: "deterministic depth mesh dispatch failed",
    });
  }
  return true;
}
