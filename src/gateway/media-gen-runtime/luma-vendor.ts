import {
  compileLumaRay2Request,
  LUMA_RAY2_ADAPTER_REVISION,
  LUMA_RAY2_ENDPOINT_ID,
  LUMA_RAY2_MODEL_ID,
  LUMA_RAY2_ROUTE_ID,
} from "./luma-ray2-compiler.js";
import {
  compileLumaRay2I2vRequest,
  LUMA_RAY2_I2V_ADAPTER_REVISION,
  LUMA_RAY2_I2V_ENDPOINT_ID,
  LUMA_RAY2_I2V_MODEL_ID,
  LUMA_RAY2_I2V_ROUTE_ID,
} from "./luma-ray2-i2v-compiler.js";
import {
  providerObservation,
  type MediaGenProviderRuntimeOperation,
  type MediaGenProviderRuntimeOutcome,
} from "./provider-observation.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorJob,
} from "./types.js";

export const LUMA_DEFAULT_BASE_URL = "https://api.lumalabs.ai/dream-machine/v1";
export const LUMA_RAY2_I2V_JOB_PREFIX = "luma-ray2-i2v:";

export type LumaRuntimeVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

type LumaGenerationResponse = {
  id?: unknown;
  state?: unknown;
  failure_reason?: unknown;
  assets?: { video?: unknown } | null;
  error?: unknown;
  message?: unknown;
};

type LumaRuntimeRoute = {
  mode: "text2video" | "image2video";
  routeId: string;
  adapterRevision: string;
  modelId: string;
  endpointId: string;
  jobPrefix?: string;
};

const LUMA_RAY2_T2V_ROUTE: LumaRuntimeRoute = {
  mode: "text2video",
  routeId: LUMA_RAY2_ROUTE_ID,
  adapterRevision: LUMA_RAY2_ADAPTER_REVISION,
  modelId: LUMA_RAY2_MODEL_ID,
  endpointId: LUMA_RAY2_ENDPOINT_ID,
};

const LUMA_RAY2_I2V_ROUTE: LumaRuntimeRoute = {
  mode: "image2video",
  routeId: LUMA_RAY2_I2V_ROUTE_ID,
  adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
  modelId: LUMA_RAY2_I2V_MODEL_ID,
  endpointId: LUMA_RAY2_I2V_ENDPOINT_ID,
  jobPrefix: LUMA_RAY2_I2V_JOB_PREFIX,
};

function routeForInput(mode: "text2video" | "image2video"): LumaRuntimeRoute {
  return mode === "image2video" ? LUMA_RAY2_I2V_ROUTE : LUMA_RAY2_T2V_ROUTE;
}

function encodeJobReceipt(providerJobId: string, route: LumaRuntimeRoute): string {
  return route.jobPrefix ? `${route.jobPrefix}${providerJobId}` : providerJobId;
}

function decodeJobReceipt(receipt: string): {
  providerJobId: string;
  route: LumaRuntimeRoute;
} {
  if (receipt.startsWith(LUMA_RAY2_I2V_JOB_PREFIX)) {
    return {
      providerJobId: receipt.slice(LUMA_RAY2_I2V_JOB_PREFIX.length),
      route: LUMA_RAY2_I2V_ROUTE,
    };
  }
  // Compatibility: Luma receipts issued before the I2V route were raw ids and
  // therefore belong to the historical Ray 2 Text-to-Video route.
  return { providerJobId: receipt, route: LUMA_RAY2_T2V_ROUTE };
}

function headers(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function errorText(value: LumaGenerationResponse | null): string {
  if (!value) {
    return "";
  }
  return [value.failure_reason, value.error, value.message]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function normalizedFailure(input: {
  status: number;
  body: LumaGenerationResponse | null;
  phase: "submit" | "generation";
  vendorJobId?: string;
}): MediaGenRuntimeVendorJob {
  const text = errorText(input.body);
  const common = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (input.status === 401 || input.status === 403) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "Luma credentials were rejected.",
    };
  }
  if (input.status === 429 || /quota|credit|balance|rate.?limit/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "Luma quota or rate capacity is unavailable.",
    };
  }
  if (/moderation|content.?policy|safety|violat|blocked/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "content_blocked",
      message: "Luma content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "Luma rejected the documented create request."
        : "The Luma generation could not be reconciled.",
  };
}

