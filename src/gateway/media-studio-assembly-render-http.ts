/**
 * Gate 1R — Media Studio assembly-render runtime HTTP shell.
 *
 * Control API relays encode intent to:
 *   POST /v1/runtime/media-studio/assembly-render
 *   POST /v1/runtime/media-studio/assembly-render/cancel
 *
 * Honesty:
 * - This gateway never encodes video by itself without an injected executor.
 * - Default path is fail-closed (accepted=false) when no encoder is configured.
 * - FinalMaster is only created when runtime calls Control API complete callback.
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

export const MEDIA_STUDIO_ASSEMBLY_RENDER_PATH =
  "/v1/runtime/media-studio/assembly-render" as const;
export const MEDIA_STUDIO_ASSEMBLY_RENDER_CANCEL_PATH =
  "/v1/runtime/media-studio/assembly-render/cancel" as const;

const MAX_BODY_BYTES = 256 * 1024;

export type MediaStudioAssemblyRenderTimelineItem = {
  shotId: string;
  artifactId: string;
  durationSec?: number;
};

export type MediaStudioAssemblyRenderDispatch = {
  kind: "media_studio.assembly_render";
  workspaceId: string;
  projectId: string;
  assemblyId: string;
  renderId: string;
  timeline: MediaStudioAssemblyRenderTimelineItem[];
  dispatchEpoch?: number;
  dispatchAttemptId?: string;
  taskCenterTaskId?: string;
  callbackContract?: {
    progressPath?: string;
    completePath?: string;
  };
};

export type MediaStudioAssemblyRenderCancel = {
  kind: "media_studio.assembly_render.cancel";
  workspaceId: string;
  renderId: string;
  dispatchEpoch?: number;
  dispatchAttemptId?: string;
};

export type MediaStudioAssemblyRenderAcceptResult = {
  accepted: boolean;
  messageKey?: string;
};

export type MediaStudioAssemblyRenderCancelResult = {
  cancelled: boolean;
  messageKey?: string;
};

export type MediaStudioAssemblyRenderHttpExecutor = {
  dispatch(
    input: MediaStudioAssemblyRenderDispatch,
  ):
    | Promise<MediaStudioAssemblyRenderAcceptResult>
    | MediaStudioAssemblyRenderAcceptResult;
  cancel?(
    input: MediaStudioAssemblyRenderCancel,
  ):
    | Promise<MediaStudioAssemblyRenderCancelResult>
    | MediaStudioAssemblyRenderCancelResult;
};

export type MediaStudioAssemblyRenderHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  maxBodyBytes?: number;
  executor?: MediaStudioAssemblyRenderHttpExecutor;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** Pure fail-closed parser for Control API assembly-render relay body. */
export function parseAssemblyRenderDispatch(
  body: unknown,
): MediaStudioAssemblyRenderDispatch | null {
  if (!isRecord(body)) return null;
  if (body.kind !== "media_studio.assembly_render") return null;
  const workspaceId = asNonEmptyString(body.workspaceId);
  const projectId = asNonEmptyString(body.projectId);
  const assemblyId = asNonEmptyString(body.assemblyId);
  const renderId = asNonEmptyString(body.renderId);
  if (!workspaceId || !projectId || !assemblyId || !renderId) return null;
  if (!Array.isArray(body.timeline) || body.timeline.length === 0) return null;
  const timeline: MediaStudioAssemblyRenderTimelineItem[] = [];
  for (const row of body.timeline) {
    if (!isRecord(row)) return null;
    const shotId = asNonEmptyString(row.shotId);
    const artifactId = asNonEmptyString(row.artifactId);
    if (!shotId || !artifactId) return null;
    const durationSec = asPositiveNumber(row.durationSec);
    timeline.push({
      shotId,
      artifactId,
      ...(durationSec != null && durationSec > 0 ? { durationSec } : {}),
    });
  }
  const dispatchEpoch = asPositiveNumber(body.dispatchEpoch);
  const dispatchAttemptId = asNonEmptyString(body.dispatchAttemptId);
  const taskCenterTaskId = asNonEmptyString(body.taskCenterTaskId);
  let callbackContract: MediaStudioAssemblyRenderDispatch["callbackContract"];
  if (isRecord(body.callbackContract)) {
    callbackContract = {
      ...(asNonEmptyString(body.callbackContract.progressPath)
        ? { progressPath: asNonEmptyString(body.callbackContract.progressPath) }
        : {}),
      ...(asNonEmptyString(body.callbackContract.completePath)
        ? { completePath: asNonEmptyString(body.callbackContract.completePath) }
        : {}),
    };
  }
  return {
    kind: "media_studio.assembly_render",
    workspaceId,
    projectId,
    assemblyId,
    renderId,
    timeline,
    ...(dispatchEpoch != null ? { dispatchEpoch } : {}),
    ...(dispatchAttemptId ? { dispatchAttemptId } : {}),
    ...(taskCenterTaskId ? { taskCenterTaskId } : {}),
    ...(callbackContract ? { callbackContract } : {}),
  };
}

