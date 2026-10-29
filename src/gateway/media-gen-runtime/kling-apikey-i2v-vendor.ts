import {
  compileKlingApiKeyI2VRequest,
  KLING_APIKEY_2_6_I2V_ADAPTER_REVISION,
  KLING_APIKEY_2_6_I2V_ENDPOINT_ID,
  KLING_APIKEY_2_6_I2V_MODEL_ID,
  KLING_APIKEY_2_6_I2V_ROUTE_ID,
  validateKlingApiKeyPreparationInput,
  type KlingApiKeyPreparedSubmission,
} from "./kling-apikey-i2v-compiler.js";
import { inspectKlingSourceFrames } from "./kling-source-inspection.js";
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

export const KLING_APIKEY_2_6_BASE_URL = "https://api-singapore.klingai.com";

export type KlingApiKeyI2VVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  /** Trusted runtime owner: authorize, prepare and reserve the exact attempt before returning. */
  prepareSubmission?: (input: MediaGenRuntimeVendorInput) => Promise<KlingSubmissionReservation>;
};

export type KlingSubmissionReservation =
  | { kind: "existing"; vendorJobId?: string; providerRequestDigest?: string }
  | {
      kind: "created";
      prepared: KlingApiKeyPreparedSubmission;
      bindRequest: (digest: string) => Promise<void> | void;
      bindVendorJob: (vendorJobId: string) => Promise<void> | void;
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
  const baseUrl = (options.baseUrl ?? KLING_APIKEY_2_6_BASE_URL).replace(/\/+$/u, "");
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
    const preflightError = validateKlingApiKeyPreparationInput(input);
    if (preflightError)
      return observed(
        { state: "failed", reason: "vendor_rejected", message: preflightError },
        "failed",
        "submit",
      );
    if (!options.prepareSubmission) {
      return observed(
        {
          state: "failed",
          reason: "vendor_rejected",
          message: "Kling source preparation and attempt correlation are unavailable.",
        },
        "failed",
        "submit",
      );
    }
    const inspected = await inspectKlingSourceFrames(input);
    if (!inspected.ok)
      return observed(
        {
          state: "failed",
          reason: "vendor_rejected",
          message: "Kling source image content is invalid or unsupported.",
        },
        "failed",
        "submit",
      );
    let reservation: KlingSubmissionReservation;
    try {
      reservation = await options.prepareSubmission(input);
    } catch (error) {
      // Preparation has its own durable owner and unknown-outcome state. Do not
      // turn its failure into a terminal video rejection or retry permission.
      throw new Error("Kling preparation outcome requires owner reconciliation.", { cause: error });
    }
    if (reservation.kind === "existing") {
      if (reservation.vendorJobId && reservation.providerRequestDigest)
        return observed(
          {
            state: "processing",
            vendorJobId: reservation.vendorJobId,
            providerRequestDigest: reservation.providerRequestDigest,
          },
          "processing",
          "submit",
        );
      if (!reservation.providerRequestDigest) {
        // No exact provider request has been durably bound. Keep this in the
        // preparation owner's reconciliation path instead of inventing a digest.
        throw new Error("Kling preparation outcome requires owner reconciliation.");
      }
      return observed(
        {
          state: "submission_unknown",
          providerRequestDigest: reservation.providerRequestDigest,
          message:
            "The original Kling attempt requires reconciliation; a second submit is prohibited.",
        },
        "submission_unknown",
        "submit",
      );
    }
    const { prepared } = reservation;
    if (
      prepared.frames.length !== inspected.frames.size ||
      prepared.frames.some((frame) => {
        const actual = inspected.frames.get(`${frame.role}:${frame.ordinal}`);
        return (
          !actual ||
          frame.width !== actual.width ||
          frame.height !== actual.height ||
          frame.byteLength !== actual.byteLength
        );
      })
    )
      return observed(
        {
          state: "failed",
          reason: "vendor_rejected",
          message: "Kling prepared image metadata differs from the inspected source.",
        },
        "failed",
        "submit",
      );
    const compiled = compileKlingApiKeyI2VRequest(input, prepared);
    if (!compiled.ok) {
      return observed(
        {
          state: "failed",
          reason: "vendor_rejected",
          message: compiled.message,
        },
        "failed",
        "submit",
      );
    }

    try {
      await reservation.bindRequest(compiled.providerRequestDigest);
    } catch {
      return observed(
        {
          state: "submission_unknown",
          message: "Kling request reservation could not be confirmed; no video request was sent.",
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "submission_unknown",
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
          state: "submission_unknown",
          message: `Network error calling Kling 2.6: ${err instanceof Error ? err.message : String(err)}`,
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "submission_unknown",
        "submit",
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      return observed(
        {
          state: "submission_unknown",
          message: `Kling 2.6 returned non-JSON response with HTTP ${response.status}`,
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "submission_unknown",
        "submit",
      );
    }

    if (!json || typeof json.code !== "number") {
      return observed(
        {
          state: "submission_unknown",
          message: "Kling returned an invalid submission receipt.",
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "submission_unknown",
        "submit",
      );
    }
    if (!response.ok || json.code !== 0) {
      const err = normalizedError(response.status, json.code, json.message);
      if (response.status >= 500) {
        return observed(
          {
            state: "submission_unknown",
            message: err.message,
            providerRequestDigest: compiled.providerRequestDigest,
          },
          "submission_unknown",
          "submit",
        );
      }
      return observed(
        {
          state: "failed",
          reason: err.reason,
          message: err.message,
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "failed",
        "submit",
      );
    }

    const rawId = json.data?.id ?? json.data?.task_id;
    if (typeof rawId !== "string" || !rawId.trim() || rawId !== rawId.trim()) {
      return observed(
        {
          state: "submission_unknown",
          message: "Kling 2.6 did not return a valid task ID in response.",
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "submission_unknown",
        "submit",
      );
    }

    const vendorJobId = rawId;
    try {
      await reservation.bindVendorJob(vendorJobId);
    } catch {
      return observed(
        {
          state: "submission_unknown",
          message: "Kling accepted a request but its task receipt could not be retained.",
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "submission_unknown",
        "submit",
      );
    }
    const initialStatus = json.data?.status;

    if (initialStatus === "succeeded") {
      const outputs = Array.isArray(json.data?.outputs) ? json.data.outputs : [];
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

    return observed(
      { state: "processing", vendorJobId, providerRequestDigest: compiled.providerRequestDigest },
      "processing",
      "submit",
    );
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
    } catch {
      return observed(
        {
          state: "processing",
          vendorJobId,
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

    if (!response.ok || !json || typeof json !== "object" || json.code !== 0) {
      // Query failure does not establish that the already accepted job failed.
      return observed({ state: "processing", vendorJobId }, "processing", operation);
    }

    const tasks = Array.isArray(json.data) ? json.data : json.data?.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return observed({ state: "processing", vendorJobId }, "processing", operation);
    }

    const matches = tasks.filter((t: any) => typeof t?.id === "string" && t.id === vendorJobId);
    if (matches.length !== 1)
      return observed({ state: "processing", vendorJobId }, "processing", operation);
    const task = matches[0];
    const status = task.status;

    if (status === "submitted" || status === "processing") {
      return observed({ state: "processing", vendorJobId }, "processing", operation);
    }

    if (status === "succeeded") {
      const outputs = Array.isArray(task.outputs) ? task.outputs : [];
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

  const poll = async (vendorJobId: string): Promise<MediaGenRuntimeVendorJob> => {
    return queryJob(vendorJobId, "poll");
  };

  const reconcile = async (vendorJobId: string): Promise<MediaGenRuntimeVendorJob> => {
    return queryJob(vendorJobId, "reconcile");
  };

  const routeClaim = {
    presetId: "kling",
    mode: "image2video" as const,
    route: {
      schemaVersion: 1 as const,
      routeId: KLING_APIKEY_2_6_I2V_ROUTE_ID,
      providerId: "kling_open_platform",
      modelId: KLING_APIKEY_2_6_I2V_MODEL_ID,
      endpointId: KLING_APIKEY_2_6_I2V_ENDPOINT_ID,
      region: "global",
      accountTier: "api_key",
    },
    adapterRevision: KLING_APIKEY_2_6_I2V_ADAPTER_REVISION,
  };

  return {
    presetId: "kling",
    isConfigured: () => Boolean(apiKey && options.prepareSubmission),
    requiresFrozenPlan: true,
    supportsMultiReference: true,
    capabilityRouteClaims: options.prepareSubmission ? [routeClaim] : [],
    // Existing provider receipts remain pollable even if new-source preparation is unavailable.
    recoverableRouteClaims: [routeClaim],
    submit,
    poll,
    reconcile,
  };
}
