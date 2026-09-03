import type { GoogleCloudAccessTokenProvider } from "./google-cloud-auth.js";
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
  compileVeo31I2vRequest,
  VEO31_I2V_ADAPTER_REVISION,
  VEO31_I2V_ROUTE_ID,
} from "./veo3-1-i2v-compiler.js";
import {
  compileVeo31T2vRequest,
  VEO31_T2V_ADAPTER_REVISION,
  VEO31_T2V_ENDPOINT_ID,
  VEO31_T2V_MODEL_ID,
  VEO31_T2V_ROUTE_ID,
} from "./veo3-1-t2v-compiler.js";

export const VEO_VERTEX_LOCATION = "us-central1";
export const VEO_VERTEX_BASE_URL = `https://${VEO_VERTEX_LOCATION}-aiplatform.googleapis.com/v1`;
export const VEO31_I2V_JOB_PREFIX = "veo31-i2v:";

export type VeoRuntimeVendorOptions = {
  projectId: string;
  accessTokenProvider: GoogleCloudAccessTokenProvider;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
  maxOutputBytes?: number;
};

type VeoResponse = {
  name?: unknown;
  done?: unknown;
  error?: { code?: unknown; status?: unknown; message?: unknown } | null;
  response?: {
    raiMediaFilteredCount?: unknown;
    raiMediaFilteredReasons?: unknown;
    videos?: unknown;
  } | null;
};

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._~-]{0,199}$/u;
const BASE64 = /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/u;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

type VeoRouteIdentity = {
  routeId: string;
  adapterRevision: string;
};

const VEO31_T2V_IDENTITY: VeoRouteIdentity = {
  routeId: VEO31_T2V_ROUTE_ID,
  adapterRevision: VEO31_T2V_ADAPTER_REVISION,
};
const VEO31_I2V_IDENTITY: VeoRouteIdentity = {
  routeId: VEO31_I2V_ROUTE_ID,
  adapterRevision: VEO31_I2V_ADAPTER_REVISION,
};

export function googleCloudProjectIdValid(value: string): boolean {
  return PROJECT_ID.test(value.trim());
}

function resourceName(projectId: string): string {
  return `projects/${projectId}/locations/${VEO_VERTEX_LOCATION}/publishers/google/models/${VEO31_T2V_MODEL_ID}`;
}

function operationName(projectId: string, operationId: string): string {
  return `${resourceName(projectId)}/operations/${operationId}`;
}

function operationIdFromName(projectId: string, value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const prefix = `${resourceName(projectId)}/operations/`;
  const id = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  return OPERATION_ID.test(id) ? id : null;
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function errorText(value: VeoResponse | null): string {
  if (!value?.error) {
    return "";
  }
  return [value.error.status, value.error.message]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function normalizedFailure(input: {
  status: number;
  body: VeoResponse | null;
  phase: "submit" | "generation";
  vendorJobId?: string;
}): MediaGenRuntimeVendorJob {
  const text = errorText(input.body);
  const common = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (
    input.status === 401 ||
    input.status === 403 ||
    /unauthenticated|permission_denied|credential/iu.test(text)
  ) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "Vertex AI credentials were rejected.",
    };
  }
  if (input.status === 429 || /resource_exhausted|quota|rate.?limit/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "Vertex AI quota or rate capacity is unavailable.",
    };
  }
  if (/safety|responsible.?ai|filtered|blocked|policy|violat/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "content_blocked",
      message: "Vertex AI content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "Vertex AI rejected the documented Veo request."
        : "The Veo generation could not be reconciled.",
  };
}

function withObservation(
  job: MediaGenRuntimeVendorJob,
  identity: VeoRouteIdentity,
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

function routeForInput(input: MediaGenRuntimeVendorInput): VeoRouteIdentity {
  return input.mode === "image2video" ? VEO31_I2V_IDENTITY : VEO31_T2V_IDENTITY;
}

function decodeJobReceipt(receipt: string): {
  operationId: string;
  identity: VeoRouteIdentity;
} {
  return receipt.startsWith(VEO31_I2V_JOB_PREFIX)
    ? {
        operationId: receipt.slice(VEO31_I2V_JOB_PREFIX.length),
        identity: VEO31_I2V_IDENTITY,
      }
    : { operationId: receipt, identity: VEO31_T2V_IDENTITY };
}

function inlineVideoRef(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0 || !BASE64.test(value)) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (!Number.isInteger(decodedLength) || decodedLength <= 0 || decodedLength > maxBytes) {
    return null;
  }
  return `data:video/mp4;base64,${value}`;
}