export function parseAssemblyRenderCancel(
  body: unknown,
): MediaStudioAssemblyRenderCancel | null {
  if (!isRecord(body)) return null;
  if (body.kind !== "media_studio.assembly_render.cancel") return null;
  const workspaceId = asNonEmptyString(body.workspaceId);
  const renderId = asNonEmptyString(body.renderId);
  if (!workspaceId || !renderId) return null;
  const dispatchEpoch = asPositiveNumber(body.dispatchEpoch);
  const dispatchAttemptId = asNonEmptyString(body.dispatchAttemptId);
  return {
    kind: "media_studio.assembly_render.cancel",
    workspaceId,
    renderId,
    ...(dispatchEpoch != null ? { dispatchEpoch } : {}),
    ...(dispatchAttemptId ? { dispatchAttemptId } : {}),
  };
}

function resolveConnectAuth(
  req: IncomingMessage,
): { token?: string; password?: string } | null {
  const token = getBearerToken(req);
  const password = getHeader(req, "x-wisclaw-gateway-password");
  if (token && password) {
    return { token, password };
  }
  if (token) return { token };
  if (password) return { password };
  return null;
}

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioAssemblyRenderHttpOptions,
): Promise<boolean> {
  const connectAuth = resolveConnectAuth(req);
  if (connectAuth?.token && connectAuth?.password) {
    sendInvalidRequest(
      res,
      "Assembly-render accepts either bearer token or gateway password, not both",
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

function normalizeAccept(
  result: unknown,
): MediaStudioAssemblyRenderAcceptResult {
  if (!isRecord(result)) {
    return {
      accepted: false,
      messageKey: "media_studio.render.runtime_invalid_result",
    };
  }
  if (result.accepted === true) {
    return { accepted: true };
  }
  return {
    accepted: false,
    messageKey:
      asNonEmptyString(result.messageKey) ??
      "media_studio.render.runtime_rejected",
  };
}

function normalizeCancel(
  result: unknown,
): MediaStudioAssemblyRenderCancelResult {
  if (!isRecord(result)) {
    return {
      cancelled: false,
      messageKey: "media_studio.render.runtime_invalid_result",
    };
  }
  if (result.cancelled === true) {
    return { cancelled: true };
  }
  return {
    cancelled: false,
    messageKey:
      asNonEmptyString(result.messageKey) ??
      "media_studio.render.runtime_cancel_rejected",
  };
}

/**
 * Default fail-closed: gateway has no FFmpeg/encoder injected.
 * Control API relay treats non-2xx OR accepted=false as dispatch failure.
 */
function defaultDispatchResult(): MediaStudioAssemblyRenderAcceptResult {
  return {
    accepted: false,
    messageKey: "media_studio.render.runtime_executor_not_configured",
  };
}

export async function handleMediaStudioAssemblyRenderHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioAssemblyRenderHttpOptions,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const isDispatch = path === MEDIA_STUDIO_ASSEMBLY_RENDER_PATH;
  const isCancel = path === MEDIA_STUDIO_ASSEMBLY_RENDER_CANCEL_PATH;
  if (!isDispatch && !isCancel) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  const authorized = await authorizeRequest(req, res, options);
  if (!authorized) {
    return true;
  }
  const body = await readJsonBodyOrError(
    req,
    res,
    options.maxBodyBytes ?? MAX_BODY_BYTES,
  );
  if (body === undefined) {
    return true;
  }

  if (isCancel) {
    const cancel = parseAssemblyRenderCancel(body);
    if (!cancel) {
      sendInvalidRequest(res, "Invalid media-studio assembly-render cancel");
      return true;
    }
    if (!options.executor?.cancel) {
      // Best-effort: no executor → nothing to cancel; still 200 for honesty.
      sendJson(res, 200, {
        cancelled: false,
        messageKey: "media_studio.render.runtime_executor_not_configured",
      });
      return true;
    }
    const result = await options.executor.cancel(cancel);
    sendJson(res, 200, normalizeCancel(result));
    return true;
  }

  const dispatch = parseAssemblyRenderDispatch(body);
  if (!dispatch) {
    sendInvalidRequest(res, "Invalid media-studio assembly-render dispatch");
    return true;
  }
  const result = options.executor
    ? await options.executor.dispatch(dispatch)
    : defaultDispatchResult();
  const normalized = normalizeAccept(result);
  // Use 200 for both accept/reject so Control API can parse messageKey;
  // accepted=false is the business fail-closed signal.
  sendJson(res, 200, normalized);
  return true;
}
