import { describe, expect, it } from "vitest";
import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
    OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
    OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-cogvideox3",
    OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-cogvideox3",
    OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-cogvideox3",
    ZHIPU_API_KEY: "zhipu-key",
    OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
    OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
    ...overrides,
  };
}

describe("OpenClaw CogVideoX-3 runtime factory", () => {
  it("registers the three exact official CogVideoX-3 routes", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({ env: env() });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }
    expect(result.supportedPresetIds).toEqual(["cogvideox"]);
    expect(result.supportsMultiReference).toBe(true);
    expect(result.capabilityRouteClaims).toEqual([
      {
        presetId: "cogvideox",
        mode: "text2video",
        route: {
          schemaVersion: 1,
          routeId: "cogvideox.zhipu.v4.cogvideox_3.text2video.1080p.quality",
          providerId: "zhipu_open_platform",
          modelId: "cogvideox-3",
          endpointId: "zhipu.v4.videos.generations",
          region: "cn",
          accountTier: "api_key",
        },
        adapterRevision: "openclaw-cogvideox3-text2video-runtime/v1",
      },
      {
        presetId: "cogvideox",
        mode: "image2video",
        route: {
          schemaVersion: 1,
          routeId: "cogvideox.zhipu.v4.cogvideox_3.image2video.1080p.quality",
          providerId: "zhipu_open_platform",
          modelId: "cogvideox-3",
          endpointId: "zhipu.v4.videos.generations",
          region: "cn",
          accountTier: "api_key",
        },
        adapterRevision: "openclaw-cogvideox3-image2video-runtime/v1",
      },
      {
        presetId: "cogvideox",
        mode: "image2video",
        route: {
          schemaVersion: 1,
          routeId: "cogvideox.zhipu.v4.cogvideox_3.first_last_frame_to_video.1080p.quality",
          providerId: "zhipu_open_platform",
          modelId: "cogvideox-3",
          endpointId: "zhipu.v4.videos.generations",
          region: "cn",
          accountTier: "api_key",
        },
        adapterRevision: "openclaw-cogvideox3-first-last-frame-runtime/v1",
      },
    ]);
  });

  it("does not claim a server profile for a custom proxy base URL", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: env({ ZHIPU_BASE_URL: "https://proxy.example.test/v4" }),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }
    expect(result.supportedPresetIds).toEqual(["cogvideox"]);
    expect(result.capabilityRouteClaims).toEqual([]);
  });
});
