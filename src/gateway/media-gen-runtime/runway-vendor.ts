import {
  providerObservation,
  type MediaGenProviderRuntimeOperation,
  type MediaGenProviderRuntimeOutcome,
} from "./provider-observation.js";
import {
  compileRunwayGen4TurboRequest,
  RUNWAY_GEN4_TURBO_ADAPTER_REVISION,
  RUNWAY_GEN4_TURBO_ENDPOINT_ID,
  RUNWAY_GEN4_TURBO_MODEL_ID,
  RUNWAY_GEN4_TURBO_ROUTE_ID,
} from "./runway-gen4-turbo-compiler.js";
import {
  compileRunwayGen45T2vRequest,
  RUNWAY_GEN45_T2V_ADAPTER_REVISION,
  RUNWAY_GEN45_T2V_ENDPOINT_ID,
  RUNWAY_GEN45_T2V_MODEL_ID,
  RUNWAY_GEN45_T2V_ROUTE_ID,
} from "./runway-gen45-t2v-compiler.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorJob,
} from "./types.js";

export const RUNWAY_DEFAULT_BASE_URL = "https://api.dev.runwayml.com";
export const RUNWAY_API_VERSION = "2024-11-06";

export type RunwayRuntimeVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

type RunwayCreateResponse = { id?: unknown };
type RunwayTaskResponse = {
  status?: unknown;
  progress?: unknown;
  output?: unknown;
  failure?: unknown;
  failureCode?: unknown;
};
type RunwayErrorResponse = {
  error?: unknown;
  message?: unknown;
  failure?: unknown;
  failureCode?: unknown;
};

type RunwayRuntimeRoute = {
  mode: "text2video" | "image2video";
  routeId: string;
  adapterRevision: string;
  modelId: string;
  endpointId: string;
  submitPath: "/v1/text_to_video" | "/v1/image_to_video";
  jobPrefix?: string;
};

const RUNWAY_GEN45_T2V_JOB_PREFIX = "runway-gen45-t2v:";
const RUNWAY_GEN45_T2V_ROUTE: RunwayRuntimeRoute = {
  mode: "text2video",
  routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
  adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
  modelId: RUNWAY_GEN45_T2V_MODEL_ID,
  endpointId: RUNWAY_GEN45_T2V_ENDPOINT_ID,
  submitPath: "/v1/text_to_video",
  jobPrefix: RUNWAY_GEN45_T2V_JOB_PREFIX,
};
const RUNWAY_GEN4_TURBO_ROUTE: RunwayRuntimeRoute = {
  mode: "image2video",
  routeId: RUNWAY_GEN4_TURBO_ROUTE_ID,
  adapterRevision: RUNWAY_GEN4_TURBO_ADAPTER_REVISION,
  modelId: RUNWAY_GEN4_TURBO_MODEL_ID,
  endpointId: RUNWAY_GEN4_TURBO_ENDPOINT_ID,
  submitPath: "/v1/image_to_video",
};

function routeForInput(mode: "text2video" | "image2video"): RunwayRuntimeRoute {
  return mode === "text2video" ? RUNWAY_GEN45_T2V_ROUTE : RUNWAY_GEN4_TURBO_ROUTE;
}

function encodeJobReceipt(providerJobId: string, route: RunwayRuntimeRoute): string {
  return route.jobPrefix ? `${route.jobPrefix}${providerJobId}` : providerJobId;
}

function decodeJobReceipt(receipt: string): {
  providerJobId: string;
  route: RunwayRuntimeRoute;
} {
  if (receipt.startsWith(RUNWAY_GEN45_T2V_JOB_PREFIX)) {
    return {
      providerJobId: receipt.slice(RUNWAY_GEN45_T2V_JOB_PREFIX.length),
      route: RUNWAY_GEN45_T2V_ROUTE,
    };
  }
  // Compatibility: receipts created before the T2V route were raw Runway ids
  // and therefore belong to the sole historical Gen-4 Turbo I2V route.
  return { providerJobId: receipt, route: RUNWAY_GEN4_TURBO_ROUTE };
}

function headers(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
    "X-Runway-Version": RUNWAY_API_VERSION,
  };
}

function errorText(value: RunwayErrorResponse | RunwayTaskResponse | null): string {
  if (!value) {
    return "";
  }
  return [
    value.failureCode,
    value.failure,
    "error" in value ? value.error : undefined,
    "message" in value ? value.message : undefined,
  ]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function normalizedFailure(input: {
  status: number;
  body: RunwayErrorResponse | RunwayTaskResponse | null;
  phase: "submit" | "task";
  vendorJobId?: string;
}): MediaGenRuntimeVendorJob {
  const text = errorText(input.body);
  const common = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (input.status === 401 || input.status === 403) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "Runway credentials were rejected.",
    };
  }
  if (input.status === 429 || /quota|credit|balance|rate.?limit/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "Runway quota or rate capacity is unavailable.",
    };
  }
  if (/moderation|content.?policy|safety|violat|blocked/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "content_blocked",
      message: "Runway content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "Runway rejected the documented create request."
        : "The Runway task could not be reconciled.",
  };
}

