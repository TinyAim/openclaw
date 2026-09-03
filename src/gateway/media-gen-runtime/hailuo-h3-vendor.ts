import {
  compileHailuoH3Request,
  HAILUO_H3_ADAPTER_REVISION,
  HAILUO_H3_ENDPOINT_ID,
  HAILUO_H3_MODEL_ID,
  HAILUO_H3_ROUTE_ID,
} from "./hailuo-h3-compiler.js";
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

export const HAILUO_H3_DEFAULT_BASE_URL = "https://api.minimax.io";

export type HailuoH3RuntimeVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

type HailuoH3Response = {
  task_id?: unknown;
  task?: {
    id?: unknown;
    model?: unknown;
    status?: unknown;
    content?: { url?: unknown } | null;
    resolution?: unknown;
    duration?: unknown;
    ratio?: unknown;
    error?: { code?: unknown; message?: unknown } | null;
  } | null;
  action?: unknown;
  status?: unknown;
  error?: { type?: unknown; message?: unknown; http_code?: unknown } | null;
};

const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._~-]{0,199}$/u;

function headers(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function errorText(value: HailuoH3Response | null): string {
  return [
    value?.error?.type,
    value?.error?.message,
    value?.task?.error?.code,
    value?.task?.error?.message,
  ]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function normalizedFailure(input: {
  status: number;
  body: HailuoH3Response | null;
  phase: "submit" | "generation";
  vendorJobId?: string;
}): MediaGenRuntimeVendorJob {
  const text = errorText(input.body);
  const common = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (input.status === 401 || input.status === 403 || /authorized|credential/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "MiniMax credentials were rejected.",
    };
  }
  if (input.status === 402 || input.status === 429 || /balance|quota|rate.?limit/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "MiniMax balance, quota, or rate capacity is unavailable.",
    };
  }
  if (input.status === 422 || /sensitive|content.?policy|safety|blocked/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "content_blocked",
      message: "MiniMax content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "MiniMax rejected the documented H3 create request."
        : "The MiniMax H3 generation could not be reconciled.",
  };
}

