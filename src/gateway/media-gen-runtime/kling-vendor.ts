import { createHmac } from "node:crypto";
import {
  compileKlingImage2VideoV2Request,
  KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
  KLING_IMAGE2VIDEO_V2_ROUTE_ID,
} from "./kling-image2video-v2-compiler.js";
import {
  KLING_T2V_V2_ADAPTER_REVISION,
  KLING_T2V_V2_ENDPOINT_ID,
  KLING_T2V_V2_MODEL_ID,
  KLING_T2V_V2_PROFILE_ID,
  KLING_T2V_V2_ROUTE_ID,
} from "./kling-text2video-v2-compiler.js";
import { submitKlingT2vV2 } from "./kling-text2video-v2-vendor.js";
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

const DEFAULT_BASE_URL = "https://api.klingai.com";
const DEFAULT_MODEL = "kling-v1";

export type KlingRuntimeVendorOptions = {
  accessKey: string;
  secret: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(accessKey: string, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }));
  const signature = base64Url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function splitVendorJobId(vendorJobId: string): [string, string] {
  const idx = vendorJobId.indexOf(":");
  return idx <= 0
    ? ["text2video", vendorJobId]
    : [vendorJobId.slice(0, idx), vendorJobId.slice(idx + 1)];
}

function authHeaders(accessKey: string, secret: string): Record<string, string> {
  return {
    authorization: `Bearer ${signJwt(accessKey, secret)}`,
    "content-type": "application/json",
  };
}

function endpointFor(mode: MediaGenRuntimeVendorInput["mode"]): string {
  return mode === "image2video" ? "image2video" : "text2video";
}

function endpointForJobKind(kind: string): string {
  if (kind === "image2video-v2") return "image2video";
  if (kind === "text2video-v2") return "text2video";
  return kind;
}

function normalizedCreateFailure(
  status: number,
  message: string | undefined,
): Pick<Extract<MediaGenRuntimeVendorJob, { state: "failed" }>, "reason" | "message"> {
  if (status === 401 || status === 403) {
    return { reason: "auth", message: "Kling credentials were rejected." };
  }
  if (status === 429 || /quota|credit|balance|余额|配额|欠费/iu.test(message ?? "")) {
    return { reason: "quota", message: "Kling quota or rate capacity is unavailable." };
  }
  if (/sensitive|moderation|policy|violat|审核|敏感|违规/iu.test(message ?? "")) {
    return { reason: "content_blocked", message: "Kling content policy rejected the request." };
  }
  return {
    reason: "vendor_rejected",
    message: "Kling rejected the documented create request.",
  };
}

type ExactObservationIdentity = { routeId: string; adapterRevision: string };

function withObservation(
  job: MediaGenRuntimeVendorJob,
  evidence: ExactObservationIdentity,
  input: {
    operation: MediaGenProviderRuntimeOperation;
    outcome: MediaGenProviderRuntimeOutcome;
    startedAtMs: number;
    finishedAt: Date;
  },
): MediaGenRuntimeVendorJob {
  return {
    ...job,
    providerObservation: providerObservation({ ...evidence, ...input }),
  };
}

function exactObservationIdentity(jobKind: string): ExactObservationIdentity | null {
  if (jobKind === "image2video-v2") {
    return {
      routeId: KLING_IMAGE2VIDEO_V2_ROUTE_ID,
      adapterRevision: KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
    };
  }
  if (jobKind === "text2video-v2") {
    return {
      routeId: KLING_T2V_V2_ROUTE_ID,
      adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
    };
  }
  return null;
}

function isExactTextPlanCandidate(input: MediaGenRuntimeVendorInput): boolean {
  const plan = input.frozenPlan;
  return (
    input.mode === "text2video" &&
    Boolean(
      plan &&
      (plan.adapterRevision === KLING_T2V_V2_ADAPTER_REVISION ||
        plan.providerRouteRef.routeId === KLING_T2V_V2_ROUTE_ID ||
        plan.capabilityProfileRef.profileId === KLING_T2V_V2_PROFILE_ID),
    )
  );
}

