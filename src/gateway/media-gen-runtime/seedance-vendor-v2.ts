import {
  providerObservation,
  type MediaGenProviderRuntimeOperation,
  type MediaGenProviderRuntimeOutcome,
} from "./provider-observation.js";
import {
  compileSeedanceV2Request,
  SEEDANCE_V2_ADAPTER_REVISION,
  SEEDANCE_V2_ENDPOINT_ID,
  SEEDANCE_V2_MODEL_ID,
  SEEDANCE_V2_ROUTE_IDS,
} from "./seedance-v2-compiler.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorJob,
} from "./types.js";

export const SEEDANCE_V2_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

export type SeedanceV2RuntimeVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

type SeedanceCreateResponse = { id?: unknown };
type SeedancePollResponse = {
  id?: unknown;
  status?: unknown;
  content?: { video_url?: unknown };
  resolution?: unknown;
  duration?: unknown;
};
type SeedanceMode = keyof typeof SEEDANCE_V2_ROUTE_IDS;

const JOB_PREFIX = "seedance-v2:";

function encodeJobReceipt(mode: SeedanceMode, providerJobId: string): string {
  return `${JOB_PREFIX}${mode}:${providerJobId}`;
}

function decodeJobReceipt(jobReceipt: string): {
  mode: SeedanceMode;
  providerJobId: string;
} | null {
  for (const mode of Object.keys(SEEDANCE_V2_ROUTE_IDS) as SeedanceMode[]) {
    const prefix = `${JOB_PREFIX}${mode}:`;
    if (jobReceipt.startsWith(prefix) && jobReceipt.length > prefix.length) {
      return { mode, providerJobId: jobReceipt.slice(prefix.length) };
    }
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

function normalizedCreateFailure(
  status: number,
  providerRequestDigest: string,
): MediaGenRuntimeVendorJob {
  if (status === 401 || status === 403) {
    return { state: "failed", reason: "auth", message: "Seedance credentials were rejected." };
  }
  if (status === 429) {
    return {
      state: "failed",
      reason: "quota",
      message: "Seedance quota or rate capacity is unavailable.",
    };
  }
  if (status === 408 || status >= 500) {
    return {
      state: "submission_unknown",
      message: "Seedance create may have been accepted; reconciliation is required.",
      providerRequestDigest,
    };
  }
  return {
    state: "failed",
    reason: "vendor_rejected",
    message: "Seedance rejected the documented create request.",
  };
}

function normalizedPollFailure(status: number, vendorJobId: string): MediaGenRuntimeVendorJob {
  if (status === 408 || status === 429 || status >= 500) {
    return { state: "processing", vendorJobId };
  }
  if (status === 401 || status === 403) {
    return {
      state: "failed",
      vendorJobId,
      reason: "auth",
      message: "Seedance credentials were rejected.",
      retryDisposition: "reconcile_only",
    };
  }
  return {
    state: "failed",
    vendorJobId,
    reason: "vendor_failed",
    message: "The Seedance task could not be reconciled.",
    retryDisposition: "reconcile_only",
  };
}

function withObservation(
  job: MediaGenRuntimeVendorJob,
  mode: SeedanceMode,
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
      routeId: SEEDANCE_V2_ROUTE_IDS[mode],
      adapterRevision: SEEDANCE_V2_ADAPTER_REVISION,
      ...input,
    }),
  };
}

