import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";
import type { MediaGenRuntimeHttpExecutor } from "../media-gen-runtime-http.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeConfigError,
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
} from "./types.js";

export type MediaGenRuntimeEnv = Record<string, string | undefined>;

export type MediaGenRuntimeFromEnvResult =
  | {
      enabled: true;
      executor: MediaGenRuntimeHttpExecutor;
      startHeartbeat: () => () => void;
      supportedPresetIds: string[];
      enforcesModeration: boolean;
      appliesLabeling: boolean;
      supportsMultiReference: boolean;
    }
  | { enabled: false; reason: string };

export type MediaGenRuntimeFromEnvOptions = {
  env?: MediaGenRuntimeEnv;
  fetchImpl?: MediaGenRuntimeFetch;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
};

function envString(env: MediaGenRuntimeEnv, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function envList(env: MediaGenRuntimeEnv, key: string): string[] {
  return (env[key] ?? "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function envBool(env: MediaGenRuntimeEnv, key: string): boolean {
  return /^(1|true|yes|on)$/i.test(env[key]?.trim() ?? "");
}

function envNumber(env: MediaGenRuntimeEnv, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maybeKlingVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const accessKey = envString(env, "KLING_ACCESS_KEY", "OPENCLAW_KLING_ACCESS_KEY");
  const secret = envString(env, "KLING_SECRET", "OPENCLAW_KLING_SECRET");
  if (!accessKey || !secret) return null;
  return createKlingRuntimeVendor({
    accessKey,
    secret,
    baseUrl: envString(env, "KLING_BASE_URL", "OPENCLAW_KLING_BASE_URL") || undefined,
    fetchImpl,
  });
}

function maybeViduVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const apiKey = envString(env, "VIDU_API_KEY", "OPENCLAW_VIDU_API_KEY");
  if (!apiKey) return null;
  return createViduRuntimeVendor({
    apiKey,
    baseUrl: envString(env, "VIDU_BASE_URL", "OPENCLAW_VIDU_BASE_URL") || undefined,
    fetchImpl,
  });
}

function createBridge(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeBridge | null {
  const controlApiUrl = envString(
    env,
    "OPENCLAW_MEDIA_GEN_CONTROL_API_URL",
    "WISCLAW_CONTROL_API_URL",
    "CONTROL_API_BASE_URL",
  );
  const runtimeId = envString(env, "OPENCLAW_MEDIA_GEN_RUNTIME_ID", "MEDIAGEN_RUNTIME_ID");
  const token = envString(
    env,
    "OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN",
    "MEDIAGEN_RUNTIME_REGISTRATION_TOKEN",
  );
  if (!controlApiUrl || !runtimeId || !token) return null;
  return createControlApiMediaGenBridge({
    controlApiUrl,
    runtimeId,
    token,
    fetchImpl,
    maxReferenceBytes: envNumber(env, "OPENCLAW_MEDIA_GEN_MAX_REFERENCE_BYTES", 64 * 1024 * 1024),
  });
}

export function createOpenClawMediaGenRuntimeFromEnv(
  options: MediaGenRuntimeFromEnvOptions = {},
): MediaGenRuntimeFromEnvResult {
  const env = options.env ?? process.env;
  if (!envBool(env, "OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED")) {
    return { enabled: false, reason: "OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED is not set" };
  }
  const bridge = createBridge(env, options.fetchImpl);
  if (!bridge) {
    return { enabled: false, reason: "control-api URL, runtime id, or runtime token is missing" };
  }
  const vendors = [
    maybeKlingVendor(env, options.fetchImpl),
    maybeViduVendor(env, options.fetchImpl),
  ].filter((vendor): vendor is MediaGenRuntimeVendor => Boolean(vendor));
  if (vendors.length === 0) {
    return { enabled: false, reason: "no media-generation vendor credential is configured" };
  }
  const moderation = createWebhookModeration({
    moderationUrl: envString(env, "OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL") || undefined,
    token: envString(env, "OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN") || undefined,
    fetchImpl: options.fetchImpl,
  });
  const labeler = createWebhookLabeler({
    labelingUrl: envString(env, "OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL") || undefined,
    token: envString(env, "OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN") || undefined,
    fetchImpl: options.fetchImpl,
  });
  if (!moderation || !labeler) {
    return {
      enabled: false,
      reason:
        "media-generation moderation and labeling webhooks are required before enabling a vendor executor",
    };
  }
  const allowedMediaHosts = envList(env, "OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST");
  const executor = createOpenClawMediaGenRuntimeExecutor({
    bridge,
    vendors,
    moderation,
    labeler,
    fetchImpl: options.fetchImpl,
    allowedMediaHosts,
    allowInsecureMediaFetch: envBool(env, "OPENCLAW_MEDIA_GEN_ALLOW_INSECURE_FETCH"),
    maxMediaBytes: envNumber(env, "OPENCLAW_MEDIA_GEN_MAX_ARTIFACT_BYTES", 512 * 1024 * 1024),
    mediaFetchTimeoutMs: envNumber(env, "OPENCLAW_MEDIA_GEN_FETCH_TIMEOUT_MS", 120_000),
  });
  const supportedPresetIds = vendors.map((vendor) => vendor.presetId);
  const workspaces = envList(env, "OPENCLAW_MEDIA_GEN_WORKSPACE_IDS");
  const heartbeatMs = envNumber(env, "OPENCLAW_MEDIA_GEN_REGISTER_INTERVAL_MS", 60_000);
  const enforcesModeration = Boolean(moderation);
  const appliesLabeling = Boolean(labeler);
  // CP3 §8 honesty gate: advertise multi-reference ONLY when a configured vendor
  // truly maps a multi-slot input (e.g. Vidu subject images[]); the control plane
  // is fail-closed on this bit and only builds a references[] dispatch when true.
  const supportsMultiReference = vendors.some(
    (vendor) => vendor.supportsMultiReference === true,
  );

  return {
    enabled: true,
    executor,
    supportedPresetIds,
    enforcesModeration,
    appliesLabeling,
    supportsMultiReference,
    startHeartbeat() {
      if (workspaces.length === 0) {
        options.log?.warn?.(
          "media-gen runtime executor enabled but OPENCLAW_MEDIA_GEN_WORKSPACE_IDS is empty; registration heartbeat is disabled",
        );
        return () => {};
      }
      let stopped = false;
      const register = () => {
        for (const workspaceId of workspaces) {
          void bridge
            .register({
              workspaceId,
              supportedPresetIds,
              enforcesModeration,
              appliesLabeling,
              supportsMultiReference,
            })
            .then(() =>
              options.log?.info?.(
                `media-gen runtime heartbeat registered workspace=${workspaceId} runtime=${bridge.runtimeId}`,
              ),
            )
            .catch((error) => {
              if (!stopped) {
                options.log?.warn?.(
                  `media-gen runtime heartbeat failed workspace=${workspaceId}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            });
        }
      };
      register();
      const timer = setInterval(register, heartbeatMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

export type { MediaGenRuntimeConfigError };
