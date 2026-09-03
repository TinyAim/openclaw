import { describe, expect, it } from "vitest";
import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";

describe("OpenClaw Wan media runtime factory", () => {
  it("advertises only the content-pinned Wan 2.2 T2V route", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-wan",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-wan",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-wan",
        DASHSCOPE_API_KEY: "dashscope-key",
        DASHSCOPE_WORKSPACE_ID: "ws-dashscope-beijing",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
        OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
      },
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }
    expect(result.supportedPresetIds).toEqual(["wan"]);
    expect(result.supportsMultiReference).toBe(false);
    expect(result.capabilityRouteClaims).toEqual([
      {
        presetId: "wan",
        mode: "text2video",
        route: {
          schemaVersion: 1,
          routeId: "wan.dashscope.cn_beijing.wan2_2_t2v_plus.text_to_video",
          providerId: "dashscope",
          modelId: "wan2.2-t2v-plus",
          endpointId: "dashscope.api.v1.video_generation.video_synthesis",
          region: "cn-beijing",
          accountTier: "api_key",
        },
        adapterRevision: "openclaw-wan2.2-t2v-runtime/v2",
      },
    ]);
  });

  it("does not enable or advertise Wan from a key or shared base without WorkspaceId", () => {
    const base = {
      OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
      OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
      OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-wan",
      OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-wan",
      OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-wan",
      DASHSCOPE_API_KEY: "dashscope-key",
      OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
      OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
    };
    for (const env of [
      base,
      {
        ...base,
        DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/api/v1",
      },
      { ...base, DASHSCOPE_WORKSPACE_ID: "not_a_dns_label" },
    ]) {
      const result = createOpenClawMediaGenRuntimeFromEnv({ env });
      expect(result).toEqual({
        enabled: false,
        reason: "no media-generation vendor credential is configured",
      });
    }
  });

  it("accepts the explicit OpenClaw WorkspaceId alias", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-wan",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-wan",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-wan",
        OPENCLAW_WAN_API_KEY: "dashscope-key",
        OPENCLAW_WAN_WORKSPACE_ID: "ws-dashscope-beijing",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
        OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
      },
    });
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.capabilityRouteClaims[0]?.adapterRevision).toBe(
        "openclaw-wan2.2-t2v-runtime/v2",
      );
    }
  });
});
