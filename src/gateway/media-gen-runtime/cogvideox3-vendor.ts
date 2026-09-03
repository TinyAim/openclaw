import {
  COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
  COGVIDEOX3_FIRST_LAST_ENDPOINT_ID,
  COGVIDEOX3_FIRST_LAST_MODEL_ID,
  COGVIDEOX3_FIRST_LAST_ROUTE_ID,
  compileCogVideoX3FirstLastRequest,
} from "./cogvideox3-first-last-frame-compiler.js";
import {
  COGVIDEOX3_I2V_ADAPTER_REVISION,
  COGVIDEOX3_I2V_ENDPOINT_ID,
  COGVIDEOX3_I2V_MODEL_ID,
  COGVIDEOX3_I2V_ROUTE_ID,
  compileCogVideoX3I2vRequest,
} from "./cogvideox3-image2video-compiler.js";
import {
  COGVIDEOX3_T2V_ADAPTER_REVISION,
  COGVIDEOX3_T2V_ENDPOINT_ID,
  COGVIDEOX3_T2V_MODEL_ID,
  COGVIDEOX3_T2V_ROUTE_ID,
  compileCogVideoX3T2vRequest,
} from "./cogvideox3-text2video-compiler.js";
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

export const COGVIDEOX3_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const COGVIDEOX3_T2V_JOB_PREFIX = "cogvideox3-t2v:";
export const COGVIDEOX3_I2V_JOB_PREFIX = "cogvideox3-i2v:";
export const COGVIDEOX3_FIRST_LAST_JOB_PREFIX = "cogvideox3-flf:";

export type CogVideoX3RuntimeVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

type CogVideoXResponse = {
  id?: unknown;
  request_id?: unknown;
  task_status?: unknown;
  video_result?: unknown;
  code?: unknown;
  message?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._~-]{0,255}$/u;

type CogVideoX3RouteIdentity = {
  routeId: string;
  adapterRevision: string;
  jobPrefix: string;
};

const T2V_ROUTE: CogVideoX3RouteIdentity = {
  routeId: COGVIDEOX3_T2V_ROUTE_ID,
  adapterRevision: COGVIDEOX3_T2V_ADAPTER_REVISION,
  jobPrefix: COGVIDEOX3_T2V_JOB_PREFIX,
};
const I2V_ROUTE: CogVideoX3RouteIdentity = {
  routeId: COGVIDEOX3_I2V_ROUTE_ID,
  adapterRevision: COGVIDEOX3_I2V_ADAPTER_REVISION,
  jobPrefix: COGVIDEOX3_I2V_JOB_PREFIX,
};
const FIRST_LAST_ROUTE: CogVideoX3RouteIdentity = {
  routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
  adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
  jobPrefix: COGVIDEOX3_FIRST_LAST_JOB_PREFIX,
};

function routeForInput(input: MediaGenRuntimeVendorInput): CogVideoX3RouteIdentity | null {
  const plan = input.frozenPlan;
  if (!plan) {
    return null;
  }
  if (
    input.mode === "text2video" &&
    plan.generationScenario === "text_to_video" &&
    plan.adapterRevision === COGVIDEOX3_T2V_ADAPTER_REVISION
  ) {
    return T2V_ROUTE;
  }
  if (
    input.mode === "image2video" &&
    plan.generationScenario === "first_frame_to_video" &&
    plan.adapterRevision === COGVIDEOX3_I2V_ADAPTER_REVISION
  ) {
    return I2V_ROUTE;
  }
  if (
    input.mode === "image2video" &&
    plan.generationScenario === "first_last_frame_to_video" &&
    plan.adapterRevision === COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION
  ) {
    return FIRST_LAST_ROUTE;
  }
  return null;
}