function withObservation(
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
      routeId: HAILUO_H3_ROUTE_ID,
      adapterRevision: HAILUO_H3_ADAPTER_REVISION,
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

export function createHailuoH3RuntimeVendor(
  options: HailuoH3RuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? HAILUO_H3_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const taskUrl = `${baseUrl}/v2/video_generation`;
  const queryUrl = `${baseUrl}/v2/query/video_generation`;

  const query = async (
    vendorJobId: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const startedAtMs = now().getTime();
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      withObservation(job, { operation, outcome, startedAtMs, finishedAt: now() });
    if (!JOB_ID.test(vendorJobId)) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "The MiniMax H3 task receipt is invalid.",
        },
        "failed",
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${queryUrl}/${encodeURIComponent(vendorJobId)}`, {
        method: "GET",
        headers: headers(options.apiKey),
      });
    } catch {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    const json = (await response.json().catch(() => null)) as HailuoH3Response | null;
    if (!response.ok) {
      return observed(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "generation",
          vendorJobId,
        }),
        "failed",
      );
    }
    const task = json?.task;
    if (
      !task ||
      task.id !== vendorJobId ||
      task.model !== HAILUO_H3_MODEL_ID ||
      typeof task.status !== "string"
    ) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "MiniMax returned an unreadable or mismatched H3 task receipt.",
        },
        "failed",
      );
    }
    if (task.status === "queued" || task.status === "running") {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    if (task.status === "cancelled") {
      return observed({ state: "canceled", vendorJobId }, "canceled");
    }
    if (task.status === "failed" || task.status === "expired") {
      return observed(
        normalizedFailure({
          status: response.status,
          body: json,
          phase: "generation",
          vendorJobId,
        }),
        "failed",
      );
    }
    if (task.status === "succeeded") {
      const mediaRef = httpsUrl(task.content?.url);
      if (
        !mediaRef ||
        task.resolution !== "2K" ||
        typeof task.duration !== "number" ||
        !Number.isInteger(task.duration) ||
        task.duration < 4 ||
        task.duration > 15
      ) {
        return observed(
          {
            state: "failed",
            vendorJobId,
            reason: "download_failed",
            message: "MiniMax H3 completed without the frozen retrievable 2K MP4 output.",
          },
          "failed",
        );
      }
      return observed(
        {
          state: "succeeded",
          vendorJobId,
          output: {
            mediaRef,
            mimeType: "video/mp4",
            durationSec: task.duration,
            resolution: task.resolution,
          },
        },
        "succeeded",
      );
    }
    return observed(
      {
        state: "failed",
        vendorJobId,
        reason: "vendor_failed",
        message: "MiniMax returned an unknown H3 task status.",
      },
      "failed",
    );
  };

  return {
    presetId: "hailuo",
    capabilityRouteClaims:
      baseUrl === HAILUO_H3_DEFAULT_BASE_URL
        ? [
            {
              presetId: "hailuo",
              mode: "image2video",
              route: {
                schemaVersion: 1,
                routeId: HAILUO_H3_ROUTE_ID,
                providerId: "minimax",
                modelId: HAILUO_H3_MODEL_ID,
                endpointId: HAILUO_H3_ENDPOINT_ID,
                region: "global",
                accountTier: "api_key",
              },
              adapterRevision: HAILUO_H3_ADAPTER_REVISION,
            },
          ]
        : undefined,
    supportsMultiReference: true,
    requiresFrozenPlan: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const compiled = compileHailuoH3Request(input);
      if (!compiled.ok) {
        return { state: "failed", reason: "vendor_rejected", message: compiled.message };
      }
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
            message: "MiniMax H3 create may have been accepted; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          { operation: "submit", outcome: "submission_unknown", startedAtMs, finishedAt: now() },
        );
      }
      const json = (await response.json().catch(() => null)) as HailuoH3Response | null;
      if (!response.ok) {
        return withObservation(
          {
            ...normalizedFailure({ status: response.status, body: json, phase: "submit" }),
            providerRequestDigest: compiled.providerRequestDigest,
          },
          { operation: "submit", outcome: "failed", startedAtMs, finishedAt: now() },
        );
      }
      const id = typeof json?.task_id === "string" ? json.task_id.trim() : "";
      if (!JOB_ID.test(id)) {
        return withObservation(
          {
            state: "submission_unknown",
            message:
              "MiniMax H3 create returned no durable task receipt; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          { operation: "submit", outcome: "submission_unknown", startedAtMs, finishedAt: now() },
        );
      }
      return withObservation(
        {
          state: "processing",
          vendorJobId: id,
          providerRequestDigest: compiled.providerRequestDigest,
        },
        { operation: "submit", outcome: "processing", startedAtMs, finishedAt: now() },
      );
    },
    poll: (vendorJobId) => query(vendorJobId, "poll"),
    reconcile: (vendorJobId) => query(vendorJobId, "reconcile"),
    async cancel(vendorJobId) {
      if (!JOB_ID.test(vendorJobId)) {
        throw new Error("The MiniMax H3 task receipt is invalid.");
      }
      const statusResponse = await fetchImpl(`${queryUrl}/${encodeURIComponent(vendorJobId)}`, {
        method: "GET",
        headers: headers(options.apiKey),
      });
      const statusJson = (await statusResponse.json().catch(() => null)) as HailuoH3Response | null;
      if (
        !statusResponse.ok ||
        statusJson?.task?.id !== vendorJobId ||
        statusJson.task.status !== "queued"
      ) {
        throw new Error("MiniMax H3 can cancel only a queued task.");
      }
      const response = await fetchImpl(`${taskUrl}/${encodeURIComponent(vendorJobId)}`, {
        method: "DELETE",
        headers: headers(options.apiKey),
      });
      const json = (await response.json().catch(() => null)) as HailuoH3Response | null;
      if (
        !response.ok ||
        json?.task_id !== vendorJobId ||
        json.action !== "cancel" ||
        json.status !== "cancelled"
      ) {
        throw new Error("MiniMax H3 did not confirm queued-task cancellation.");
      }
    },
  };
}
