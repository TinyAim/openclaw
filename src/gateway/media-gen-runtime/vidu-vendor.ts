// Vidu runtime owner. New subject-reference work uses the exact Q1
// reference2video compiler. The legacy text/single-image paths remain readable
// for existing callers, but multi-reference requests must carry the frozen v2
// route so images are never sent to the semantically wrong img2video endpoint.
import { createHash } from "node:crypto";
import {
  providerObservation,
  type MediaGenProviderRuntimeOperation,
  type MediaGenProviderRuntimeOutcome,
} from "./provider-observation.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorInput,
  MediaGenRuntimeVendorJob,
} from "./types.js";
import {
  compileViduQ1ReferenceRequest,
  VIDU_Q1_MODEL_ID,
  VIDU_Q1_REFERENCE_ADAPTER_REVISION,
  VIDU_Q1_REFERENCE_ENDPOINT_ID,
  VIDU_Q1_REFERENCE_PROFILE_ID,
  VIDU_Q1_REFERENCE_ROUTE_ID,
} from "./vidu-q1-reference-compiler.js";
import {
  VIDU_Q1_T2V_ADAPTER_REVISION,
  VIDU_Q1_T2V_ENDPOINT_ID,
  VIDU_Q1_T2V_MODEL_ID,
  VIDU_Q1_T2V_PROFILE_ID,
  VIDU_Q1_T2V_ROUTE_ID,
} from "./vidu-q1-text2video-compiler.js";
import { submitViduQ1T2v, VIDU_Q1_T2V_JOB_PREFIX } from "./vidu-q1-text2video-vendor.js";

export const VIDU_DEFAULT_BASE_URL = "https://api.vidu.com/ent/v2";
const LEGACY_MODEL = "viduq1";

export type ViduRuntimeVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

type ViduCreateResponse = {
  task_id?: unknown;
  state?: unknown;
  code?: unknown;
  reason?: unknown;
  message?: unknown;
};

type ViduCreationsResponse = {
  state?: unknown;
  err_code?: unknown;
  code?: unknown;
  reason?: unknown;
  message?: unknown;
  creations?: unknown;
};

function authHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Token ${apiKey}`,
    "content-type": "application/json",
  };
}

function responseText(value: ViduCreateResponse | ViduCreationsResponse | null): string {
  if (!value) {
    return "";
  }
  return [value.code, value.reason, value.message, "err_code" in value ? value.err_code : undefined]
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map(String)
    .join(" ");
}

function looksLikeQuota(message: string): boolean {
  return /quota|credit|balance|rate.?limit|余额|配额|欠费/iu.test(message);
}

function looksLikeContentBlock(message: string): boolean {
  return /sensitive|moderation|policy|violat|审核|敏感|违规/iu.test(message);
}

function normalizedFailure(input: {
  status: number;
  body: ViduCreateResponse | ViduCreationsResponse | null;
  phase: "submit" | "task";
  vendorJobId?: string;
}): Extract<MediaGenRuntimeVendorJob, { state: "failed" }> {
  const text = responseText(input.body);
  const common = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (input.status === 401 || input.status === 403) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "Vidu credentials were rejected.",
    };
  }
  if (input.status === 429 || looksLikeQuota(text)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "Vidu quota or rate capacity is unavailable.",
    };
  }
  if (looksLikeContentBlock(text)) {
    return {
      state: "failed",
      ...common,
      reason: "content_blocked",
      message: "Vidu content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "Vidu rejected the documented create request."
        : "The Vidu task could not be reconciled.",
  };
}

function isExactReferencePlanCandidate(input: MediaGenRuntimeVendorInput): boolean {
  const plan = input.frozenPlan;
  return Boolean(
    plan &&
    (plan.adapterRevision === VIDU_Q1_REFERENCE_ADAPTER_REVISION ||
      plan.providerRouteRef.routeId === VIDU_Q1_REFERENCE_ROUTE_ID ||
      plan.capabilityProfileRef.profileId === VIDU_Q1_REFERENCE_PROFILE_ID),
  );
}

function isExactTextPlanCandidate(input: MediaGenRuntimeVendorInput): boolean {
  const plan = input.frozenPlan;
  return Boolean(
    input.mode === "text2video" &&
    plan &&
    (plan.adapterRevision === VIDU_Q1_T2V_ADAPTER_REVISION ||
      plan.providerRouteRef.routeId === VIDU_Q1_T2V_ROUTE_ID ||
      plan.capabilityProfileRef.profileId === VIDU_Q1_T2V_PROFILE_ID),
  );
}

function legacyRequest(
  input: MediaGenRuntimeVendorInput,
):
  | { ok: true; endpoint: "text2video" | "img2video"; body: Record<string, unknown> }
  | { ok: false; message: string } {
  if ((input.sources?.length ?? 0) > 0) {
    return {
      ok: false,
      message: "Vidu multi-reference requires a frozen exact reference2video plan.",
    };
  }
  if (input.mode === "image2video" && !input.source?.bytes) {
    return { ok: false, message: "Vidu image2video requires one resolved source image." };
  }
  const body: Record<string, unknown> = {
    model: (input.params?.model as string | undefined) ?? LEGACY_MODEL,
    prompt: input.prompt ?? "",
    duration: input.durationSec ?? 5,
    resolution: input.resolution ?? "720p",
    aspect_ratio: (input.params?.aspect_ratio as string | undefined) ?? "16:9",
  };
  if (input.source?.bytes) {
    body.images = [
      `data:${input.source.mimeType || "image/png"};base64,${input.source.bytes.toString("base64")}`,
    ];
  }
  return {
    ok: true,
    endpoint: input.mode === "image2video" ? "img2video" : "text2video",
    body,
  };
}

function httpsMediaRef(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstCreationUrl(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const url = httpsMediaRef((item as Record<string, unknown>).url);
      if (url) {
        return url;
      }
    }
  }
  return null;
}

type ExactObservationIdentity = { routeId: string; adapterRevision: string };

function withExactObservation(
  job: MediaGenRuntimeVendorJob,
  identity: ExactObservationIdentity,
  input: {
    operation: MediaGenProviderRuntimeOperation;
    outcome: MediaGenProviderRuntimeOutcome;
    startedAtMs: number;
    finishedAt: Date;
  },
): MediaGenRuntimeVendorJob {
  return {
    ...job,
    providerObservation: providerObservation({
      ...identity,
      ...input,
    }),
  };
}

export function createViduRuntimeVendor(options: ViduRuntimeVendorOptions): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? VIDU_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const exactJobs = new Set<string>();
  const referenceIdentity: ExactObservationIdentity = {
    routeId: VIDU_Q1_REFERENCE_ROUTE_ID,
    adapterRevision: VIDU_Q1_REFERENCE_ADAPTER_REVISION,
  };
  const textIdentity: ExactObservationIdentity = {
    routeId: VIDU_Q1_T2V_ROUTE_ID,
    adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
  };

  const observe = (
    identity: ExactObservationIdentity | null,
    job: MediaGenRuntimeVendorJob,
    operation: MediaGenProviderRuntimeOperation,
    outcome: MediaGenProviderRuntimeOutcome,
    startedAtMs: number,
  ): MediaGenRuntimeVendorJob =>
    identity
      ? withExactObservation(job, identity, {
          operation,
          outcome,
          startedAtMs,
          finishedAt: now(),
        })
      : job;

  const query = async (
    vendorJobId: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const isExactText = vendorJobId.startsWith(VIDU_Q1_T2V_JOB_PREFIX);
    const taskId = isExactText ? vendorJobId.slice(VIDU_Q1_T2V_JOB_PREFIX.length) : vendorJobId;
    const identity = isExactText ? textIdentity : exactJobs.has(taskId) ? referenceIdentity : null;
    const startedAtMs = now().getTime();
    if (!taskId) {
      return observe(
        identity,
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "The Vidu task receipt is invalid.",
        },
        operation,
        "failed",
        startedAtMs,
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/creations`, {
        method: "GET",
        headers: authHeaders(options.apiKey),
      });
    } catch {
      return observe(
        identity,
        { state: "processing", vendorJobId },
        operation,
        "processing",
        startedAtMs,
      );
    }
    const json = (await response.json().catch(() => null)) as ViduCreationsResponse | null;
    if (!response.ok) {
      return observe(
        identity,
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "task",
          vendorJobId,
        }),
        operation,
        "failed",
        startedAtMs,
      );
    }
    const state = typeof json?.state === "string" ? json.state : "";
    if (["created", "queueing", "processing"].includes(state)) {
      return observe(
        identity,
        { state: "processing", vendorJobId },
        operation,
        "processing",
        startedAtMs,
      );
    }
    if (state === "success") {
      const mediaRef = firstCreationUrl(json?.creations);
      const job: MediaGenRuntimeVendorJob = mediaRef
        ? {
            state: "succeeded",
            vendorJobId,
            output: {
              mediaRef,
              mimeType: "video/mp4",
              ...(identity ? { durationSec: 5, resolution: "1080p" } : {}),
            },
          }
        : {
            state: "failed",
            vendorJobId,
            reason: "download_failed",
            message: "Vidu completed without a retrievable HTTPS creation URL.",
          };
      return observe(identity, job, operation, mediaRef ? "succeeded" : "failed", startedAtMs);
    }
    if (state === "failed") {
      return observe(
        identity,
        normalizedFailure({ status: 200, body: json, phase: "task", vendorJobId }),
        operation,
        "failed",
        startedAtMs,
      );
    }
    return observe(
      identity,
      {
        state: "failed",
        vendorJobId,
        reason: "vendor_failed",
        message: "Vidu returned an unknown task state.",
      },
      operation,
      "failed",
      startedAtMs,
    );
  };

  return {
    presetId: "vidu",
    capabilityRouteClaims:
      baseUrl === VIDU_DEFAULT_BASE_URL
        ? [
            {
              presetId: "vidu",
              mode: "text2video",
              route: {
                schemaVersion: 1,
                routeId: VIDU_Q1_T2V_ROUTE_ID,
                providerId: "vidu_enterprise",
                modelId: VIDU_Q1_T2V_MODEL_ID,
                endpointId: VIDU_Q1_T2V_ENDPOINT_ID,
                region: "unknown",
                accountTier: "api_key",
              },
              adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
            },
          ]
        : undefined,
    supportsMultiReference: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      if (isExactTextPlanCandidate(input)) {
        return submitViduQ1T2v({
          request: input,
          baseUrl,
          fetchImpl,
          headers: authHeaders(options.apiKey),
          now,
          normalizeFailure: (status, body) => {
            const failure = normalizedFailure({ status, body, phase: "submit" });
            return { reason: failure.reason, message: failure.message };
          },
        });
      }
      const exact = isExactReferencePlanCandidate(input);
      let endpoint: "reference2video" | "text2video" | "img2video";
      let body: Record<string, unknown>;
      let providerRequestDigest: string;
      if (exact) {
        const compiled = compileViduQ1ReferenceRequest(input);
        if (!compiled.ok) {
          return {
            state: "failed",
            reason: "vendor_rejected",
            message: compiled.message,
          };
        }
        endpoint = "reference2video";
        body = compiled.body;
        providerRequestDigest = compiled.providerRequestDigest;
      } else {
        const legacy = legacyRequest(input);
        if (!legacy.ok) {
          return {
            state: "failed",
            reason: "vendor_rejected",
            message: legacy.message,
          };
        }
        endpoint = legacy.endpoint;
        body = legacy.body;
        providerRequestDigest = `sha256:${createHash("sha256")
          .update(JSON.stringify(body))
          .digest("hex")}`;
      }
      const serialized = JSON.stringify(body);
      const startedAtMs = now().getTime();
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/${endpoint}`, {
          method: "POST",
          headers: authHeaders(options.apiKey),
          body: serialized,
        });
      } catch {
        return observe(
          exact ? referenceIdentity : null,
          {
            state: "submission_unknown",
            message: "Vidu create may have been accepted; reconciliation is required.",
            providerRequestDigest,
          },
          "submit",
          "submission_unknown",
          startedAtMs,
        );
      }
      const json = (await response.json().catch(() => null)) as ViduCreateResponse | null;
      if (!response.ok) {
        return observe(
          exact ? referenceIdentity : null,
          {
            ...normalizedFailure({ status: response.status, body: json, phase: "submit" }),
            providerRequestDigest,
          },
          "submit",
          "failed",
          startedAtMs,
        );
      }
      const taskId = typeof json?.task_id === "string" ? json.task_id.trim() : "";
      if (!taskId) {
        return observe(
          exact ? referenceIdentity : null,
          {
            state: "submission_unknown",
            message: "Vidu create returned no durable task receipt; reconciliation is required.",
            providerRequestDigest,
          },
          "submit",
          "submission_unknown",
          startedAtMs,
        );
      }
      if (exact) {
        exactJobs.add(taskId);
      }
      return observe(
        exact ? referenceIdentity : null,
        { state: "processing", vendorJobId: taskId, providerRequestDigest },
        "submit",
        "processing",
        startedAtMs,
      );
    },
    poll: (vendorJobId) => query(vendorJobId, "poll"),
    reconcile: (vendorJobId) => query(vendorJobId, "reconcile"),
    async cancel(vendorJobId) {
      const taskId = vendorJobId.startsWith(VIDU_Q1_T2V_JOB_PREFIX)
        ? vendorJobId.slice(VIDU_Q1_T2V_JOB_PREFIX.length)
        : vendorJobId;
      if (!taskId) {
        throw new Error("The Vidu task receipt is invalid.");
      }
      const response = await fetchImpl(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: "POST",
        headers: authHeaders(options.apiKey),
        body: JSON.stringify({ id: taskId }),
      });
      if (!response.ok) {
        throw new Error("Vidu could not cancel the task.");
      }
      exactJobs.delete(taskId);
    },
  };
}
