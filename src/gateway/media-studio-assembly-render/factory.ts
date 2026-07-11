/**
 * Gate 1E — env-gated assembly-render executor factory (OpenClaw runtime).
 */
import { createAssemblyRenderControlApiBridge } from "./control-api-callbacks.js";
import { createMediaStudioAssemblyRenderExecutor } from "./executor.js";
import {
  createFfmpegTimelineEncoder,
  isFfmpegAvailable,
} from "./ffmpeg-encode.js";
import type { MediaStudioAssemblyRenderHttpExecutor } from "../media-studio-assembly-render-http.js";
import type {
  AssemblyRenderEncodeFn,
  MediaStudioAssemblyRenderFetch,
} from "./types.js";

export type MediaStudioAssemblyRenderEnv = Record<string, string | undefined>;

export type MediaStudioAssemblyRenderFromEnvResult =
  | {
      enabled: true;
      executor: MediaStudioAssemblyRenderHttpExecutor;
      reason?: undefined;
    }
  | { enabled: false; reason: string };

function envString(env: MediaStudioAssemblyRenderEnv, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function envBool(env: MediaStudioAssemblyRenderEnv, key: string): boolean {
  return /^(1|true|yes|on)$/i.test(env[key]?.trim() ?? "");
}

/**
 * Build assembly-render executor from env.
 *
 * Required:
 * - OPENCLAW_MEDIA_STUDIO_ASSEMBLY_RENDER_ENABLED=1
 * - OPENCLAW_MEDIA_GEN_CONTROL_API_URL (or WISCLAW_CONTROL_API_URL)
 * - OPENCLAW_MEDIA_GEN_RUNTIME_ID
 * - OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN
 *
 * Optional:
 * - OPENCLAW_MEDIA_STUDIO_ASSEMBLY_RENDER_ALLOW_SYNTHETIC_MASTER=1 (dev only)
 * - ffmpeg on PATH (required unless encodeImpl injected in tests)
 */
export async function createMediaStudioAssemblyRenderFromEnv(options?: {
  env?: MediaStudioAssemblyRenderEnv;
  fetchImpl?: MediaStudioAssemblyRenderFetch;
  encodeImpl?: AssemblyRenderEncodeFn;
  handoffMaster?: Parameters<
    typeof createAssemblyRenderControlApiBridge
  >[0]["handoffMaster"];
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  /** Test inject: skip ffmpeg presence check. */
  skipFfmpegCheck?: boolean;
}): Promise<MediaStudioAssemblyRenderFromEnvResult> {
  const env = options?.env ?? process.env;
  if (!envBool(env, "OPENCLAW_MEDIA_STUDIO_ASSEMBLY_RENDER_ENABLED")) {
    return {
      enabled: false,
      reason: "OPENCLAW_MEDIA_STUDIO_ASSEMBLY_RENDER_ENABLED is not set",
    };
  }
  const controlApiUrl = envString(
    env,
    "OPENCLAW_MEDIA_GEN_CONTROL_API_URL",
    "WISCLAW_CONTROL_API_URL",
    "CONTROL_API_BASE_URL",
  );
  const runtimeId = envString(
    env,
    "OPENCLAW_MEDIA_GEN_RUNTIME_ID",
    "MEDIAGEN_RUNTIME_ID",
  );
  const token = envString(
    env,
    "OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN",
    "MEDIAGEN_RUNTIME_REGISTRATION_TOKEN",
  );
  if (!controlApiUrl || !runtimeId || !token) {
    return {
      enabled: false,
      reason:
        "assembly-render requires control API URL + runtimeId + runtime token",
    };
  }

  let encode = options?.encodeImpl;
  if (!encode) {
    if (!options?.skipFfmpegCheck) {
      const ok = await isFfmpegAvailable();
      if (!ok) {
        return {
          enabled: false,
          reason: "ffmpeg not available on PATH for assembly-render encode",
        };
      }
    }
    encode = createFfmpegTimelineEncoder();
  }

  const allowSynthetic = envBool(
    env,
    "OPENCLAW_MEDIA_STUDIO_ASSEMBLY_RENDER_ALLOW_SYNTHETIC_MASTER",
  );
  // Gate 1H: default handoff uses renderId ownership on Control API artifact-handoff.
  // Synthetic remains explicit opt-in for offline/dev only.
  const enableDefaultHandoff = !options?.handoffMaster && !allowSynthetic;

  const bridge = createAssemblyRenderControlApiBridge({
    controlApiUrl,
    runtimeId,
    token,
    fetchImpl: options?.fetchImpl,
    handoffMaster: options?.handoffMaster,
    enableDefaultHandoff,
  });

  const executor = createMediaStudioAssemblyRenderExecutor({
    bridge,
    encode,
    allowSyntheticMasterId: allowSynthetic,
    log: options?.log,
  });

  return { enabled: true, executor };
}