function headers(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function responseText(body: CogVideoXResponse | null): string {
  return [body?.code, body?.message, body?.error?.code, body?.error?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function normalizedFailure(input: {
  status: number;
  body: CogVideoXResponse | null;
  phase: "submit" | "poll";
  vendorJobId?: string;
}): MediaGenRuntimeVendorJob {
  const text = responseText(input.body);
  const receipt = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (input.status === 401 || input.status === 403 || /auth|token|credential/iu.test(text)) {
    return {
      state: "failed",
      ...receipt,
      reason: "auth",
      message: "Zhipu BigModel credentials were rejected.",
    };
  }
  if (
    input.status === 402 ||
    input.status === 429 ||
    /balance|quota|rate.?limit|insufficient/iu.test(text)
  ) {
    return {
      state: "failed",
      ...receipt,
      reason: "quota",
      message: "Zhipu BigModel balance, quota, or rate capacity is unavailable.",
    };
  }
  if (/sensitive|content|safety|policy|blocked/iu.test(text)) {
    return {
      state: "failed",
      ...receipt,
      reason: "content_blocked",
      message: "Zhipu BigModel content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...receipt,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "Zhipu BigModel rejected the documented CogVideoX-3 request."
        : "The CogVideoX-3 generation could not be reconciled.",
  };
}

function observed(
  route: CogVideoX3RouteIdentity,
  job: MediaGenRuntimeVendorJob,
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
      routeId: route.routeId,
      adapterRevision: route.adapterRevision,
      ...input,
    }),
  };
}

function parseRuntimeJobId(
  value: string,
): { providerJobId: string; route: CogVideoX3RouteIdentity } | null {
  for (const route of [T2V_ROUTE, I2V_ROUTE, FIRST_LAST_ROUTE]) {
    if (!value.startsWith(route.jobPrefix)) {
      continue;
    }
    const providerJobId = value.slice(route.jobPrefix.length);
    return JOB_ID.test(providerJobId) ? { providerJobId, route } : null;
  }
  return null;
}

function httpsVideoUrl(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = (item as Record<string, unknown>).url;
    if (typeof candidate !== "string") {
      continue;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {
      // Ignore malformed provider output and fail closed below.
    }
  }
  return null;
}

export function createCogVideoX3RuntimeVendor(
  options: CogVideoX3RuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? COGVIDEOX3_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  const query = async (
    runtimeJobId: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const startedAtMs = now().getTime();
    const receipt = parseRuntimeJobId(runtimeJobId);
    if (!receipt) {
      return {
        state: "failed",
        vendorJobId: runtimeJobId,
        reason: "vendor_failed",
        message: "The CogVideoX-3 runtime job receipt is invalid.",
      };
    }
    const { providerJobId, route } = receipt;
    const finish = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      observed(route, job, { operation, outcome, startedAtMs, finishedAt: now() });

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/async-result/${encodeURIComponent(providerJobId)}`, {
        method: "GET",
        headers: headers(options.apiKey),
      });
    } catch {
      return finish({ state: "processing", vendorJobId: runtimeJobId }, "processing");
    }
    const json = (await response.json().catch(() => null)) as CogVideoXResponse | null;
    if (!response.ok) {
      return finish(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "poll",
          vendorJobId: runtimeJobId,
        }),
        "failed",
      );
    }
    if (typeof json?.id === "string" && json.id !== providerJobId) {
      return finish(
        {
          state: "failed",
          vendorJobId: runtimeJobId,
          reason: "vendor_failed",
          message: "Zhipu BigModel returned a mismatched CogVideoX-3 task receipt.",
        },
        "failed",
      );
    }
    const status = typeof json?.task_status === "string" ? json.task_status.toUpperCase() : "";
    if (status === "PROCESSING") {
      return finish({ state: "processing", vendorJobId: runtimeJobId }, "processing");
    }
    if (status === "FAIL") {
      return finish(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "poll",
          vendorJobId: runtimeJobId,
        }),
        "failed",
      );
    }
    if (status === "SUCCESS") {
      const mediaRef = httpsVideoUrl(json?.video_result);
      if (!mediaRef) {
        return finish(
          {
            state: "failed",
            vendorJobId: runtimeJobId,
            reason: "download_failed",
            message: "CogVideoX-3 completed without a retrievable HTTPS video URL.",
          },
          "failed",
        );
      }
      return finish(
        {
          state: "succeeded",
          vendorJobId: runtimeJobId,
          output: { mediaRef, mimeType: "video/mp4", resolution: "1080p" },
        },
        "succeeded",
      );
    }
    return finish(
      {
        state: "failed",
        vendorJobId: runtimeJobId,
        reason: "vendor_failed",
        message: "Zhipu BigModel returned an unknown CogVideoX-3 task status.",
      },
      "failed",
    );
  };

  return {
    presetId: "cogvideox",
    capabilityRouteClaims:
      baseUrl === COGVIDEOX3_DEFAULT_BASE_URL
        ? [
            {
              presetId: "cogvideox",
              mode: "text2video",
              route: {
                schemaVersion: 1,
                routeId: COGVIDEOX3_T2V_ROUTE_ID,
                providerId: "zhipu_open_platform",
                modelId: COGVIDEOX3_T2V_MODEL_ID,
                endpointId: COGVIDEOX3_T2V_ENDPOINT_ID,
                region: "cn",
                accountTier: "api_key",
              },
              adapterRevision: COGVIDEOX3_T2V_ADAPTER_REVISION,
            },
            {
              presetId: "cogvideox",
              mode: "image2video",
              route: {
                schemaVersion: 1,
                routeId: COGVIDEOX3_I2V_ROUTE_ID,
                providerId: "zhipu_open_platform",
                modelId: COGVIDEOX3_I2V_MODEL_ID,
                endpointId: COGVIDEOX3_I2V_ENDPOINT_ID,
                region: "cn",
                accountTier: "api_key",
              },
              adapterRevision: COGVIDEOX3_I2V_ADAPTER_REVISION,
            },
            {
              presetId: "cogvideox",
              mode: "image2video",
              route: {
                schemaVersion: 1,
                routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
                providerId: "zhipu_open_platform",
                modelId: COGVIDEOX3_FIRST_LAST_MODEL_ID,
                endpointId: COGVIDEOX3_FIRST_LAST_ENDPOINT_ID,
                region: "cn",
                accountTier: "api_key",
              },
              adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
            },
          ]
        : undefined,
    supportsMultiReference: true,
    requiresFrozenPlan: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const route = routeForInput(input);
      if (!route) {
        return {
          state: "failed",
          reason: "vendor_rejected",
          message: "CogVideoX-3 received an unsupported frozen route or generation scenario.",
        };
      }
      const compiled =
        route === FIRST_LAST_ROUTE
          ? compileCogVideoX3FirstLastRequest(input)
          : route === I2V_ROUTE
            ? compileCogVideoX3I2vRequest(input)
            : compileCogVideoX3T2vRequest(input);
      if (!compiled.ok) {
        return { state: "failed", reason: "vendor_rejected", message: compiled.message };
      }
      const startedAtMs = now().getTime();
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/videos/generations`, {
          method: "POST",
          headers: headers(options.apiKey),
          body: JSON.stringify(compiled.body),
        });
      } catch {
        return observed(
          route,
          {
            state: "submission_unknown",
            message: "CogVideoX-3 create may have been accepted; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          {
            operation: "submit",
            outcome: "submission_unknown",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      const json = (await response.json().catch(() => null)) as CogVideoXResponse | null;
      if (!response.ok || json?.task_status === "FAIL") {
        return observed(
          route,
          {
            ...normalizedFailure({ status: response.status, body: json, phase: "submit" }),
            providerRequestDigest: compiled.providerRequestDigest,
          },
          { operation: "submit", outcome: "failed", startedAtMs, finishedAt: now() },
        );
      }
      const providerJobId = typeof json?.id === "string" ? json.id.trim() : "";
      if (!JOB_ID.test(providerJobId)) {
        return observed(
          route,
          {
            state: "submission_unknown",
            message:
              "CogVideoX-3 create returned no durable task receipt; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          {
            operation: "submit",
            outcome: "submission_unknown",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      return observed(
        route,
        {
          state: "processing",
          vendorJobId: `${route.jobPrefix}${providerJobId}`,
          providerRequestDigest: compiled.providerRequestDigest,
        },
        { operation: "submit", outcome: "processing", startedAtMs, finishedAt: now() },
      );
    },
    poll: (runtimeJobId) => query(runtimeJobId, "poll"),
    reconcile: (runtimeJobId) => query(runtimeJobId, "reconcile"),
  };
}
