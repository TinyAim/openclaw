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
import type { MediaGenRuntimeFrozenPlanV2 } from "./media-gen-runtime/frozen-plan.js";
import {
  parseProviderObservation,
  type MediaGenProviderRuntimeObservation,
} from "./media-gen-runtime/provider-observation.js";

export const MEDIA_GEN_RUNTIME_DISPATCH_PATH = "/v1/runtime/media-gen/dispatch";

const MAX_BODY_BYTES = 256 * 1024;
const SAFE_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const STATUSES = new Set(["processing", "succeeded", "failed", "canceled", "submission_unknown"]);
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
  | "source_video"
  | "motion"
  | "voice"
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
  /** Safe Control-plane authority anchor; execution resolves runtimeLocalRef only. */
  companionArtifactId?: string;
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
  op: "submit" | "poll" | "cancel" | "retry" | "reconcile";
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
  executionAttempt?: number;
  frozenPlanDigest?: string;
  frozenPlan?: MediaGenRuntimeFrozenPlanV2;
  spatialInputEnvelope?: MediaGenRuntimeSpatialInputEnvelope;
};

export type MediaGenRuntimeSpatialInputReference = {
  assetRefId?: string;
  artifactId: string;
  checksum: string;
  role: string;
  ordinal: number;
};

export type MediaGenRuntimeSpatialInputEnvelope = {
  schemaVersion: 1;
  envelopeDigest: string;
  references: readonly MediaGenRuntimeSpatialInputReference[];
};

export type MediaGenRuntimeSpatialInputAcceptance = MediaGenRuntimeSpatialInputEnvelope & {
  executionAttempt: number;
  frozenPlanDigest: string;
  runtimeJobId: string;
  providerRequestDigest: string;
};

export type MediaGenRuntimeResult = {
  taskId: string;
  workspaceId: string;
  correlationId: string;
  status: "processing" | "succeeded" | "failed" | "canceled" | "submission_unknown";
  runtimeStopOutcome?: MediaGenRuntimeStopOutcome;
  runtimeJobId?: string;
  providerRequestDigest?: string;
  providerObservation?: MediaGenProviderRuntimeObservation;
  spatialInputAcceptance?: MediaGenRuntimeSpatialInputAcceptance;
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

export type MediaGenRuntimeStopOutcome =
  | { state: "not_requested"; reasonCode: "no_runtime_dispatch" }
  | { state: "requested"; reasonCode: "runtime_stop_requested" }
  | { state: "confirmed"; reasonCode: "runtime_confirmed" }
  | { state: "not_supported"; reasonCode: "adapter_not_supported" }
  | { state: "failed"; reasonCode: "adapter_rejected" }
  | { state: "unknown"; reasonCode: "transport_uncertain" };

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

function validateExecutionCompliance(
  dispatch: MediaGenRuntimeDispatch,
): MediaGenRuntimeResult | null {
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

function isVerifiedArtifactReceipt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set(["artifactId", "sha256", "durationSec", "resolution", "mimeType"]);
  return (
    !Object.keys(value).some((key) => !allowed.has(key)) &&
    typeof value.artifactId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,299}$/u.test(value.artifactId) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    typeof value.mimeType === "string" &&
    /^(?:video|image|audio)\/[a-zA-Z0-9.+-]+$/u.test(value.mimeType)
  );
}

function isRuntimeComplianceSnapshot(value: unknown): boolean {
  return isRecord(value) && value.executionOwner === "user_runtime";
}

function parseRuntimeStopOutcome(value: unknown): MediaGenRuntimeStopOutcome | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;
  const pair = `${String(value.state)}:${String(value.reasonCode)}`;
  return [
    "not_requested:no_runtime_dispatch",
    "requested:runtime_stop_requested",
    "confirmed:runtime_confirmed",
    "not_supported:adapter_not_supported",
    "failed:adapter_rejected",
    "unknown:transport_uncertain",
  ].includes(pair)
    ? (value as MediaGenRuntimeStopOutcome)
    : undefined;
}