export function createSeedanceV2RuntimeVendor(
  options: SeedanceV2RuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? SEEDANCE_V2_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const taskUrl = `${baseUrl}/contents/generations/tasks`;
  const routeClaims =
    baseUrl === SEEDANCE_V2_DEFAULT_BASE_URL
      ? (["text2video", "image2video"] as const).map((mode) => ({
          presetId: "seedance",
          mode,
          route: {
            schemaVersion: 1 as const,
            routeId: SEEDANCE_V2_ROUTE_IDS[mode],
            providerId: "volcengine_ark",
            modelId: SEEDANCE_V2_MODEL_ID,
            endpointId: SEEDANCE_V2_ENDPOINT_ID,
            region: "cn-beijing",
            accountTier: "online",
          },
          adapterRevision: SEEDANCE_V2_ADAPTER_REVISION,
        }))
      : undefined;

  const query = async (
    jobReceipt: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const decoded = decodeJobReceipt(jobReceipt);
    if (!decoded) {
      return {
        state: "failed",
        vendorJobId: jobReceipt,
        reason: "vendor_failed",
        message: "The Seedance task receipt is not bound to an Adapter V2 route.",
      };
    }
    const { mode, providerJobId } = decoded;
    const startedAtMs = now().getTime();
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      withObservation(job, mode, {
        operation,
        outcome,
        startedAtMs,
        finishedAt: now(),
      });
    let response: Response;
    try {
      response = await fetchImpl(`${taskUrl}/${encodeURIComponent(providerJobId)}`, {
        method: "GET",
        headers: headers(options.apiKey),
      });
    } catch {
      // A known job remains processing when the query transport is temporarily unavailable.
      return observed({ state: "processing", vendorJobId: jobReceipt }, "processing");
    }
    if (response.status === 204) {
      return observed({ state: "processing", vendorJobId: jobReceipt }, "processing");
    }
    if (!response.ok) {
      const normalized = normalizedPollFailure(response.status, jobReceipt);
      return observed(normalized, normalized.state === "processing" ? "processing" : "failed");
    }
    const json = (await response.json().catch(() => null)) as SeedancePollResponse | null;
    if (!json || typeof json.status !== "string") {
      return observed(
        {
          state: "failed",
          vendorJobId: jobReceipt,
          reason: "vendor_failed",
          message: "Seedance returned an unreadable task receipt.",
          retryDisposition: "reconcile_only",
        },
        "failed",
      );
    }
    if (json.status === "queued" || json.status === "running") {
      return observed({ state: "processing", vendorJobId: jobReceipt }, "processing");
    }
    if (json.status === "cancelled" || json.status === "canceled") {
      return observed({ state: "canceled", vendorJobId: jobReceipt }, "canceled");
    }
    if (json.status === "succeeded") {
      const videoUrl = json.content?.video_url;
      if (typeof videoUrl !== "string" || !videoUrl.startsWith("https://")) {
        return observed(
          {
            state: "failed",
            vendorJobId: jobReceipt,
            reason: "download_failed",
            message: "Seedance completed without a retrievable video output.",
          },
          "failed",
        );
      }
      return observed(
        {
          state: "succeeded",
          vendorJobId: jobReceipt,
          output: {
            mediaRef: videoUrl,
            mimeType: "video/mp4",
            ...(typeof json.duration === "number" && Number.isFinite(json.duration)
              ? { durationSec: json.duration }
              : {}),
            ...(typeof json.resolution === "string" && json.resolution.length > 0
              ? { resolution: json.resolution }
              : {}),
          },
        },
        "succeeded",
      );
    }
    if (json.status === "failed" || json.status === "expired") {
      return observed(
        {
          state: "failed",
          vendorJobId: jobReceipt,
          reason: "vendor_failed",
          message:
            json.status === "expired"
              ? "The Seedance task expired before completion."
              : "Seedance could not complete the generation task.",
          retryDisposition: "replacement_allowed",
        },
        "failed",
      );
    }
    return observed(
      {
        state: "failed",
        vendorJobId: jobReceipt,
        reason: "vendor_failed",
        message: "Seedance returned an unknown task status.",
        retryDisposition: "reconcile_only",
      },
      "failed",
    );
  };

  return {
    presetId: "seedance",
    capabilityRouteClaims: routeClaims,
    // Needed to finish historical multimodal jobs. Factory registration derives
    // the advertised bit from active image-route claims, not this executor seam.
    supportsMultiReference: true,
    requiresFrozenPlan: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const compiled = compileSeedanceV2Request(input);
      if (!compiled.ok) {
        return { state: "failed", reason: "vendor_rejected", message: compiled.message };
      }
      const mode = input.mode;
      const startedAtMs = now().getTime();
      let response: Response;
      try {
        response = await fetchImpl(taskUrl, {
          method: "POST",
          headers: headers(options.apiKey),
          body: JSON.stringify(compiled.body),
        });
      } catch {
        return withObservation(
          {
            state: "submission_unknown",
            message: "Seedance create may have been accepted; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          mode,
          {
            operation: "submit",
            outcome: "submission_unknown",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      if (!response.ok) {
        const normalized = normalizedCreateFailure(response.status, compiled.providerRequestDigest);
        return withObservation(
          {
            ...normalized,
            ...(normalized.state !== "submission_unknown"
              ? { providerRequestDigest: compiled.providerRequestDigest }
              : {}),
          },
          mode,
          {
            operation: "submit",
            outcome: normalized.state === "submission_unknown" ? "submission_unknown" : "failed",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      const json = (await response.json().catch(() => null)) as SeedanceCreateResponse | null;
      if (!json || typeof json.id !== "string" || json.id.trim().length === 0) {
        return withObservation(
          {
            state: "submission_unknown",
            message:
              "Seedance create returned no durable task receipt; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          mode,
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
          vendorJobId: encodeJobReceipt(mode, json.id),
          providerRequestDigest: compiled.providerRequestDigest,
          ...(compiled.spatialInputEnvelope && {
            spatialInputAcceptance: {
              ...compiled.spatialInputEnvelope,
              executionAttempt: input.executionAttempt!,
              frozenPlanDigest: input.frozenPlanDigest!,
              runtimeJobId: encodeJobReceipt(mode, json.id),
              providerRequestDigest: compiled.providerRequestDigest,
            },
          }),
        },
        mode,
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
      const decoded = decodeJobReceipt(jobReceipt);
      if (!decoded) {
        throw new Error("The Seedance task receipt is not bound to an Adapter V2 route.");
      }
      const startedAtMs = now().getTime();
      const observed = (
        state: "confirmed" | "requested" | "failed" | "unknown",
        outcome: "canceled" | "processing",
      ) => ({
        state,
        providerObservation: providerObservation({
          routeId: SEEDANCE_V2_ROUTE_IDS[decoded.mode],
          adapterRevision: SEEDANCE_V2_ADAPTER_REVISION,
          operation: "cancel",
          outcome,
          startedAtMs,
          finishedAt: now(),
        }),
      });
      let response: Response;
      try {
        response = await fetchImpl(`${taskUrl}/${encodeURIComponent(decoded.providerJobId)}`, {
          method: "DELETE",
          headers: headers(options.apiKey),
        });
      } catch {
        return observed("unknown", "processing");
      }
      if (!response.ok) {
        return observed(
          response.status === 408 || response.status >= 500 ? "unknown" : "failed",
          "processing",
        );
      }
      if (response.status === 204) {
        return observed("confirmed", "canceled");
      }
      const body = (await response.json().catch(() => null)) as SeedancePollResponse | null;
      return body?.status === "canceled" || body?.status === "cancelled"
        ? observed("confirmed", "canceled")
        : observed("requested", "processing");
    },
  };
}