function withObservation(
  job: MediaGenRuntimeVendorJob,
  route: LumaRuntimeRoute,
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

function httpsUrl(value: unknown): string | null {
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

export function createLumaRuntimeVendor(options: LumaRuntimeVendorOptions): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? LUMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  const query = async (
    jobReceipt: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const { providerJobId, route } = decodeJobReceipt(jobReceipt);
    const startedAtMs = now().getTime();
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      withObservation(job, route, { operation, outcome, startedAtMs, finishedAt: now() });
    if (providerJobId.trim().length === 0) {
      return observed(
        {
          state: "failed",
          vendorJobId: jobReceipt,
          reason: "vendor_failed",
          message: "The Luma generation receipt is invalid.",
        },
        "failed",
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/generations/${encodeURIComponent(providerJobId)}`, {
        method: "GET",
        headers: headers(options.apiKey),
      });
    } catch {
      return observed({ state: "processing", vendorJobId: jobReceipt }, "processing");
    }
    const json = (await response.json().catch(() => null)) as LumaGenerationResponse | null;
    if (!response.ok) {
      return observed(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "generation",
          vendorJobId: jobReceipt,
        }),
        "failed",
      );
    }
    if (!json || typeof json.state !== "string") {
      return observed(
        {
          state: "failed",
          vendorJobId: jobReceipt,
          reason: "vendor_failed",
          message: "Luma returned an unreadable generation receipt.",
        },
        "failed",
      );
    }
    if (json.state === "queued" || json.state === "dreaming") {
      return observed({ state: "processing", vendorJobId: jobReceipt }, "processing");
    }
    if (json.state === "failed") {
      return observed(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "generation",
          vendorJobId: jobReceipt,
        }),
        "failed",
      );
    }
    if (json.state === "completed") {
      const video = httpsUrl(json.assets?.video);
      if (!video) {
        return observed(
          {
            state: "failed",
            vendorJobId: jobReceipt,
            reason: "download_failed",
            message: "Luma completed without a retrievable HTTPS video output.",
          },
          "failed",
        );
      }
      return observed(
        {
          state: "succeeded",
          vendorJobId: jobReceipt,
          output: { mediaRef: video, mimeType: "video/mp4" },
        },
        "succeeded",
      );
    }
    return observed(
      {
        state: "failed",
        vendorJobId: jobReceipt,
        reason: "vendor_failed",
        message: "Luma returned an unknown generation state.",
      },
      "failed",
    );
  };

  return {
    presetId: "luma",
    capabilityRouteClaims:
      baseUrl === LUMA_DEFAULT_BASE_URL
        ? [
            {
              presetId: "luma",
              mode: LUMA_RAY2_I2V_ROUTE.mode,
              route: {
                schemaVersion: 1,
                routeId: LUMA_RAY2_I2V_ROUTE.routeId,
                providerId: "luma_dream_machine",
                modelId: LUMA_RAY2_I2V_ROUTE.modelId,
                endpointId: LUMA_RAY2_I2V_ROUTE.endpointId,
                region: "global",
                accountTier: "api_key",
              },
              adapterRevision: LUMA_RAY2_I2V_ROUTE.adapterRevision,
            },
            {
              presetId: "luma",
              mode: LUMA_RAY2_T2V_ROUTE.mode,
              route: {
                schemaVersion: 1,
                routeId: LUMA_RAY2_T2V_ROUTE.routeId,
                providerId: "luma_dream_machine",
                modelId: LUMA_RAY2_T2V_ROUTE.modelId,
                endpointId: LUMA_RAY2_T2V_ROUTE.endpointId,
                region: "global",
                accountTier: "api_key",
              },
              adapterRevision: LUMA_RAY2_T2V_ROUTE.adapterRevision,
            },
          ]
        : undefined,
    // The executor represents typed slots as `sources[]` even when a route uses
    // exactly one first frame. This vendor consumes that slot explicitly.
    supportsMultiReference: true,
    requiresFrozenPlan: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const route = routeForInput(input.mode);
      const compiled =
        route.mode === "image2video"
          ? compileLumaRay2I2vRequest(input)
          : compileLumaRay2Request(input);
      if (!compiled.ok) {
        return {
          state: "failed",
          reason: "vendor_rejected",
          message: compiled.message,
        };
      }
      const startedAtMs = now().getTime();
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/generations/video`, {
          method: "POST",
          headers: headers(options.apiKey),
          body: JSON.stringify(compiled.body),
        });
      } catch {
        return withObservation(
          {
            state: "submission_unknown",
            message: "Luma create may have been accepted; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          route,
          {
            operation: "submit",
            outcome: "submission_unknown",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      const json = (await response.json().catch(() => null)) as LumaGenerationResponse | null;
      if (!response.ok) {
        return withObservation(
          {
            ...normalizedFailure({ status: response.status, body: json, phase: "submit" }),
            providerRequestDigest: compiled.providerRequestDigest,
          },
          route,
          {
            operation: "submit",
            outcome: "failed",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      const id = typeof json?.id === "string" ? json.id.trim() : "";
      if (!id) {
        return withObservation(
          {
            state: "submission_unknown",
            message:
              "Luma create returned no durable generation receipt; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          route,
          {
            operation: "submit",
            outcome: "submission_unknown",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      return withObservation(
        {
          state: "processing",
          vendorJobId: encodeJobReceipt(id, route),
          providerRequestDigest: compiled.providerRequestDigest,
        },
        route,
        {
          operation: "submit",
          outcome: "processing",
          startedAtMs,
          finishedAt: now(),
        },
      );
    },
    poll: (vendorJobId) => query(vendorJobId, "poll"),
    reconcile: (vendorJobId) => query(vendorJobId, "reconcile"),
    async cancel(jobReceipt) {
      const { providerJobId } = decodeJobReceipt(jobReceipt);
      if (providerJobId.trim().length === 0) {
        throw new Error("The Luma generation receipt is invalid.");
      }
      const response = await fetchImpl(
        `${baseUrl}/generations/${encodeURIComponent(providerJobId)}`,
        { method: "DELETE", headers: headers(options.apiKey) },
      );
      if (!response.ok) {
        throw new Error("Luma could not delete the generation.");
      }
    },
  };
}
