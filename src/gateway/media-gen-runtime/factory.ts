import type { MediaGenRuntimeHttpExecutor } from "../media-gen-runtime-http.js";
import { createCogVideoX3RuntimeVendor } from "./cogvideox3-vendor.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { createGoogleCloudAccessTokenProvider } from "./google-cloud-auth.js";
import { createH3BaseSglangVendors } from "./h3-base-sglang-factory.js";
import { createHailuoH3RuntimeVendor } from "./hailuo-h3-vendor.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import { createLumaRuntimeVendor } from "./luma-vendor.js";
import {
  parseMediaQualityGateMode,
  probeMediaQualityToolsAvailableSync,
} from "./media-quality-tools.js";
import { createMediaQualityValidator } from "./media-quality-validator.js";
import { parseReconcileJobBindings, resolveReconcileJobReceipt } from "./reconcile-job-bindings.js";
import { parseRuntimeReferenceMap } from "./runtime-reference-map.js";
import { createRunwayRuntimeVendor } from "./runway-vendor.js";
import { createSeedanceV2RuntimeVendor } from "./seedance-vendor-v2.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeConfigError,
  MediaGenRuntimeCapabilityRouteClaim,
  MediaGenRuntimeFetch,
  MediaGenRuntimeModelServingClaim,
  MediaGenRuntimeVendor,
} from "./types.js";
import { createVeoRuntimeVendor, googleCloudProjectIdValid } from "./veo-vendor.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";
import { createWanRuntimeVendor, wanDashScopeWorkspaceBaseUrl } from "./wan-vendor.js";

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
      capabilityRouteClaims: MediaGenRuntimeCapabilityRouteClaim[];
      modelServingClaims: MediaGenRuntimeModelServingClaim[];
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

function maybeSeedanceVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const apiKey = envString(
    env,
    "ARK_API_KEY",
    "VOLCENGINE_ARK_API_KEY",
    "OPENCLAW_SEEDANCE_API_KEY",
  );
  if (!apiKey) return null;
  return createSeedanceV2RuntimeVendor({
    apiKey,
    baseUrl: envString(env, "ARK_BASE_URL", "OPENCLAW_SEEDANCE_BASE_URL") || undefined,
    fetchImpl,
  });
}

function maybeRunwayVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const apiKey = envString(env, "RUNWAYML_API_SECRET", "OPENCLAW_RUNWAY_API_SECRET");
  if (!apiKey) return null;
  return createRunwayRuntimeVendor({
    apiKey,
    baseUrl: envString(env, "RUNWAYML_BASE_URL", "OPENCLAW_RUNWAY_BASE_URL") || undefined,
    fetchImpl,
  });
}

function maybeLumaVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const apiKey = envString(env, "LUMAAI_API_KEY", "OPENCLAW_LUMA_API_KEY");
  if (!apiKey) {
    return null;
  }
  return createLumaRuntimeVendor({
    apiKey,
    baseUrl: envString(env, "LUMAAI_BASE_URL", "OPENCLAW_LUMA_BASE_URL") || undefined,
    fetchImpl,
  });
}

function maybeWanVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const apiKey = envString(env, "DASHSCOPE_API_KEY", "OPENCLAW_WAN_API_KEY");
  const workspaceId = envString(env, "DASHSCOPE_WORKSPACE_ID", "OPENCLAW_WAN_WORKSPACE_ID");
  if (!apiKey || !wanDashScopeWorkspaceBaseUrl(workspaceId)) {
    return null;
  }
  return createWanRuntimeVendor({
    apiKey,
    workspaceId,
    fetchImpl,
  });
}

function maybeHailuoVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const apiKey = envString(env, "MINIMAX_API_KEY", "OPENCLAW_HAILUO_API_KEY");
  if (!apiKey) return null;
  return createHailuoH3RuntimeVendor({
    apiKey,
    baseUrl: envString(env, "MINIMAX_BASE_URL", "OPENCLAW_HAILUO_BASE_URL") || undefined,
    fetchImpl,
  });
}

function maybeCogVideoXVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const apiKey = envString(env, "ZHIPU_API_KEY", "OPENCLAW_COGVIDEOX_API_KEY");
  if (!apiKey) {
    return null;
  }
  return createCogVideoX3RuntimeVendor({
    apiKey,
    baseUrl: envString(env, "ZHIPU_BASE_URL", "OPENCLAW_COGVIDEOX_BASE_URL") || undefined,
    fetchImpl,
  });
}