export function createVeoRuntimeVendor(options: VeoRuntimeVendorOptions): MediaGenRuntimeVendor {
  const projectId = options.projectId.trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const modelUrl = `${VEO_VERTEX_BASE_URL}/${resourceName(projectId)}`;

  const query = async (
    vendorJobId: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const receipt = decodeJobReceipt(vendorJobId);
    const startedAtMs = now().getTime();
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      withObservation(job, receipt.identity, {
        operation,
        outcome,
        startedAtMs,
        finishedAt: now(),
      });
    if (!OPERATION_ID.test(receipt.operationId)) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "The Veo operation receipt is invalid.",
        },
        "failed",
      );
    }
    let token: string;
    try {
      token = await options.accessTokenProvider();
    } catch {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "auth",
          message: "Vertex AI Application Default Credentials are unavailable.",
        },
        "failed",
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${modelUrl}:fetchPredictOperation`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ operationName: operationName(projectId, receipt.operationId) }),
      });
    } catch {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    const json = (await response.json().catch(() => null)) as VeoResponse | null;
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
    if (json?.done === false && json.error == null && json.response == null) {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    if (json?.done !== true) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "Vertex AI returned an unknown Veo operation state.",
        },
        "failed",
      );
    }
    if (json.error) {
      if (json.error.code === 1 || json.error.status === "CANCELLED") {
        return observed({ state: "canceled", vendorJobId }, "canceled");
      }
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
    const filtered = json.response?.raiMediaFilteredCount;
    const reasons = json.response?.raiMediaFilteredReasons;
    if (
      (typeof filtered === "number" && filtered > 0) ||
      (Array.isArray(reasons) && reasons.length > 0)
    ) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "content_blocked",
          message: "Vertex AI safety filters rejected the generated video.",
        },
        "failed",
      );
    }
    const videos = json.response?.videos;
    if (!Array.isArray(videos) || videos.length !== 1) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "download_failed",
          message: "Vertex AI completed without one retrievable Veo video.",
        },
        "failed",
      );
    }
    const video = videos[0];
    if (!video || typeof video !== "object" || Array.isArray(video)) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "download_failed",
          message: "Vertex AI returned an unreadable Veo video output.",
        },
        "failed",
      );
    }
    const row = video as Record<string, unknown>;
    const mediaRef =
      row.gcsUri === undefined && row.mimeType === "video/mp4"
        ? inlineVideoRef(row.bytesBase64Encoded, maxOutputBytes)
        : null;
    if (!mediaRef) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "download_failed",
          message: "Vertex AI did not return the frozen inline MP4 output.",
        },
        "failed",
      );
    }
    return observed(
      {
        state: "succeeded",
        vendorJobId,
        output: { mediaRef, mimeType: "video/mp4" },
      },
      "succeeded",
    );
  };

  return {
    presetId: "veo",
    capabilityRouteClaims: [
      {
        presetId: "veo",
        mode: "text2video",
        route: {
          schemaVersion: 1,
          routeId: VEO31_T2V_ROUTE_ID,
          providerId: "google_vertex_ai",
          modelId: VEO31_T2V_MODEL_ID,
          endpointId: VEO31_T2V_ENDPOINT_ID,
          region: VEO_VERTEX_LOCATION,
          accountTier: "adc",
        },
        adapterRevision: VEO31_T2V_ADAPTER_REVISION,
      },
    ],
    // Local executor support remains true so already-frozen I2V work can
    // resolve sources[]. Factory projection requires an advertised image claim
    // before exposing this bit to Control API.
    supportsMultiReference: true,
    requiresFrozenPlan: true,
    isConfigured() {
      return googleCloudProjectIdValid(projectId);
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const identity = routeForInput(input);
      const compiled =
        input.mode === "image2video"
          ? compileVeo31I2vRequest(input)
          : compileVeo31T2vRequest(input);
      if (!compiled.ok) {
        return { state: "failed", reason: "vendor_rejected", message: compiled.message };
      }
      const startedAtMs = now().getTime();
      let token: string;
      try {
        token = await options.accessTokenProvider();
      } catch {
        return withObservation(
          {
            state: "failed",
            reason: "auth",
            message: "Vertex AI Application Default Credentials are unavailable.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          identity,
          { operation: "submit", outcome: "failed", startedAtMs, finishedAt: now() },
        );
      }
      let response: Response;
      try {
        response = await fetchImpl(`${modelUrl}:predictLongRunning`, {
          method: "POST",
          headers: headers(token),
          body: JSON.stringify(compiled.body),
        });
      } catch {
        return withObservation(
          {
            state: "submission_unknown",
            message: "Veo create may have been accepted; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          identity,
          {
            operation: "submit",
            outcome: "submission_unknown",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      const json = (await response.json().catch(() => null)) as VeoResponse | null;
      if (!response.ok) {
        return withObservation(
          {
            ...normalizedFailure({ status: response.status, body: json, phase: "submit" }),
            providerRequestDigest: compiled.providerRequestDigest,
          },
          identity,
          { operation: "submit", outcome: "failed", startedAtMs, finishedAt: now() },
        );
      }
      const operationId = operationIdFromName(projectId, json?.name);
      if (!operationId) {
        return withObservation(
          {
            state: "submission_unknown",
            message: "Veo create returned no exact operation receipt; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          identity,
          {
            operation: "submit",
            outcome: "submission_unknown",
            startedAtMs,
            finishedAt: now(),
          },
        );
      }
      const vendorJobId =
        input.mode === "image2video" ? `${VEO31_I2V_JOB_PREFIX}${operationId}` : operationId;
      return withObservation(
        {
          state: "processing",
          vendorJobId,
          providerRequestDigest: compiled.providerRequestDigest,
        },
        identity,
        { operation: "submit", outcome: "processing", startedAtMs, finishedAt: now() },
      );
    },
    poll: (vendorJobId) => query(vendorJobId, "poll"),
    reconcile: (vendorJobId) => query(vendorJobId, "reconcile"),
    // The documented Veo predictLongRunning/fetchPredictOperation surface does
    // not expose a verified cancellation RPC. Do not claim remote cancellation.
  };
}
