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
  asNonEmptyString,
  isRecord,
  parseDispatch,
  rejectSmuggledSensitiveMaterial,
} from "./media-gen-runtime-dispatch.js";

export const MEDIA_GEN_RUNTIME_DISPATCH_PATH = "/v1/runtime/media-gen/dispatch";

const MAX_BODY_BYTES = 256 * 1024;
const STATUSES = new Set([
  "draft",
  "queued",
  "submitting",
  "processing",
  "succeeded",
  "failed",
  "timeout",
  "canceled",
]);
const FAILURE_REASONS = new Set([
  "auth",
  "quota",
  "vendor_rejected",
  "vendor_failed",
  "content_blocked",
  "download_failed",
  "internal",
]);

// CP3 multi-asset reference role (Multi_Asset_Reference_Design_CP3.md §3.1) —
// LOCAL copy of the contracts allow-list (this gateway is a vendored upstream and
// does not depend on @wisclaw/contracts). Fail-closed: an unknown wire role is
// rejected by the dispatch parser, never silently coerced.
export type MediaGenReferenceRole =
  | "subject"
  | "style"
  | "first_frame"
  | "last_frame"
  | "video"
  | "pose_face";

export type MediaGenRuntimeConsent = {
  subjectType: "portrait" | "voice" | "pose_face" | "other";
  authorized: boolean;
  retentionDays?: number;
  note?: string;
};

export type MediaGenRuntimeReference = {
  kind: "artifact" | "runtime_local";
  artifactId?: string;
  runtimeLocalRef?: string;
  sha256?: string;
  mimeType?: string;
};

// CP3 multi-slot reference: a by-reference source tagged with its role/ordinal and
// (for sensitive subjects) its own per-slot consent. Mutually exclusive with the
// singular `reference` on a dispatch.
export type MediaGenReferenceSlot = MediaGenRuntimeReference & {
  role?: MediaGenReferenceRole;
  ordinal?: number;
  consent?: MediaGenRuntimeConsent;
};

export type MediaGenRuntimeDispatch = {
  op: "submit" | "poll" | "cancel" | "retry";
  taskId: string;
  workspaceId: string;
  correlationId: string;
  presetId: string;
  mode: "text2video" | "image2video";
  prompt?: string;
  reference?: MediaGenRuntimeReference;
  references?: MediaGenReferenceSlot[];
  durationSec?: number;
  resolution?: string;
  params?: Record<string, unknown>;
  consent?: MediaGenRuntimeConsent;
  consentRef?: string;
  // CP3 per-slot consent receipts — the control plane persists EACH reference
  // slot's consent and passes the full set so this gateway stamps the SAME refs
  // onto its snapshot (never inventing a local placeholder). LOCAL mirror of the
  // contract field (this vendored gateway does not depend on @wisclaw/contracts).
  consentRefs?: string[];
  runtimeJobId?: string;
};

export type MediaGenRuntimeResult = {
  taskId: string;
  workspaceId: string;
  correlationId: string;
  status:
    | "draft"
    | "queued"
    | "submitting"
    | "processing"
    | "succeeded"
    | "failed"
    | "timeout"
    | "canceled";
  runtimeJobId?: string;
  failureReason?:
    | "auth"
    | "quota"
    | "vendor_rejected"
    | "vendor_failed"
    | "content_blocked"
    | "download_failed"
    | "internal";
  failureMessage?: string;
  artifact?: unknown;
  snapshot?: unknown;
};

export type MediaGenRuntimeHttpExecutor = {
  dispatch(input: MediaGenRuntimeDispatch): Promise<MediaGenRuntimeResult> | MediaGenRuntimeResult;
};

export type MediaGenRuntimeHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  maxBodyBytes?: number;
  executor?: MediaGenRuntimeHttpExecutor;
};

function productizedFailure(
  dispatch: MediaGenRuntimeDispatch,
  failureReason: MediaGenRuntimeResult["failureReason"],
  failureMessage: string,
): MediaGenRuntimeResult {
  return {
    taskId: dispatch.taskId,
    workspaceId: dispatch.workspaceId,
    correlationId: dispatch.correlationId,
    status: "failed",
    failureReason,
    failureMessage,
  };
}

