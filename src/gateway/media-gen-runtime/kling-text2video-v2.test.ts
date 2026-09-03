import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileKlingT2vV2Request,
  KLING_T2V_V2_ADAPTER_REVISION,
  KLING_T2V_V2_PROFILE_DIGEST,
  KLING_T2V_V2_PROFILE_ID,
  KLING_T2V_V2_PROFILE_REVISION,
  KLING_T2V_V2_ROUTE_ID,
} from "./kling-text2video-v2-compiler.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function frozenPlan(
  overrides: { durationSec?: number; aspectRatio?: string; resolution?: string } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A courier crosses a neon-lit alley in one continuous tracking shot.";
  return {
    schemaVersion: 2,
    previewId: "preview-kling-t2v-v2",
    presetId: "kling",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-kling",
        shotId: "shot-kling",
        shotVersion: "R1",
        promptPackId: "pack-kling",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: {
        visualPrompt: "A courier crosses a neon-lit alley.",
        reservedForLater: [],
      },
      camera: { cameraPrompt: "Low tracking shot." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "9:16",
        resolution: overrides.resolution,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: KLING_T2V_V2_ROUTE_ID,
      providerId: "kling_open_platform",
      modelId: "kling-v1",
      endpointId: "kling.v1.videos.text2video",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: KLING_T2V_V2_PROFILE_ID,
      revision: KLING_T2V_V2_PROFILE_REVISION,
      digest: KLING_T2V_V2_PROFILE_DIGEST,
    },
    adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-kling",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerField: "scenario",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerField: "output.audio",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: true,
        support: "prompt",
        providerField: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      {
        intentPath: "camera.cameraPrompt",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "prompt",
        providerField: "prompt",
        reasonCode: "camera_prompt_compiled",
        messageKey: "media.camera_prompt_compiled",
      },
      {
        intentPath: "output.durationSec",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native",
        providerField: "output.durationSec",
        reasonCode: "duration_native",
        messageKey: "media.duration_native",
      },
      {
        intentPath: "output.aspectRatio",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native",
        providerField: "output.aspectRatio",
        reasonCode: "aspect_ratio_native",
        messageKey: "media.aspect_ratio_native",
      },
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-kling-t2v-v2",
    presetId: "kling",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Kling exact Text-to-Video Adapter V2", () => {
  it("compiles and submits only the pinned official kling-v1 std fields", async () => {
    const compiled = compileKlingT2vV2Request(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model_name: "kling-v1",
        prompt: expect.any(String),
        cfg_scale: 0.5,
        mode: "std",
        aspect_ratio: "9:16",
        duration: "5",
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createKlingRuntimeVendor({
      accessKey: "ak",
      secret: "sk",
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(JSON.stringify({ code: 0, data: { task_id: "k-t2v-1" } }));
      }) as unknown as typeof fetch,
    });
    expect(vendor.capabilityRouteClaims).toEqual([
      expect.objectContaining({
        mode: "text2video",
        route: expect.objectContaining({ routeId: KLING_T2V_V2_ROUTE_ID }),
        adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
      }),
    ]);
    expect(vendor.supportsMultiReference).toBe(true);
    expect(await vendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: "text2video-v2:k-t2v-1",
      providerObservation: {
        routeId: KLING_T2V_V2_ROUTE_ID,
        adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe("https://api.klingai.com/v1/videos/text2video");
    const body = calls[0]?.init?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new Error("missing Kling request body");
    }
    expect(JSON.parse(body)).toEqual(compiled.ok ? compiled.body : undefined);
  });

  it("fails exact-identity drift closed without falling back to legacy params", async () => {
    const fetchImpl = vi.fn();
    const vendor = createKlingRuntimeVendor({ accessKey: "ak", secret: "sk", fetchImpl });
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    await expect(vendor.submit(vendorInput(stale))).resolves.toMatchObject({
      state: "failed",
      reason: "vendor_rejected",
    });
    await expect(
      vendor.submit(vendorInput(frozenPlan(), { params: { cfg_scale: 0.9 } })),
    ).resolves.toMatchObject({ state: "failed", reason: "vendor_rejected" });

    const referenced = frozenPlan();
    referenced.generationIntent.references.push({
      role: "first_frame",
      ordinal: 0,
      required: true,
      mediaClass: "image",
      source: { kind: "artifact", artifactId: "artifact-not-supported" },
      authorityVerified: true,
    });
    expect(compileKlingT2vV2Request(vendorInput(referenced))).toMatchObject({ ok: false });
    expect(compileKlingT2vV2Request(vendorInput(frozenPlan({ durationSec: 6 })))).toMatchObject({
      ok: false,
    });
    expect(
      compileKlingT2vV2Request(vendorInput(frozenPlan({ aspectRatio: "21:9" }))),
    ).toMatchObject({ ok: false });
    expect(
      compileKlingT2vV2Request(
        vendorInput(frozenPlan({ resolution: "1080p" }), { resolution: "1080p" }),
      ),
    ).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks ambiguous creates without leaking transport details", async () => {
    const vendor = createKlingRuntimeVendor({
      accessKey: "ak",
      secret: "sk",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    });
    const result = await vendor.submit(vendorInput());
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: KLING_T2V_V2_ROUTE_ID,
        adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
        qualityOutcome: "not_run",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("normalizes exact prefixed poll and reconcile lifecycle evidence", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const id = requestUrl(url).split("/").at(-1);
      if (id === "pending") {
        return new Response(JSON.stringify({ code: 0, data: { task_status: "processing" } }));
      }
      if (id === "canceled") {
        return new Response(JSON.stringify({ code: 0, data: { task_status: "canceled" } }));
      }
      if (id === "failed") {
        return new Response(JSON.stringify({ code: 0, data: { task_status: "failed" } }));
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: { videos: [{ url: "https://media.example/kling.mp4" }] },
          },
        }),
      );
    }) as unknown as typeof fetch;
    const vendor = createKlingRuntimeVendor({ accessKey: "ak", secret: "sk", fetchImpl });

    expect(await vendor.poll("text2video-v2:pending")).toMatchObject({
      state: "processing",
      providerObservation: { operation: "poll", outcome: "processing" },
    });
    expect(await vendor.poll("text2video-v2:canceled")).toMatchObject({
      state: "canceled",
      providerObservation: { operation: "poll", outcome: "canceled" },
    });
    expect(await vendor.reconcile!("text2video-v2:failed")).toMatchObject({
      state: "failed",
      reason: "vendor_failed",
      providerObservation: { operation: "reconcile", outcome: "failed" },
    });
    expect(await vendor.poll("text2video-v2:complete")).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.example/kling.mp4" },
      providerObservation: { operation: "poll", outcome: "succeeded" },
    });
  });

  it("reconciles before returning the closed not-supported cancel outcome", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      if (value.endsWith("/v1/videos/text2video") && init?.method === "POST") {
        return new Response(JSON.stringify({ code: 0, data: { task_id: "no-cancel" } }));
      }
      return new Response(JSON.stringify({ code: 0, data: { task_status: "processing" } }));
    }) as unknown as typeof fetch;
    const vendor = createKlingRuntimeVendor({ accessKey: "ak", secret: "sk", fetchImpl });
    expect(vendor.cancel).toBeUndefined();
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-kling",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("Kling T2V must not resolve an input reference");
      }),
      handoffArtifact: vi.fn(async () => {
        throw new Error("cancel must not hand off an Artifact");
      }),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl,
    });
    const plan = frozenPlan();
    const submitted = await executor.dispatch({
      op: "submit",
      taskId: "task-kling-no-cancel",
      workspaceId: "ws-kling",
      correlationId: "corr-kling-submit",
      presetId: "kling",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      frozenPlan: plan,
    });
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "text2video-v2:no-cancel",
    });
    await expect(
      executor.dispatch({
        op: "cancel",
        taskId: "task-kling-no-cancel",
        workspaceId: "ws-kling",
        correlationId: "corr-kling-cancel",
        presetId: "kling",
        mode: "text2video",
        runtimeJobId: "text2video-v2:no-cancel",
      }),
    ).resolves.toMatchObject({
      status: "canceled",
      runtimeJobId: "text2video-v2:no-cancel",
      runtimeStopOutcome: {
        state: "not_supported",
        reasonCode: "adapter_not_supported",
      },
    });
    expect(calls).toEqual([
      {
        url: "https://api.klingai.com/v1/videos/text2video",
        method: "POST",
      },
      {
        url: "https://api.klingai.com/v1/videos/text2video/no-cancel",
        method: "GET",
      },
    ]);
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });

  it("downloads validated output before canonical Artifact handoff", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/v1/videos/text2video") && init?.method === "POST") {
        return new Response(JSON.stringify({ code: 0, data: { task_id: "k-artifact" } }));
      }
      if (value.endsWith("/v1/videos/text2video/k-artifact")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              task_status: "succeed",
              task_result: { videos: [{ url: "https://media.example/kling.mp4" }] },
            },
          }),
        );
      }
      return new Response(Buffer.from("kling-video-bytes"), {
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-kling-t2v-output",
      mimeType: "video/mp4",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-kling",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("Kling T2V must not resolve an input reference");
      }),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createKlingRuntimeVendor({ accessKey: "ak", secret: "sk", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-kling-t2v-v2",
      workspaceId: "ws-kling",
      correlationId: "corr-kling-submit",
      presetId: "kling",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "text2video-v2:k-artifact",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-kling-poll",
      presetId: "kling",
      mode: "text2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-kling-t2v-output" },
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: KLING_T2V_V2_ROUTE_ID,
        adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });

  it("keeps historical unfrozen submissions parseable without advertising the legacy route", async () => {
    let body: Record<string, unknown> | undefined;
    const vendor = createKlingRuntimeVendor({
      accessKey: "ak",
      secret: "sk",
      fetchImpl: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const requestBody = init?.body;
        if (typeof requestBody !== "string") {
          throw new Error("missing historical Kling request body");
        }
        body = JSON.parse(requestBody);
        return new Response(JSON.stringify({ code: 0, data: { task_id: "legacy-job" } }));
      }) as unknown as typeof fetch,
    });
    await expect(
      vendor.submit({
        taskId: "legacy-task",
        presetId: "kling",
        mode: "text2video",
        prompt: "historical prompt",
        durationSec: 10,
        params: { model_name: "legacy-model", aspect_ratio: "1:1", cfg_scale: 0.6 },
      }),
    ).resolves.toMatchObject({ state: "processing", vendorJobId: "text2video:legacy-job" });
    expect(body).toEqual({
      model_name: "legacy-model",
      prompt: "historical prompt",
      duration: "10",
      aspect_ratio: "1:1",
      cfg_scale: 0.6,
    });
    expect(
      vendor.capabilityRouteClaims?.some(
        (claim) => claim.route.routeId === "kling.open.v1.text2video",
      ),
    ).toBe(false);
  });
});
