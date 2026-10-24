import {
  compileKlingApiKeyI2VRequest,
  KLING_APIKEY_2_6_I2V_ADAPTER_REVISION,
  KLING_APIKEY_2_6_I2V_ENDPOINT_ID,
  KLING_APIKEY_2_6_I2V_MODEL_ID,
  KLING_APIKEY_2_6_I2V_ROUTE_ID,
} from "./kling-apikey-i2v-compiler.js";
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

const DEFAULT_BASE_URL = "https://api-singapore.klingai.com";

export type KlingApiKeyI2VVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
};

function authHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey.trim()}`,
    "content-type": "application/json",
  };
}

function normalizedError(
  status: number,
  code: number | undefined,
  message: string | undefined,
): {
  reason: "auth" | "quota" | "vendor_rejected" | "vendor_failed" | "content_blocked";
  message: string;
} {
  const msg = message ?? "";
  if (status === 401 || status === 403 || code === 1103) {
    return {
      reason: "auth",
      message: `Kling authentication failure: ${msg || "Invalid API key or permissions."}`,
    };
  }
  if (
    status === 429 &&
    (code === 1101 || code === 1102 || /quota|credit|balance|余额|欠费|资源包/iu.test(msg))
  ) {
    return {
      reason: "quota",
      message: `Kling quota depleted: ${msg || "Account balance or quota unavailable."}`,
    };
  }
  if (/sensitive|moderation|policy|violat|审核|敏感|违规/iu.test(msg)) {
    return {
      reason: "content_blocked",
      message: `Kling content moderation blocked request: ${msg}`,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      reason: "vendor_rejected",
      message: `Kling rejected request (${code ?? status}): ${msg}`,
    };
  }
  return { reason: "vendor_failed", message: `Kling service failure (${code ?? status}): ${msg}` };
}

export function createKlingApiKeyI2VVendor(
  options: KlingApiKeyI2VVendorOptions,
): MediaGenRuntimeVendor {
  const apiKey = options.apiKey.trim();
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const fetchFn = options.fetchImpl ?? fetch;

  const observed = (
    job: MediaGenRuntimeVendorJob,
    outcome: MediaGenProviderRuntimeOutcome,
    operation: MediaGenProviderRuntimeOperation = "poll",
  ): MediaGenRuntimeVendorJob => {
    const finishedAt = new Date();
    return {
      ...job,
      providerObservation: providerObservation({
        operation,
        routeId: KLING_APIKEY_2_6_I2V_ROUTE_ID,
        adapterRevision: KLING_APIKEY_2_6_I2V_ADAPTER_REVISION,
        outcome,
        startedAtMs: finishedAt.getTime() - 100,
        finishedAt,
      }),
    };
  };

  const submit = async (input: MediaGenRuntimeVendorInput): Promise<MediaGenRuntimeVendorJob> => {
    const compiled = compileKlingApiKeyI2VRequest(input);
    if (!compiled.ok) {
      return observed(
        {
          state: "failed",
          vendorJobId: "unassigned",
          reason: "vendor_rejected",
          message: compiled.message,
          retryDisposition: "not_retryable",
        },
        "failed",
        "submit",
      );
    }

    const endpoint = `${baseUrl}/image-to-video/kling-2.6`;
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify(compiled.body),
      });
    } catch (err) {
      return observed(
        {
          state: "failed",
          vendorJobId: "unassigned",
          reason: "vendor_failed",
          message: `Network error calling Kling 2.6: ${err instanceof Error ? err.message : String(err)}`,
          retryDisposition: "reconcile_only",
        },
        "failed",
        "submit",
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      return observed(
        {
          state: "failed",
          vendorJobId: "unassigned",
          reason: "vendor_failed",
          message: `Kling 2.6 returned non-JSON response with HTTP ${response.status}`,
          retryDisposition: "reconcile_only",
        },
        "failed",
        "submit",
      );
    }

    if (!response.ok || json.code !== 0) {
      const err = normalizedError(response.status, json.code, json.message);
      return observed(
        {
          state: "failed",
          vendorJobId: "unassigned",
          reason: err.reason,
          message: err.message,
          retryDisposition:
            err.reason === "quota" || err.reason === "auth"
              ? "not_retryable"
              : "replacement_allowed",
        },
        "failed",
        "submit",
      );
    }

    const rawId = json.data?.id ?? json.data?.task_id;
    if (!rawId) {
      return observed(
        {
          state: "failed",
          vendorJobId: "unassigned",
          reason: "vendor_failed",
          message: "Kling 2.6 did not return a valid task ID in response.",
          retryDisposition: "reconcile_only",
        },
        "failed",
        "submit",
      );
    }

    const vendorJobId = String(rawId);
    const initialStatus = json.data?.status;

    if (initialStatus === "succeeded") {
      const outputs = json.data?.outputs ?? [];
      const videoOutput = outputs.find((o: any) => o.type === "video");
      const videoUrl = videoOutput?.url;
      if (typeof videoUrl === "string" && videoUrl.startsWith("http")) {
        return observed(
          {
            state: "succeeded",
            vendorJobId,
            output: { mediaRef: videoUrl, mimeType: "video/mp4" },
          },
          "succeeded",
          "submit",
        );
      }
    }

    return observed({ state: "processing", vendorJobId }, "submitted", "submit");
  };

  const queryJob = async (
    vendorJobId: string,
    operation: "poll" | "reconcile",
  ): Promise<MediaGenRuntimeVendorJob> => {
    const endpoint = `${baseUrl}/tasks?task_ids=${encodeURIComponent(vendorJobId)}`;
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: "GET",
        headers: authHeaders(apiKey),
      });
    } catch (err) {
      return observed(
        {
          state: "processing",
          vendorJobId,
          message: `Network error querying Kling 2.6: ${err instanceof Error ? err.message : String(err)}`,
        },
        "processing",
        operation,
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      return observed({ state: "processing", vendorJobId }, "processing", operation);
    }

    if (!response.ok || json.code !== 0) {
      const err = normalizedError(response.status, json.code, json.message);
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: err.reason,
          message: err.message,
          retryDisposition: "reconcile_only",
        },
        "failed",
        operation,
      );
    }

    const tasks = Array.isArray(json.data) ? json.data : json.data?.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: `Task ${vendorJobId} not found in Kling query.`,
          retryDisposition: "reconcile_only",
        },
        "failed",
        operation,
      );
    }

    const task = tasks.find((t: any) => String(t.id) === String(vendorJobId)) ?? tasks[0];
    const status = task.status;

    if (status === "submitted" || status === "processing") {
      return observed({ state: "processing", vendorJobId }, "processing", operation);
    }

    if (status === "succeeded") {
      const outputs = task.outputs ?? [];
      const videoOutput = outputs.find((o: any) => o.type === "video");
      const videoUrl = videoOutput?.url;
      if (typeof videoUrl !== "string" || !videoUrl.startsWith("http")) {
        return observed(
          {
            state: "failed",
            vendorJobId,
            reason: "download_failed",
            message: "Kling task succeeded but output video url is missing.",
            retryDisposition: "reconcile_only",
          },
          "failed",
          operation,
        );
      }
      return observed(
        {
          state: "succeeded",
          vendorJobId,
          output: { mediaRef: videoUrl, mimeType: "video/mp4" },
        },
        "succeeded",
        operation,
      );
    }

    if (status === "failed") {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: task.error_message || "Kling 2.6 task generation failed.",
          retryDisposition: "replacement_allowed",
        },
        "failed",
        operation,
      );
    }

    return observed({ state: "processing", vendorJobId }, "processing", operation);
  };

  const poll = async (job: MediaGenRuntimeVendorJob): Promise<MediaGenRuntimeVendorJob> => {
    return queryJob(job.vendorJobId, "poll");
  };

  const reconcile = async (input: { vendorJobId: string }): Promise<MediaGenRuntimeVendorJob> => {
    return queryJob(input.vendorJobId, "reconcile");
  };

  return {
    presetId: "kling",
    capabilityRouteClaims: [
      {
        presetId: "kling",
        mode: "image2video",
        route: {
          schemaVersion: 1,
          routeId: KLING_APIKEY_2_6_I2V_ROUTE_ID,
          providerId: "kling_open_platform",
          modelId: KLING_APIKEY_2_6_I2V_MODEL_ID,
          endpointId: KLING_APIKEY_2_6_I2V_ENDPOINT_ID,
          region: "global",
          accountTier: "api_key",
        },
        adapterRevision: KLING_APIKEY_2_6_I2V_ADAPTER_REVISION,
      },
    ],
    submit,
    poll,
    reconcile,
  };
}
