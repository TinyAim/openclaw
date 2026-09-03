import {
  providerObservation,
  type MediaGenProviderRuntimeOperation,
  type MediaGenProviderRuntimeOutcome,
} from "./provider-observation.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorCancelResult,
  MediaGenRuntimeVendorJob,
} from "./types.js";
import {
  decodeWanJobReceipt,
  encodeWanJobReceipt,
  routeForWanInput,
  routeForWanReceipt,
  WAN22_FIRST_LAST_RUNTIME_ROUTE,
  WAN22_I2V_RUNTIME_ROUTE,
  WAN22_T2V_RUNTIME_ROUTE,
  wanCapabilityRouteClaims,
  wanProviderJobIdValid,
  type WanRuntimeRoute,
} from "./wan-runtime-routes.js";
import { compileWan22FirstLastRequest } from "./wan2-2-first-last-frame-compiler.js";
import { compileWan22I2vRequest } from "./wan2-2-i2v-compiler.js";
import { compileWan22T2vRequest } from "./wan2-2-t2v-compiler.js";

export { WAN22_FIRST_LAST_JOB_PREFIX, WAN22_I2V_JOB_PREFIX } from "./wan-runtime-routes.js";

export const WAN_DASHSCOPE_LEGACY_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

const DASHSCOPE_WORKSPACE_ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u;

/** Build only the official China (Beijing) workspace-specific API root. */
export function wanDashScopeWorkspaceBaseUrl(workspaceId: string | undefined): string | null {
  const normalized = workspaceId?.trim().toLowerCase() ?? "";
  return DASHSCOPE_WORKSPACE_ID.test(normalized)
    ? `https://${normalized}.cn-beijing.maas.aliyuncs.com/api/v1`
    : null;
}

