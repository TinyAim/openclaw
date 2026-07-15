import type { MediaGenRuntimeHttpExecutor } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import {
  parseMediaQualityGateMode,
  probeMediaQualityToolsAvailableSync,
} from "./media-quality-tools.js";
import { createMediaQualityValidator } from "./media-quality-validator.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeConfigError,
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
} from "./types.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";

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
  /** Test seam for the synchronous bootstrap tool probe. */
  probeMediaQualityTools?: typeof probeMediaQualityToolsAvailableSync;
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
  // Quality gate (P2): DEFAULT OFF until installer/bundle proves ffprobe/ffmpeg.
  // - off: no validation hook
  // - on: enable validation only when bootstrap finds both tools; otherwise
  //       warn and leave it off rather than labeling any artifact verified
  // - required: bootstrap probe; missing tools → executor disabled (no register)
  // Invalid tokens fail closed (do not default to on).
  const qualityModeParsed = parseMediaQualityGateMode(
    envString(env, "OPENCLAW_MEDIA_GEN_QUALITY_GATE") || "off",
  );
  if (typeof qualityModeParsed === "object" && "invalid" in qualityModeParsed) {
    return {
      enabled: false,
      reason: `invalid OPENCLAW_MEDIA_GEN_QUALITY_GATE=${JSON.stringify(qualityModeParsed.value)} (expected off|on|required)`,
    };
  }
  const qualityGate = qualityModeParsed;
  let validateMediaBytes:
    | import("./executor.js").MediaGenRuntimeExecutorOptions["validateMediaBytes"]
    | undefined;
  if (qualityGate === "required") {
    // Sync path: factory is sync today; required mode uses a blocking probe via
    // child_process spawnSync-equivalent through deasync-free approach: we run
    // a synchronous probe helper that uses spawnSync for bootstrap only.
    const tools = options.probeMediaQualityTools?.() ?? probeMediaQualityToolsAvailableSync();
    if (!tools.ok) {
      return {
        enabled: false,
        reason: `OPENCLAW_MEDIA_GEN_QUALITY_GATE=required but missing tools: ${tools.missing.join(", ")}`,
      };
    }
    const validator = createMediaQualityValidator({
      mode: "required",
      requireAudio: envBool(env, "OPENCLAW_MEDIA_GEN_QUALITY_REQUIRE_AUDIO"),
    });
    validateMediaBytes = async (input) => {
      const result = await validator(input);
      if (result.ok) return { ok: true as const };
      return {
        ok: false as const,
        code: result.code,
        message: result.message,
      };
    };
  } else if (qualityGate === "on") {
    const tools = options.probeMediaQualityTools?.() ?? probeMediaQualityToolsAvailableSync();
    if (!tools.ok) {
      options.log?.warn?.(
        `[media-gen-runtime] quality gate=on but tools missing (${tools.missing.join(", ")}); gate disabled until tools are installed`,
      );
    } else {
      const validator = createMediaQualityValidator({
        mode: "on",
        requireAudio: envBool(env, "OPENCLAW_MEDIA_GEN_QUALITY_REQUIRE_AUDIO"),
      });
      validateMediaBytes = async (input) => {
        const result = await validator(input);
        if (result.ok) {
          if (result.blackFrameCheckSkipped) {
            options.log?.warn?.(
              "[media-gen-runtime] quality gate=on skipped decoded-frame black validation; artifact is not quality-verified",
            );
          }
          return { ok: true as const };
        }
        return {
          ok: false as const,
          code: result.code,
          message: result.message,
        };
      };
    }
  }
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
    ...(validateMediaBytes ? { validateMediaBytes } : {}),
  });
  const supportedPresetIds = vendors.map((vendor) => vendor.presetId);
  const workspaces = envList(env, "OPENCLAW_MEDIA_GEN_WORKSPACE_IDS");
  const heartbeatMs = envNumber(env, "OPENCLAW_MEDIA_GEN_REGISTER_INTERVAL_MS", 60_000);
  const enforcesModeration = Boolean(moderation);
  const appliesLabeling = Boolean(labeler);
  // CP3 §8 honesty gate: advertise multi-reference ONLY when a configured vendor
  // truly maps a multi-slot input (e.g. Vidu subject images[]); the control plane
  // is fail-closed on this bit and only builds a references[] dispatch when true.
  const supportsMultiReference = vendors.some((vendor) => vendor.supportsMultiReference === true);

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