function withObservation(
  job: MediaGenRuntimeVendorJob,
  route: RunwayRuntimeRoute,
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

export function createRunwayRuntimeVendor(
  options: RunwayRuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? RUNWAY_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  const query = async (
    jobReceipt: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const { providerJobId, route } = decodeJobReceipt(jobReceipt);
    const startedAtMs = now().getTime();
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      withObservation(job, route, {
        operation,
        outcome,
        startedAtMs,
        finishedAt: now(),
      });
    if (providerJobId.trim().length === 0) {
      return observed(
        {
          state: "failed",
          vendorJobId: jobReceipt,
          reason: "vendor_failed",
          message: "Runway task receipt is invalid.",
        },
        "failed",
      );
    }
    const taskUrl = `${baseUrl}/v1/tasks/${encodeURIComponent(providerJobId)}`;
    const taskHeaders = headers(options.apiKey);
    let response: Response;
    try {
      response = await fetchImpl(taskUrl, {
        method: "GET",
        headers: taskHeaders,
      });
    } catch {
      return observed({ state: "processing", vendorJobId: jobReceipt }, "processing");
    }
    const json = (await response.json().catch(() => null)) as RunwayTaskResponse | null;
    if (!response.ok) {
      return observed(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "task",
          vendorJobId: jobReceipt,
        }),
        "failed",
      );
    }
    if (!json || typeof json.status !== "string") {
      return observed(
        {
          state: "failed",
          vendorJobId: jobReceipt,
          reason: "vendor_failed",
          message: "Runway returned an unreadable task receipt.",
        },
        "failed",
      );
    }
    if (["PENDING", "THROTTLED", "RUNNING"].includes(json.status)) {
      return observed({ state: "processing", vendorJobId: jobReceipt }, "processing");
    }
    if (["CANCELED", "CANCELLED"].includes(json.status)) {
      return observed({ state: "canceled", vendorJobId: jobReceipt }, "canceled");
    }
    if (json.status === "FAILED") {
      return observed(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "task",
          vendorJobId: jobReceipt,
        }),
        "failed",
      );
    }
    if (json.status === "SUCCEEDED") {
      const output = Array.isArray(json.output)
        ? json.output.find(
            (item): item is string => typeof item === "string" && item.startsWith("https://"),
          )
        : undefined;
      if (!output) {
        return observed(
          {
            state: "failed",
            vendorJobId: jobReceipt,
            reason: "download_failed",
            message: "Runway completed without a retrievable video output.",
          },
          "failed",
        );
      }
      return observed(
        {
          state: "succeeded",
          vendorJobId: jobReceipt,
          output: { mediaRef: output, mimeType: "video/mp4" },
        },
        "succeeded",
      );
    }
    return observed(
      {
        state: "failed",
        vendorJobId: jobReceipt,
        reason: "vendor_failed",
        message: "Runway returned an unknown task status.",
      },
      "failed",
    );
  };

  return {
    presetId: "runway",
    capabilityRouteClaims:
      baseUrl === RUNWAY_DEFAULT_BASE_URL
        ? [
            {
              presetId: "runway",
              mode: RUNWAY_GEN45_T2V_ROUTE.mode,
              route: {
                schemaVersion: 1,
                routeId: RUNWAY_GEN45_T2V_ROUTE.routeId,
                providerId: "runway_api",
                modelId: RUNWAY_GEN45_T2V_ROUTE.modelId,
                endpointId: RUNWAY_GEN45_T2V_ROUTE.endpointId,
                region: "global",
                accountTier: "api_key",
              },
              adapterRevision: RUNWAY_GEN45_T2V_ROUTE.adapterRevision,
            },
            {
              presetId: "runway",
              mode: RUNWAY_GEN4_TURBO_ROUTE.mode,
              route: {
                schemaVersion: 1,
                routeId: RUNWAY_GEN4_TURBO_ROUTE.routeId,
                providerId: "runway_api",
                modelId: RUNWAY_GEN4_TURBO_ROUTE.modelId,
                endpointId: RUNWAY_GEN4_TURBO_ROUTE.endpointId,
                region: "global",
                accountTier: "api_key",
              },
              adapterRevision: RUNWAY_GEN4_TURBO_ROUTE.adapterRevision,
            },
          ]
        : undefined,
    supportsMultiReference: true,
    requiresFrozenPlan: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const route = routeForInput(input.mode);
      const compiled =
        route.mode === "text2video"
          ? compileRunwayGen45T2vRequest(input)
          : compileRunwayGen4TurboRequest(input);
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
        response = await fetchImpl(`${baseUrl}${route.submitPath}`, {
          method: "POST",
          headers: headers(options.apiKey),
          body: JSON.stringify(compiled.body),
        });
      } catch {
        return withObservation(
          {
            state: "submission_unknown",
            message: "Runway create may have been accepted; reconciliation is required.",
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
      const json = (await response.json().catch(() => null)) as
        | (RunwayCreateResponse & RunwayErrorResponse)
        | null;
      if (!response.ok) {
        return withObservation(
          {
            ...normalizedFailure({
              status: response.status,
              body: json,
              phase: "submit",
            }),
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
            message: "Runway create returned no durable task receipt; reconciliation is required.",
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
        throw new Error("Runway task receipt is invalid.");
      }
      const response = await fetchImpl(`${baseUrl}/v1/tasks/${encodeURIComponent(providerJobId)}`, {
        method: "DELETE",
        headers: headers(options.apiKey),
      });
      if (!response.ok) {
        throw new Error("Runway could not cancel the task.");
      }
    },
  };
}