export type WanRuntimeVendorOptions = {
  apiKey: string;
  /** Alibaba Cloud Model Studio WorkspaceId, not a Wisclaw workspace id. */
  workspaceId?: string;
  /** Read-old/test seam. Exact V2 claims require equality with the derived workspace URL. */
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

type WanTaskResponse = {
  code?: unknown;
  message?: unknown;
  output?: {
    task_id?: unknown;
    task_status?: unknown;
    video_url?: unknown;
    code?: unknown;
    message?: unknown;
  } | null;
};

function headers(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function errorText(value: WanTaskResponse | null): string {
  if (!value) {
    return "";
  }
  return [value.code, value.message, value.output?.code, value.output?.message]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function normalizedFailure(input: {
  status: number;
  body: WanTaskResponse | null;
  phase: "submit" | "generation";
  vendorJobId?: string;
}): MediaGenRuntimeVendorJob {
  const text = errorText(input.body);
  const common = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (input.status === 401 || input.status === 403 || /invalid.?api.?key/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "DashScope credentials were rejected.",
    };
  }
  if (input.status === 429 || /quota|throttl|rate.?limit|balance/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "DashScope quota or rate capacity is unavailable.",
    };
  }
  if (/data.?inspection|content|safety|moderation|blocked|violat/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "content_blocked",
      message: "DashScope content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "DashScope rejected the documented Wan create request."
        : "The Wan generation could not be reconciled.",
  };
}

function withObservation(
  job: MediaGenRuntimeVendorJob,
  route: WanRuntimeRoute,
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

export function createWanRuntimeVendor(options: WanRuntimeVendorOptions): MediaGenRuntimeVendor {
  const workspaceBaseUrl = wanDashScopeWorkspaceBaseUrl(options.workspaceId);
  if (options.workspaceId !== undefined && !workspaceBaseUrl) {
    throw new Error("The DashScope WorkspaceId is not a valid DNS workspace label.");
  }
  const baseUrl = (options.baseUrl ?? workspaceBaseUrl ?? WAN_DASHSCOPE_LEGACY_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const usesExactWorkspaceBase = workspaceBaseUrl !== null && baseUrl === workspaceBaseUrl;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  const query = async (
    vendorJobId: string,
    operation: MediaGenProviderRuntimeOperation,
  ): Promise<MediaGenRuntimeVendorJob> => {
    const startedAtMs = now().getTime();
    const decoded = decodeWanJobReceipt(vendorJobId);
    const route = routeForWanReceipt(vendorJobId);
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      withObservation(job, route, { operation, outcome, startedAtMs, finishedAt: now() });
    if (!decoded) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "The Wan task receipt is invalid or belongs to an unsupported route.",
        },
        "failed",
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/tasks/${encodeURIComponent(decoded.providerJobId)}`, {
        method: "GET",
        headers: headers(options.apiKey),
      });
    } catch {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    const json = (await response.json().catch(() => null)) as WanTaskResponse | null;
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
    const status = typeof json?.output?.task_status === "string" ? json.output.task_status : "";
    if (status === "PENDING" || status === "RUNNING") {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    if (status === "FAILED") {
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
    if (status === "CANCELED") {
      return observed({ state: "canceled", vendorJobId }, "canceled");
    }
    if (status === "SUCCEEDED") {
      const video = httpsUrl(json?.output?.video_url);
      if (!video) {
        return observed(
          {
            state: "failed",
            vendorJobId,
            reason: "download_failed",
            message: "DashScope completed without a retrievable HTTPS video output.",
          },
          "failed",
        );
      }
      return observed(
        {
          state: "succeeded",
          vendorJobId,
          output: { mediaRef: video, mimeType: "video/mp4", durationSec: 5 },
        },
        "succeeded",
      );
    }
    return observed(
      {
        state: "failed",
        vendorJobId,
        reason: "vendor_failed",
        message:
          status === "UNKNOWN"
            ? "DashScope no longer recognizes this Wan task receipt."
            : "DashScope returned an unknown Wan task state.",
      },
      "failed",
    );
  };

  return {
    presetId: "wan",
    capabilityRouteClaims: usesExactWorkspaceBase ? [...wanCapabilityRouteClaims()] : undefined,
    // I2V/KF2V still consume typed `sources[]` for frozen local receipts. The
    // factory advertises this bit only when an image claim survives admission;
    // current public claims intentionally contain T2V only.
    supportsMultiReference: true,
    requiresFrozenPlan: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const route = routeForWanInput(input);
      if (!route) {
        return {
          state: "failed",
          reason: "vendor_rejected",
          message: "The frozen plan does not select an implemented exact Wan route.",
        };
      }
      if (route === WAN22_T2V_RUNTIME_ROUTE && !usesExactWorkspaceBase) {
        return {
          state: "failed",
          reason: "vendor_rejected",
          message:
            "Wan 2.2 Text-to-Video V2 requires an explicit DashScope WorkspaceId bound to the China (Beijing) workspace endpoint.",
        };
      }
      const compiled =
        route === WAN22_FIRST_LAST_RUNTIME_ROUTE
          ? compileWan22FirstLastRequest(input)
          : route === WAN22_I2V_RUNTIME_ROUTE
            ? compileWan22I2vRequest(input)
            : compileWan22T2vRequest(input);
      if (!compiled.ok) {
        return { state: "failed", reason: "vendor_rejected", message: compiled.message };
      }
      const startedAtMs = now().getTime();
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${route.submitPath}`, {
          method: "POST",
          headers: { ...headers(options.apiKey), "x-dashscope-async": "enable" },
          body: JSON.stringify(compiled.body),
        });
      } catch {
        return withObservation(
          {
            state: "submission_unknown",
            message: "Wan create may have been accepted; reconciliation is required.",
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
      const json = (await response.json().catch(() => null)) as WanTaskResponse | null;
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
      const rawTaskId = typeof json?.output?.task_id === "string" ? json.output.task_id.trim() : "";
      const taskId = wanProviderJobIdValid(rawTaskId) ? encodeWanJobReceipt(route, rawTaskId) : "";
      const taskStatus =
        typeof json?.output?.task_status === "string" ? json.output.task_status : "";
      if (!taskId) {
        return withObservation(
          {
            state: "submission_unknown",
            message: "Wan create returned no durable task receipt; reconciliation is required.",
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
      if (taskStatus !== "PENDING" && taskStatus !== "RUNNING") {
        return withObservation(
          {
            state: "failed",
            vendorJobId: taskId,
            reason: "vendor_rejected",
            message: "DashScope returned an invalid Wan create state.",
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
      return withObservation(
        {
          state: "processing",
          vendorJobId: taskId,
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
    async cancel(vendorJobId): Promise<MediaGenRuntimeVendorCancelResult> {
      const decoded = decodeWanJobReceipt(vendorJobId);
      if (!decoded) {
        throw new Error("The Wan task receipt is invalid or belongs to an unsupported route.");
      }
      const startedAtMs = now().getTime();
      const observed = (
        state: MediaGenRuntimeVendorCancelResult["state"],
        outcome: MediaGenProviderRuntimeOutcome,
      ): MediaGenRuntimeVendorCancelResult => ({
        state,
        providerObservation: providerObservation({
          routeId: decoded.route.routeId,
          adapterRevision: decoded.route.adapterRevision,
          operation: "cancel",
          outcome,
          startedAtMs,
          finishedAt: now(),
        }),
      });
      const taskUrl = `${baseUrl}/tasks/${encodeURIComponent(decoded.providerJobId)}`;
      let statusResponse: Response;
      try {
        statusResponse = await fetchImpl(taskUrl, {
          method: "GET",
          headers: headers(options.apiKey),
        });
      } catch {
        return observed("unknown", "processing");
      }
      const statusJson = (await statusResponse.json().catch(() => null)) as WanTaskResponse | null;
      if (!statusResponse.ok) {
        return observed(
          statusResponse.status === 408 || statusResponse.status >= 500 ? "unknown" : "failed",
          "processing",
        );
      }
      const rawTaskId = statusJson?.output?.task_id;
      const taskStatus = statusJson?.output?.task_status;
      if (rawTaskId !== decoded.providerJobId) {
        return observed("unknown", "processing");
      }
      if (taskStatus === "CANCELED") {
        return observed("confirmed", "canceled");
      }
      if (taskStatus !== "PENDING") {
        return observed(
          taskStatus === "RUNNING" || taskStatus === "SUCCEEDED" || taskStatus === "FAILED"
            ? "failed"
            : "unknown",
          "processing",
        );
      }
      let response: Response;
      try {
        response = await fetchImpl(`${taskUrl}/cancel`, {
          method: "POST",
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
      return observed("requested", "processing");
    },
  };
}
