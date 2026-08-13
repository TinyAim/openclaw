import { describe, expect, it, vi } from "vitest";
import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";

function baseEnabledEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
    OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
    OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
    OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
    OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-1",
    KLING_ACCESS_KEY: "ak",
    KLING_SECRET: "sk",
    OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
    OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
    ...overrides,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function h3Fl2vaEnv(status: "ready" | "loading"): Record<string, string> {
  const pin = (profileId: string) => ({
    profileId,
    revision: 1,
    digest: `sha256:${"8".repeat(64)}`,
  });
  return {
    OPENCLAW_H3_BASE_FL2VA_SGLANG_VERSION: "14ffd447a4bc431c67e33e1743e076e0f53780c8",
    OPENCLAW_H3_BASE_FL2VA_CHECKPOINT_REVISION: "minimax-h3-base-test",
    OPENCLAW_H3_BASE_FL2VA_CHECKPOINT_DIGEST: `sha256:${"9".repeat(64)}`,
    OPENCLAW_H3_BASE_FL2VA_PRECISION: "bf16",
    OPENCLAW_H3_BASE_FL2VA_STATUS: status,
    OPENCLAW_H3_BASE_FL2VA_PROFILE_REFS_JSON: JSON.stringify({
      text_to_video: pin("hailuo.openclaw-runtime.h3_base_fl2va.text2video.v1"),
      first_frame_to_video: pin("hailuo.openclaw-runtime.h3_base_fl2va.image2video.v1"),
      last_frame_to_video: pin("hailuo.openclaw-runtime.h3_base_fl2va.image2video.v1"),
      first_last_frame_to_video: pin("hailuo.openclaw-runtime.h3_base_fl2va.image2video.v1"),
    }),
  };
}

