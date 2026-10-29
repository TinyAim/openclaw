import { describe, expect, it } from "vitest";
import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";

function runwayEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
    OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
    OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-runway",
    OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-runway",
    OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-runway",
    RUNWAYML_API_SECRET: "runway-key",
    OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
    OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
    ...overrides,
  };
}

describe("OpenClaw Runway media runtime factory", () => {
  it("advertises only the two implemented exact routes for the official Runway base", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({ env: runwayEnv() });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }

    expect(result.supportedPresetIds).toEqual(["runway"]);
    expect(result.supportsMultiReference).toBe(true);
    expect(result.capabilityRouteClaims).toEqual([
      {
        presetId: "runway",
        mode: "text2video",
        route: {
          schemaVersion: 1,
          routeId: "runway.api.v1.gen4_5.text_to_video.720p",
          providerId: "runway_api",
          modelId: "gen4.5",
          endpointId: "runway.v1.text_to_video",
          region: "global",
          accountTier: "api_key",
        },
        adapterRevision: "openclaw-runway-gen4.5-t2v-runtime/v1",
      },
      {
        presetId: "runway",
        mode: "image2video",
        route: {
          schemaVersion: 1,
          routeId: "runway.api.v1.gen4_turbo.image_to_video",
          providerId: "runway_api",
          modelId: "gen4_turbo",
          endpointId: "runway.v1.image_to_video",
          region: "global",
          accountTier: "api_key",
        },
        adapterRevision: "openclaw-runway-gen4-turbo-runtime/v1",
      },
    ]);
  });

  it("keeps the vendor usable but declares no registered profiles for a custom base URL", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: runwayEnv({ RUNWAYML_BASE_URL: "https://runway-proxy.example.test" }),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }

    expect(result.supportedPresetIds).toEqual(["runway"]);
    expect(result.supportsMultiReference).toBe(false);
    expect(result.capabilityRouteClaims).toEqual([]);
  });
});