function parseSpatialInputAcceptance(
  value: unknown,
): MediaGenRuntimeSpatialInputAcceptance | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "schemaVersion",
    "envelopeDigest",
    "references",
    "executionAttempt",
    "frozenPlanDigest",
    "runtimeJobId",
    "providerRequestDigest",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.envelopeDigest !== "string" ||
    !/^spa_env:sha256:[a-f0-9]{64}$/u.test(value.envelopeDigest) ||
    !Array.isArray(value.references) ||
    value.references.length === 0 ||
    typeof value.executionAttempt !== "number" ||
    !Number.isSafeInteger(value.executionAttempt) ||
    value.executionAttempt < 1 ||
    typeof value.frozenPlanDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.frozenPlanDigest) ||
    typeof value.runtimeJobId !== "string" ||
    !value.runtimeJobId.trim() ||
    typeof value.providerRequestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.providerRequestDigest)
  )
    return undefined;
  const references: MediaGenRuntimeSpatialInputReference[] = [];
  const identities = new Set<string>();
  for (const raw of value.references) {
    if (!isRecord(raw)) return undefined;
    const keys = new Set(["assetRefId", "artifactId", "checksum", "role", "ordinal"]);
    if (
      Object.keys(raw).some((key) => !keys.has(key)) ||
      (raw.assetRefId !== undefined &&
        (typeof raw.assetRefId !== "string" || !raw.assetRefId.trim())) ||
      typeof raw.artifactId !== "string" ||
      !raw.artifactId.trim() ||
      typeof raw.checksum !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(raw.checksum) ||
      typeof raw.role !== "string" ||
      !raw.role.trim() ||
      typeof raw.ordinal !== "number" ||
      !Number.isSafeInteger(raw.ordinal) ||
      raw.ordinal < 0
    )
      return undefined;
    const identity = `${raw.role}\u0000${raw.ordinal}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    references.push({
      ...(raw.assetRefId ? { assetRefId: raw.assetRefId } : {}),
      artifactId: raw.artifactId,
      checksum: raw.checksum,
      role: raw.role,
      ordinal: raw.ordinal,
    });
  }
  return {
    schemaVersion: 1,
    envelopeDigest: value.envelopeDigest,
    references,
    executionAttempt: value.executionAttempt,
    frozenPlanDigest: value.frozenPlanDigest,
    runtimeJobId: value.runtimeJobId,
    providerRequestDigest: value.providerRequestDigest,
  };
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
  const runtimeJobId = asNonEmptyString(result.runtimeJobId);
  const providerRequestDigest = asNonEmptyString(result.providerRequestDigest);
  const spatialInputAcceptance =
    result.spatialInputAcceptance === undefined
      ? undefined
      : parseSpatialInputAcceptance(result.spatialInputAcceptance);
  const providerObservation =
    result.providerObservation === undefined
      ? undefined
      : parseProviderObservation(result.providerObservation);
  const runtimeStopOutcome =
    result.runtimeStopOutcome === undefined
      ? undefined
      : parseRuntimeStopOutcome(result.runtimeStopOutcome);
  const reconcileStopObservationMatches =
    providerObservation?.operation === "reconcile" && runtimeStopOutcome
      ? runtimeStopOutcome.state === "confirmed"
        ? providerObservation.outcome === "canceled" ||
          providerObservation.outcome === "succeeded" ||
          providerObservation.outcome === "failed"
        : runtimeStopOutcome.state === "failed"
          ? providerObservation.outcome === "failed"
          : providerObservation.outcome === "processing" ||
            providerObservation.outcome === "submission_unknown"
      : undefined;
  const expectedObservationOutcome =
    providerObservation?.operation === "cancel" && runtimeStopOutcome
      ? runtimeStopOutcome.state === "confirmed"
        ? "canceled"
        : "processing"
      : status;
  if (
    !status ||
    !STATUSES.has(status) ||
    taskId !== dispatch.taskId ||
    workspaceId !== dispatch.workspaceId ||
    correlationId !== dispatch.correlationId ||
    (failureReason !== undefined &&
      (typeof failureReason !== "string" || !FAILURE_REASONS.has(failureReason))) ||
    (result.providerRequestDigest !== undefined &&
      (!providerRequestDigest || !/^sha256:[a-f0-9]{64}$/u.test(providerRequestDigest))) ||
    (result.providerObservation !== undefined && !providerObservation) ||
    (result.runtimeStopOutcome !== undefined && !runtimeStopOutcome) ||
    (result.spatialInputAcceptance !== undefined && !spatialInputAcceptance) ||
    (spatialInputAcceptance !== undefined &&
      ((status !== "processing" && status !== "succeeded") ||
        runtimeJobId !== spatialInputAcceptance.runtimeJobId ||
        providerRequestDigest !== spatialInputAcceptance.providerRequestDigest ||
        providerObservation?.operation !== "submit")) ||
    (status === "processing" && !runtimeJobId) ||
    (runtimeStopOutcome !== undefined && status !== "canceled") ||
    (runtimeStopOutcome !== undefined &&
      runtimeStopOutcome.state !== "not_requested" &&
      !runtimeJobId) ||
    (status === "failed" && failureReason === undefined) ||
    (status !== "succeeded" && result.artifact !== undefined) ||
    (providerObservation?.operation === "cancel" && !runtimeStopOutcome) ||
    reconcileStopObservationMatches === false ||
    (providerObservation != null &&
      reconcileStopObservationMatches === undefined &&
      providerObservation.outcome !== expectedObservationOutcome) ||
    (status === "succeeded" &&
      (!runtimeJobId ||
        !isVerifiedArtifactReceipt(result.artifact) ||
        !isRuntimeComplianceSnapshot(result.snapshot)))
  ) {
    return productizedFailure(dispatch, "internal", "runtime executor returned an invalid result");
  }
  return {
    taskId,
    workspaceId,
    correlationId,
    status: status as MediaGenRuntimeResult["status"],
    runtimeStopOutcome,
    runtimeJobId: runtimeJobId ?? undefined,
    providerRequestDigest: providerRequestDigest ?? undefined,
    providerObservation: providerObservation ?? undefined,
    spatialInputAcceptance,
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