function validateExecutionCompliance(dispatch: MediaGenRuntimeDispatch): MediaGenRuntimeResult | null {
  if (dispatch.op !== "submit" && dispatch.op !== "retry") {
    return null;
  }
  if (dispatch.mode !== "image2video") {
    return null;
  }
  // CP3 §8: a multi-slot dispatch carries its sources + per-slot consent in
  // `references[]`; the executor resolves each slot and re-checks consent per slot.
  // The coarse single-reference gate below does not apply to it.
  if (dispatch.references && dispatch.references.length > 0) {
    return null;
  }
  if (!dispatch.reference || (dispatch.consent?.authorized !== true && !dispatch.consentRef)) {
    return productizedFailure(
      dispatch,
      "content_blocked",
      "image2video requires a source reference and authorized subject consent",
    );
  }
  return null;
}

function defaultExecutor(dispatch: MediaGenRuntimeDispatch): MediaGenRuntimeResult {
  return productizedFailure(
    dispatch,
    "internal",
    "OpenClaw media-generation runtime executor is not configured",
  );
}

function normalizeResult(
  dispatch: MediaGenRuntimeDispatch,
  result: unknown,
): MediaGenRuntimeResult {
  if (!isRecord(result)) {
    return productizedFailure(dispatch, "internal", "runtime executor returned an invalid result");
  }
  const status = asNonEmptyString(result.status);
  const taskId = asNonEmptyString(result.taskId);
  const workspaceId = asNonEmptyString(result.workspaceId);
  const correlationId = asNonEmptyString(result.correlationId);
  const failureReason = result.failureReason;
  if (
    !status ||
    !STATUSES.has(status) ||
    taskId !== dispatch.taskId ||
    workspaceId !== dispatch.workspaceId ||
    correlationId !== dispatch.correlationId ||
    (failureReason !== undefined && !FAILURE_REASONS.has(String(failureReason)))
  ) {
    return productizedFailure(dispatch, "internal", "runtime executor returned an invalid result");
  }
  return {
    taskId,
    workspaceId,
    correlationId,
    status: status as MediaGenRuntimeResult["status"],
    runtimeJobId: asNonEmptyString(result.runtimeJobId) ?? undefined,
    artifact: result.artifact,
    failureReason: failureReason as MediaGenRuntimeResult["failureReason"] | undefined,
    failureMessage: asNonEmptyString(result.failureMessage) ?? undefined,
    snapshot: result.snapshot,
  };
}

function resolveConnectAuth(req: IncomingMessage): { token?: string; password?: string } | null {
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

async function authorizeMediaGenRuntimeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaGenRuntimeHttpOptions,
): Promise<boolean> {
  const connectAuth = resolveConnectAuth(req);
  if (connectAuth?.token && connectAuth?.password) {
    sendInvalidRequest(
      res,
      "Media-generation runtime dispatch accepts either bearer token or gateway password, not both",
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

export async function handleMediaGenRuntimeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaGenRuntimeHttpOptions,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== MEDIA_GEN_RUNTIME_DISPATCH_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  const authorized = await authorizeMediaGenRuntimeRequest(req, res, options);
  if (!authorized) {
    return true;
  }
  const body = await readJsonBodyOrError(req, res, options.maxBodyBytes ?? MAX_BODY_BYTES);
  if (body === undefined) {
    return true;
  }
  const dispatch = parseDispatch(body);
  if (!dispatch) {
    sendInvalidRequest(res, "Invalid media-generation runtime dispatch");
    return true;
  }
  const rejectedPath = rejectSmuggledSensitiveMaterial(dispatch);
  if (rejectedPath) {
    sendJson(res, 400, {
      error: {
        message: "Media-generation runtime dispatch contains forbidden sensitive material",
        type: "invalid_request_error",
        path: rejectedPath,
      },
    });
    return true;
  }
  const complianceFailure = validateExecutionCompliance(dispatch);
  if (complianceFailure) {
    sendJson(res, 200, complianceFailure);
    return true;
  }
  const result = await (options.executor?.dispatch(dispatch) ?? defaultExecutor(dispatch));
  sendJson(res, 200, normalizeResult(dispatch, result));
  return true;
}