describe("OpenClaw media-generation runtime env factory", () => {
  it("stays disabled unless explicitly enabled", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({ env: {} });
    expect(result.enabled).toBe(false);
  });

  it("defaults quality gate to off (no OPENCLAW_MEDIA_GEN_QUALITY_GATE)", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: baseEnabledEnv(),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result.enabled).toBe(true);
  });

  it("registers exact H3 Base route and model-serving claims without duplicating the preset", async () => {
    const calls: unknown[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }));
      }
      if (value.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "MiniMaxAI/MiniMax-H3" }] }));
      }
      calls.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const result = createOpenClawMediaGenRuntimeFromEnv({
      fetchImpl,
      env: baseEnabledEnv(h3Fl2vaEnv("ready")),
    });

    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.supportedPresetIds).toEqual(["kling", "hailuo"]);
    expect(result.capabilityRouteClaims).toEqual([expect.objectContaining({ presetId: "kling" })]);
    expect(result.modelServingClaims).toEqual([
      expect.objectContaining({
        modelId: "MiniMax-H3-Base",
        variant: "fl2va",
        servingEngine: "sglang",
        status: "ready",
      }),
    ]);

    const stop = result.startHeartbeat();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    stop();
    expect(calls[0]).toMatchObject({
      supportedPresetIds: ["kling", "hailuo"],
      capabilityRouteClaims: expect.arrayContaining([
        expect.objectContaining({
          presetId: "hailuo",
          route: expect.objectContaining({
            routeId: "hailuo.h3_base.fl2va.selfhosted.sglang_v1",
          }),
        }),
      ]),
      modelServingClaims: [expect.objectContaining({ variant: "fl2va" })],
    });
  });

  it("keeps other vendors registered while an H3 model is loading", async () => {
    const registrations: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(url).includes("/runtime/register")) {
        registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = createOpenClawMediaGenRuntimeFromEnv({
      fetchImpl,
      env: baseEnabledEnv(h3Fl2vaEnv("loading")),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    const stop = result.startHeartbeat();
    await vi.waitFor(() => expect(registrations).toHaveLength(1));
    stop();
    expect(registrations[0]).toMatchObject({
      capabilityRouteClaims: [expect.objectContaining({ presetId: "kling" })],
      modelServingClaims: [
        expect.objectContaining({
          variant: "fl2va",
          status: "loading",
        }),
      ],
    });
  });

  it("retries without a quarantined live H3 route so provider routes stay fresh", async () => {
    const registrations: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }));
      }
      if (value.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "MiniMaxAI/MiniMax-H3" }] }));
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      registrations.push(body);
      const claims = body.capabilityRouteClaims as Array<{
        route?: { routeId?: string };
      }>;
      const includesH3 = claims.some(
        (claim) => claim.route?.routeId === "hailuo.h3_base.fl2va.selfhosted.sglang_v1",
      );
      return new Response(
        JSON.stringify(
          includesH3
            ? { error: { code: "MEDIA_GEN_RUNTIME_CAPABILITY_PROFILE_MISMATCH" } }
            : { data: { ok: true } },
        ),
        { status: includesH3 ? 400 : 200 },
      );
    }) as unknown as typeof fetch;
    const result = createOpenClawMediaGenRuntimeFromEnv({
      fetchImpl,
      env: baseEnabledEnv(h3Fl2vaEnv("ready")),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    const stop = result.startHeartbeat();
    await vi.waitFor(() => expect(registrations).toHaveLength(2));
    stop();
    expect(registrations[0]?.capabilityRouteClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: expect.objectContaining({
            routeId: "hailuo.h3_base.fl2va.selfhosted.sglang_v1",
          }),
        }),
      ]),
    );
    expect(registrations[1]?.capabilityRouteClaims).toEqual([
      expect.objectContaining({ presetId: "kling" }),
    ]);
  });

  it("rejects invalid quality gate tokens (fail-closed, never default on)", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: baseEnabledEnv({ OPENCLAW_MEDIA_GEN_QUALITY_GATE: "requird" }),
    });
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toMatch(/invalid OPENCLAW_MEDIA_GEN_QUALITY_GATE/);
    }
  });

  it("required mode disables executor when probe tools are missing", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: baseEnabledEnv({ OPENCLAW_MEDIA_GEN_QUALITY_GATE: "required" }),
      log: { info: vi.fn(), warn: vi.fn() },
      probeMediaQualityTools: () => ({ ok: false, missing: ["ffmpeg"] }),
    });
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toContain("missing tools: ffmpeg");
    }
  });

  it("builds a real Kling runtime executor and registers workspaces by heartbeat", async () => {
    const calls: Array<{ url: string; body: unknown; headers: HeadersInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: requestUrl(url),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: init?.headers,
      });
      return new Response(
        JSON.stringify({
          data: { ok: true, workspaceId: "ws-1", runtimeId: "runtime-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = createOpenClawMediaGenRuntimeFromEnv({
      fetchImpl,
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-1",
        KLING_ACCESS_KEY: "ak",
        KLING_SECRET: "sk",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
        OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
      },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.supportedPresetIds).toEqual(["kling"]);
    expect(result.enforcesModeration).toBe(true);
    expect(result.appliesLabeling).toBe(true);
    expect(result.capabilityRouteClaims).toEqual([
      expect.objectContaining({
        presetId: "kling",
        mode: "text2video",
        adapterRevision: "openclaw-kling-text2video-runtime/v2",
      }),
    ]);
    const stop = result.startHeartbeat();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    stop();
    expect(calls[0]).toMatchObject({
      url: "https://control.example/v1/control/media-gen/runtime/register",
      body: {
        workspaceId: "ws-1",
        runtimeId: "runtime-1",
        supportedPresetIds: ["kling"],
        enforcesModeration: true,
        appliesLabeling: true,
        capabilityRouteClaims: expect.arrayContaining([
          expect.objectContaining({ presetId: "kling", mode: "text2video" }),
        ]),
      },
    });
  });

  it("keeps unadvertised image routes closed when a Vidu key is configured", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: requestUrl(url),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = createOpenClawMediaGenRuntimeFromEnv({
      fetchImpl,
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-1",
        KLING_ACCESS_KEY: "ak",
        KLING_SECRET: "sk",
        VIDU_API_KEY: "vidu-key",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
        OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
      },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.supportedPresetIds).toEqual(["kling", "vidu"]);
    expect(result.supportsMultiReference).toBe(false);
    expect(result.capabilityRouteClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          presetId: "vidu",
          mode: "text2video",
          adapterRevision: "openclaw-vidu-q1-text2video-runtime/v2",
        }),
      ]),
    );
    expect(
      result.capabilityRouteClaims.filter(
        (claim) => claim.presetId === "vidu" && claim.mode === "image2video",
      ),
    ).toEqual([]);

    const stop = result.startHeartbeat();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    stop();
    expect((calls[0]!.body as Record<string, unknown>).supportsMultiReference).toBeUndefined();
  });

  it("does not advertise supportsMultiReference for a Kling-only runtime", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-1",
        KLING_ACCESS_KEY: "ak",
        KLING_SECRET: "sk",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
        OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeler.example/apply",
      },
    });

    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.supportsMultiReference).toBe(false);
  });

  it("does not claim a registered profile for a custom vendor base URL", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: baseEnabledEnv({ KLING_BASE_URL: "https://proxy.example.test" }),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.capabilityRouteClaims).toEqual([]);
  });

  it("does not enable when vendor credentials are missing", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
      },
    });
    expect(result).toMatchObject({
      enabled: false,
      reason: "no media-generation vendor credential is configured",
    });
  });

  it("does not enable a real vendor executor without moderation and labeling hooks", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        KLING_ACCESS_KEY: "ak",
        KLING_SECRET: "sk",
      },
    });
    expect(result).toMatchObject({
      enabled: false,
      reason:
        "media-generation moderation and labeling webhooks are required before enabling a vendor executor",
    });
  });

  it("does not enable a real vendor executor with only one compliance hook", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        KLING_ACCESS_KEY: "ak",
        KLING_SECRET: "sk",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
      },
    });
    expect(result.enabled).toBe(false);
  });
});