export function createKlingRuntimeVendor(
  options: KlingRuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  const query = async (
    vendorJobId: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const [jobKind, taskId] = splitVendorJobId(vendorJobId);
    const exactIdentity = exactObservationIdentity(jobKind);
    const startedAtMs = now().getTime();
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      exactIdentity
        ? withObservation(job, exactIdentity, {
            operation,
            outcome,
            startedAtMs,
            finishedAt: now(),
          })
        : job;
    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/v1/videos/${endpointForJobKind(jobKind)}/${encodeURIComponent(taskId)}`,
        {
          method: "GET",
          headers: authHeaders(options.accessKey, options.secret),
        },
      );
    } catch {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    const json = (await response.json().catch(() => null)) as KlingResponse | null;
    if (!response.ok || !json || json.code !== 0) {
      const classified = normalizedCreateFailure(response.status, json?.message);
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: classified.reason === "vendor_rejected" ? "vendor_failed" : classified.reason,
          message:
            classified.reason === "vendor_rejected"
              ? "The Kling task could not be reconciled."
              : classified.message,
        },
        "failed",
      );
    }
    const status = json.data?.task_status;
    if (status === "submitted" || status === "processing") {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    if (status === "canceled" || status === "cancelled") {
      return observed({ state: "canceled", vendorJobId }, "canceled");
    }
    if (status === "succeed") {
      const url = json.data?.task_result?.videos?.[0]?.url;
      if (typeof url !== "string" || !url.startsWith("https://")) {
        return observed(
          {
            state: "failed",
            vendorJobId,
            reason: "download_failed",
            message: "Kling completed without a retrievable video output.",
          },
          "failed",
        );
      }
      return observed(
        {
          state: "succeeded",
          vendorJobId,
          output: { mediaRef: url, mimeType: "video/mp4" },
        },
        "succeeded",
      );
    }
    if (status === "failed") {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "Kling could not complete the generation task.",
        },
        "failed",
      );
    }
    return observed(
      {
        state: "failed",
        vendorJobId,
        reason: "vendor_failed",
        message: "Kling returned an unreadable task status.",
      },
      "failed",
    );
  };

  return {
    presetId: "kling",
    capabilityRouteClaims:
      baseUrl === DEFAULT_BASE_URL
        ? [
            {
              presetId: "kling",
              mode: "text2video",
              route: {
                schemaVersion: 1,
                routeId: KLING_T2V_V2_ROUTE_ID,
                providerId: "kling_open_platform",
                modelId: KLING_T2V_V2_MODEL_ID,
                endpointId: KLING_T2V_V2_ENDPOINT_ID,
                region: "global",
                accountTier: "api_key",
              },
              adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
            },
          ]
        : undefined,
    // Existing frozen I2V jobs still resolve typed sources locally, while the
    // factory only projects this bit when an image route is actually advertised.
    supportsMultiReference: true,
    isConfigured() {
      return options.accessKey.trim().length > 0 && options.secret.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      if (input.mode === "image2video") {
        const compiled = compileKlingImage2VideoV2Request(input);
        if (!compiled.ok) {
          return { state: "failed", reason: "vendor_rejected", message: compiled.message };
        }
        const startedAtMs = now().getTime();
        const evidence = {
          routeId: KLING_IMAGE2VIDEO_V2_ROUTE_ID,
          adapterRevision: KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
        };
        let response: Response;
        try {
          response = await fetchImpl(`${baseUrl}/v1/videos/image2video`, {
            method: "POST",
            headers: authHeaders(options.accessKey, options.secret),
            body: JSON.stringify(compiled.body),
          });
        } catch {
          return withObservation(
            {
              state: "submission_unknown",
              message: "Kling create may have been accepted; reconciliation is required.",
              providerRequestDigest: compiled.providerRequestDigest,
            },
            evidence,
            { operation: "submit", outcome: "submission_unknown", startedAtMs, finishedAt: now() },
          );
        }
        const json = (await response.json().catch(() => null)) as KlingResponse | null;
        if (!response.ok || !json || json.code !== 0) {
          return withObservation(
            {
              state: "failed",
              ...normalizedCreateFailure(response.status, json?.message),
              providerRequestDigest: compiled.providerRequestDigest,
            },
            evidence,
            { operation: "submit", outcome: "failed", startedAtMs, finishedAt: now() },
          );
        }
        const taskId = json.data?.task_id;
        if (typeof taskId !== "string" || taskId.trim().length === 0) {
          return withObservation(
            {
              state: "submission_unknown",
              message: "Kling create returned no durable task receipt; reconciliation is required.",
              providerRequestDigest: compiled.providerRequestDigest,
            },
            evidence,
            { operation: "submit", outcome: "submission_unknown", startedAtMs, finishedAt: now() },
          );
        }
        return withObservation(
          {
            state: "processing",
            vendorJobId: `image2video-v2:${taskId}`,
            providerRequestDigest: compiled.providerRequestDigest,
          },
          evidence,
          { operation: "submit", outcome: "processing", startedAtMs, finishedAt: now() },
        );
      }

      if (isExactTextPlanCandidate(input)) {
        return submitKlingT2vV2({
          request: input,
          baseUrl,
          fetchImpl,
          headers: authHeaders(options.accessKey, options.secret),
          now,
          normalizeFailure: normalizedCreateFailure,
        });
      }

      const endpoint = endpointFor(input.mode);
      const body: Record<string, unknown> = {
        model_name: (input.params?.model_name as string | undefined) ?? DEFAULT_MODEL,
        prompt: input.prompt ?? "",
        duration: String(input.durationSec ?? 5),
        aspect_ratio: (input.params?.aspect_ratio as string | undefined) ?? "16:9",
        cfg_scale: (input.params?.cfg_scale as number | undefined) ?? 0.5,
      };
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/videos/${endpoint}`, {
          method: "POST",
          headers: authHeaders(options.accessKey, options.secret),
          body: JSON.stringify(body),
        });
      } catch {
        return {
          state: "failed",
          reason: "internal",
          message: "The Kling create request could not be delivered.",
        };
      }
      const json = (await response.json().catch(() => null)) as KlingResponse | null;
      if (!response.ok || !json || json.code !== 0) {
        return { state: "failed", ...normalizedCreateFailure(response.status, json?.message) };
      }
      const taskId = json.data?.task_id;
      if (!taskId) {
        return {
          state: "failed",
          reason: "vendor_rejected",
          message: "Kling returned no durable task receipt.",
        };
      }
      return { state: "processing", vendorJobId: `${endpoint}:${taskId}` };
    },
    poll: (vendorJobId) => query(vendorJobId, "poll"),
    reconcile: (vendorJobId) => query(vendorJobId, "reconcile"),
  };
}

interface KlingResponse {
  code?: number;
  message?: string;
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: { videos?: Array<{ url?: string }> };
  };
}