function maybeVeoVendor(
  env: MediaGenRuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): MediaGenRuntimeVendor | null {
  const projectId = envString(
    env,
    "VERTEX_AI_PROJECT_ID",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
  );
  if (!projectId || !googleCloudProjectIdValid(projectId)) {
    return null;
  }
  return createVeoRuntimeVendor({
    projectId,
    accessTokenProvider: createGoogleCloudAccessTokenProvider(),
    fetchImpl,
    maxOutputBytes: envNumber(env, "OPENCLAW_MEDIA_GEN_MAX_ARTIFACT_BYTES", 512 * 1024 * 1024),
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
  const h3Base = createH3BaseSglangVendors(env, options.fetchImpl);
  if (h3Base.error) {
    return { enabled: false, reason: h3Base.error };
  }
  const vendors = [
    maybeKlingVendor(env, options.fetchImpl),
    maybeViduVendor(env, options.fetchImpl),
    maybeSeedanceVendor(env, options.fetchImpl),
    maybeRunwayVendor(env, options.fetchImpl),
    maybeLumaVendor(env, options.fetchImpl),
    maybeWanVendor(env, options.fetchImpl),
    maybeHailuoVendor(env, options.fetchImpl),
    maybeCogVideoXVendor(env, options.fetchImpl),
    maybeVeoVendor(env, options.fetchImpl),
    ...h3Base.vendors,
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
  const allowedMediaHosts = [
    ...new Set([
      ...envList(env, "OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST"),
      // Exact vendor code, not operator input, owns these origins. This keeps a
      // co-located H3 /content response inside the shared SSRF allow-list even
      // when the deployment also has a non-empty cloud CDN allow-list.
      ...vendors.flatMap((vendor) => [...(vendor.trustedOutputHosts ?? [])]),
    ]),
  ];
  const workspaces = envList(env, "OPENCLAW_MEDIA_GEN_WORKSPACE_IDS");
  const runtimeReferenceMapEnvKey = env.OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON?.trim()
    ? "OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON"
    : "OPENCLAW_SEEDANCE_RUNTIME_REFERENCE_MAP_JSON";
  const runtimeReferenceMap = parseRuntimeReferenceMap(env[runtimeReferenceMapEnvKey]);
  if (!runtimeReferenceMap) {
    return {
      enabled: false,
      reason: `${runtimeReferenceMapEnvKey} is invalid`,
    };
  }
  const reconcileJobBindings = parseReconcileJobBindings(
    env.OPENCLAW_MEDIA_GEN_RECONCILE_JOB_BINDINGS_JSON,
    new Set(workspaces),
  );
  if (!reconcileJobBindings) {
    return {
      enabled: false,
      reason: "OPENCLAW_MEDIA_GEN_RECONCILE_JOB_BINDINGS_JSON is invalid",
    };
  }
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
      if (result.ok) return { ok: true as const, verified: true };
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
          return {
            ok: true as const,
            verified: result.blackFrameCheckSkipped !== true,
          };
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
    ...(runtimeReferenceMap.size > 0
      ? {
          resolveRuntimeLocalReference: async (input: { runtimeLocalRef: string }) => {
            const resolved = runtimeReferenceMap.get(input.runtimeLocalRef);
            if (!resolved) {
              throw new Error("runtime-local media reference is not configured");
            }
            return resolved;
          },
        }
      : {}),
    ...(reconcileJobBindings.size > 0
      ? {
          resolveReconcileJobReceipt: (dispatch) => {
            return resolveReconcileJobReceipt(reconcileJobBindings, dispatch);
          },
        }
      : {}),
    ...(validateMediaBytes ? { validateMediaBytes } : {}),
  });
  const supportedPresetIds = [...new Set(vendors.map((vendor) => vendor.presetId))];
  const heartbeatMs = envNumber(env, "OPENCLAW_MEDIA_GEN_REGISTER_INTERVAL_MS", 60_000);
  const enforcesModeration = Boolean(moderation);
  const appliesLabeling = Boolean(labeler);
  const filterCapabilityRouteClaims = (claims: MediaGenRuntimeCapabilityRouteClaim[]) =>
    claims
      // Seedance's exact routes promise validated Artifact output. Do not make
      // those routes operational unless the local quality validator was proven.
      .filter((claim) => claim.presetId !== "seedance" || validateMediaBytes !== undefined)
      // Luma I2V remains executable for historical frozen receipts, but its
      // current runtime profile is not evidence-pinned for admission.
      .filter((claim) => !(claim.presetId === "luma" && claim.mode === "image2video"));
  const capabilityRouteClaims = filterCapabilityRouteClaims(
    vendors.flatMap((vendor) => [...(vendor.capabilityRouteClaims ?? [])]),
  );
  const modelServingClaims = vendors.flatMap((vendor) => [...(vendor.modelServingClaims ?? [])]);
  // A vendor's local source-handling capability is not sufficient evidence for
  // Control API admission. Project the bit only when that same preset also has
  // an advertised image route after all evidence/quality filters above.
  const supportsMultiReference = vendors.some(
    (vendor) =>
      vendor.supportsMultiReference === true &&
      capabilityRouteClaims.some(
        (claim) => claim.presetId === vendor.presetId && claim.mode === "image2video",
      ),
  );

  async function collectLiveRegistrationSnapshot(): Promise<{
    capabilityRouteClaims: MediaGenRuntimeCapabilityRouteClaim[];
    modelServingClaims: MediaGenRuntimeModelServingClaim[];
    supportsMultiReference: boolean;
  }> {
    const snapshots = await Promise.all(
      vendors.map(async (vendor) => {
        if (!vendor.registrationSnapshot) {
          return {
            capabilityRouteClaims: [...(vendor.capabilityRouteClaims ?? [])],
            modelServingClaims: [...(vendor.modelServingClaims ?? [])],
          };
        }
        try {
          const sampled = await vendor.registrationSnapshot();
          return {
            capabilityRouteClaims: [...(sampled.capabilityRouteClaims ?? [])],
            modelServingClaims: [...(sampled.modelServingClaims ?? [])],
          };
        } catch {
          return {
            capabilityRouteClaims: [] as MediaGenRuntimeCapabilityRouteClaim[],
            modelServingClaims: (vendor.modelServingClaims ?? []).map((claim) => ({
              ...claim,
              status: "error" as const,
            })),
          };
        }
      }),
    );
    const liveCapabilityRouteClaims = filterCapabilityRouteClaims(
      snapshots.flatMap((snapshot) => snapshot.capabilityRouteClaims),
    );
    return {
      capabilityRouteClaims: liveCapabilityRouteClaims,
      modelServingClaims: snapshots.flatMap((snapshot) => snapshot.modelServingClaims),
      supportsMultiReference: vendors.some(
        (vendor) =>
          vendor.supportsMultiReference === true &&
          liveCapabilityRouteClaims.some(
            (claim) => claim.presetId === vendor.presetId && claim.mode === "image2video",
          ),
      ),
    };
  }

  return {
    enabled: true,
    executor,
    supportedPresetIds,
    enforcesModeration,
    appliesLabeling,
    supportsMultiReference,
    capabilityRouteClaims,
    modelServingClaims,
    startHeartbeat() {
      if (workspaces.length === 0) {
        options.log?.warn?.(
          "media-gen runtime executor enabled but OPENCLAW_MEDIA_GEN_WORKSPACE_IDS is empty; registration heartbeat is disabled",
        );
        return () => {};
      }
      let stopped = false;
      const register = () => {
        void collectLiveRegistrationSnapshot()
          .then((snapshot) => {
            if (stopped) return;
            const staticClaimKeys = new Set(
              capabilityRouteClaims.map(
                (claim) =>
                  `${claim.presetId}\u0000${claim.mode}\u0000${claim.route.routeId}\u0000${claim.adapterRevision}`,
              ),
            );
            const hasDynamicPrivateClaims = snapshot.capabilityRouteClaims.some(
              (claim) =>
                !staticClaimKeys.has(
                  `${claim.presetId}\u0000${claim.mode}\u0000${claim.route.routeId}\u0000${claim.adapterRevision}`,
                ),
            );
            for (const workspaceId of workspaces) {
              const registerSnapshot = () =>
                bridge.register({
                  workspaceId,
                  supportedPresetIds,
                  enforcesModeration,
                  appliesLabeling,
                  supportsMultiReference: snapshot.supportsMultiReference,
                  capabilityRouteClaims: snapshot.capabilityRouteClaims,
                  modelServingClaims: snapshot.modelServingClaims,
                });
              void registerSnapshot()
                .then(() =>
                  options.log?.info?.(
                    `media-gen runtime heartbeat registered workspace=${workspaceId} runtime=${bridge.runtimeId}`,
                  ),
                )
                .catch(async (error) => {
                  // A newly healthy private model may still be quarantined by
                  // Control API evidence/license/checkpoint pins. Preserve the
                  // already-admitted provider routes instead of allowing that
                  // one fail-closed claim to stale the entire runtime. The
                  // private route is deliberately omitted on this retry.
                  if (hasDynamicPrivateClaims && !stopped) {
                    try {
                      await bridge.register({
                        workspaceId,
                        supportedPresetIds,
                        enforcesModeration,
                        appliesLabeling,
                        supportsMultiReference,
                        capabilityRouteClaims,
                        modelServingClaims: snapshot.modelServingClaims,
                      });
                      options.log?.warn?.(
                        `media-gen runtime heartbeat registered without quarantined private routes workspace=${workspaceId} runtime=${bridge.runtimeId}`,
                      );
                      return;
                    } catch {
                      // Report the original exact-claim failure below; the retry
                      // is only an availability-preserving fallback.
                    }
                  }
                  if (!stopped) {
                    options.log?.warn?.(
                      `media-gen runtime heartbeat failed workspace=${workspaceId}: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                    );
                  }
                });
            }
          })
          .catch((error) => {
            if (!stopped) {
              options.log?.warn?.(
                `media-gen runtime readiness snapshot failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          });
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
