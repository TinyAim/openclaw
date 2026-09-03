import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";
import {
  compileViduQ1T2vRequest,
  VIDU_Q1_T2V_ADAPTER_REVISION,
  VIDU_Q1_T2V_ENDPOINT_ID,
  VIDU_Q1_T2V_HISTORICAL_PROFILE_DIGEST,
  VIDU_Q1_T2V_HISTORICAL_PROFILE_ID,
  VIDU_Q1_T2V_HISTORICAL_PROFILE_REVISION,
  VIDU_Q1_T2V_MODEL_ID,
  VIDU_Q1_T2V_PROFILE_DIGEST,
  VIDU_Q1_T2V_PROFILE_ID,
  VIDU_Q1_T2V_PROFILE_REVISION,
  VIDU_Q1_T2V_ROUTE_ID,
} from "./vidu-q1-text2video-compiler.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function requestJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("missing Vidu request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function frozenPlan(
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    fps?: number;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A paper lantern drifts above a quiet canal at blue hour.";
  return {
    schemaVersion: 2,
    previewId: "preview-vidu-q1-t2v",
    presetId: "vidu",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-vidu-t2v",
        shotId: "shot-vidu-t2v",
        shotVersion: "R1",
        promptPackId: "pack-vidu-t2v",
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
        visualPrompt: "A paper lantern above a quiet canal.",
        reservedForLater: [],
      },
      camera: { cameraPrompt: "Slow forward dolly." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "1080p",
        fps: overrides.fps ?? 24,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: VIDU_Q1_T2V_ROUTE_ID,
      providerId: "vidu_enterprise",
      modelId: VIDU_Q1_T2V_MODEL_ID,
      endpointId: VIDU_Q1_T2V_ENDPOINT_ID,
      region: "unknown",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: VIDU_Q1_T2V_PROFILE_ID,
      revision: VIDU_Q1_T2V_PROFILE_REVISION,
      digest: VIDU_Q1_T2V_PROFILE_DIGEST,
    },
    adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-vidu",
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
      ...["durationSec", "aspectRatio", "resolution", "fps"].map((field) => ({
        intentPath: `output.${field}`,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native" as const,
        providerField: `output.${field}`,
        reasonCode: "output_native",
        messageKey: "media.output_native",
      })),
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
    taskId: "task-vidu-q1-t2v",
    presetId: "vidu",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Vidu Q1 exact Text-to-Video Adapter V2", () => {
  it("compiles and submits only the pinned official Q1 fields", async () => {
    const compiled = compileViduQ1T2vRequest(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "viduq1",
        style: "general",
        prompt: expect.any(String),
        duration: 5,
        aspect_ratio: "16:9",
        resolution: "1080p",
        bgm: false,
        movement_amplitude: "auto",
        off_peak: false,
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createViduRuntimeVendor({
      apiKey: "vidu-key",
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(JSON.stringify({ task_id: "vidu-t2v-1" }));
      }) as unknown as typeof fetch,
    });
    expect(vendor.capabilityRouteClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: "text2video",
          route: { ...frozenPlan().providerRouteRef },
          adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
        }),
      ]),
    );
    expect(await vendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: "text2video-q1:vidu-t2v-1",
      providerObservation: {
        routeId: VIDU_Q1_T2V_ROUTE_ID,
        adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe("https://api.vidu.com/ent/v2/text2video");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Token vidu-key" });
    expect(requestJsonBody(calls[0]?.init)).toEqual(compiled.ok ? compiled.body : undefined);
  });

  it("fails identity, mapping, reference, and output drift before fetch", async () => {
    const fetchImpl = vi.fn();
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    await expect(vendor.submit(vendorInput(stale))).resolves.toMatchObject({
      state: "failed",
      reason: "vendor_rejected",
    });
    await expect(
      vendor.submit(vendorInput(frozenPlan(), { params: { off_peak: true } })),
    ).resolves.toMatchObject({ state: "failed", reason: "vendor_rejected" });
    await expect(
      vendor.submit(vendorInput(frozenPlan(), { prompt: "different prompt" })),
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
    expect(compileViduQ1T2vRequest(vendorInput(referenced))).toMatchObject({ ok: false });
    expect(compileViduQ1T2vRequest(vendorInput(frozenPlan({ durationSec: 6 })))).toMatchObject({
      ok: false,
    });
    expect(compileViduQ1T2vRequest(vendorInput(frozenPlan({ aspectRatio: "4:3" })))).toMatchObject({
      ok: false,
    });
    expect(compileViduQ1T2vRequest(vendorInput(frozenPlan({ resolution: "720p" })))).toMatchObject({
      ok: false,
    });
    expect(compileViduQ1T2vRequest(vendorInput(frozenPlan({ fps: 30 })))).toMatchObject({
      ok: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps an exact V1 frozen receipt readable without advertising it", () => {
    const historical = frozenPlan();
    historical.capabilityProfileRef = {
      profileId: VIDU_Q1_T2V_HISTORICAL_PROFILE_ID,
      revision: VIDU_Q1_T2V_HISTORICAL_PROFILE_REVISION,
      digest: VIDU_Q1_T2V_HISTORICAL_PROFILE_DIGEST,
    };
    expect(compileViduQ1T2vRequest(vendorInput(historical))).toMatchObject({
      ok: true,
      body: { model: "viduq1", duration: 5, resolution: "1080p" },
    });
  });

  it("marks ambiguous creates without leaking transport details", async () => {
    const networkVendor = createViduRuntimeVendor({
      apiKey: "vidu-key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    });
    const networkResult = await networkVendor.submit(vendorInput());
    expect(networkResult).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: VIDU_Q1_T2V_ROUTE_ID,
        operation: "submit",
        outcome: "submission_unknown",
        qualityOutcome: "not_run",
      },
    });
    expect(JSON.stringify(networkResult)).not.toContain("private transport detail");

    const noReceiptVendor = createViduRuntimeVendor({
      apiKey: "vidu-key",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ state: "created" }))),
    });
    await expect(noReceiptVendor.submit(vendorInput())).resolves.toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
    });
  });

  it("preserves exact prefixed poll, reconcile, and cancel identity across restart", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, init });
      if (value.endsWith("/pending/creations")) {
        return new Response(JSON.stringify({ state: "processing" }));
      }
      if (value.endsWith("/failed/creations")) {
        return new Response(JSON.stringify({ state: "failed", reason: "generation failed" }));
      }
      if (value.endsWith("/complete/creations")) {
        return new Response(
          JSON.stringify({
            state: "success",
            creations: [{ url: "https://media.example/vidu.mp4" }],
          }),
        );
      }
      return new Response(JSON.stringify({ state: "success" }));
    }) as unknown as typeof fetch;
    const restarted = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });

    expect(await restarted.poll("text2video-q1:pending")).toMatchObject({
      state: "processing",
      providerObservation: { operation: "poll", outcome: "processing" },
    });
    expect(await restarted.reconcile!("text2video-q1:failed")).toMatchObject({
      state: "failed",
      reason: "vendor_failed",
      providerObservation: { operation: "reconcile", outcome: "failed" },
    });
    expect(await restarted.poll("text2video-q1:complete")).toMatchObject({
      state: "succeeded",
      vendorJobId: "text2video-q1:complete",
      output: {
        mediaRef: "https://media.example/vidu.mp4",
        durationSec: 5,
        resolution: "1080p",
      },
      providerObservation: {
        routeId: VIDU_Q1_T2V_ROUTE_ID,
        adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
      },
    });
    await restarted.cancel!("text2video-q1:cancel-me");
    expect(calls.at(-1)).toMatchObject({
      url: "https://api.vidu.com/ent/v2/tasks/cancel-me/cancel",
      init: { method: "POST", body: JSON.stringify({ id: "cancel-me" }) },
    });

    const invalidFetch = vi.fn();
    const invalid = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl: invalidFetch });
    await expect(invalid.poll("text2video-q1:")).resolves.toMatchObject({
      state: "failed",
      reason: "vendor_failed",
      providerObservation: { routeId: VIDU_Q1_T2V_ROUTE_ID, outcome: "failed" },
    });
    expect(invalidFetch).not.toHaveBeenCalled();
  });

  it("downloads validated output before canonical Artifact handoff", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/text2video") && init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "vidu-artifact" }));
      }
      if (value.endsWith("/tasks/vidu-artifact/creations")) {
        return new Response(
          JSON.stringify({
            state: "success",
            creations: [{ url: "https://media.example/vidu.mp4" }],
          }),
        );
      }
      return new Response(Buffer.from("vidu-video-bytes"), {
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-vidu-t2v-output",
      mimeType: "video/mp4",
      durationSec: 5,
      resolution: "1080p",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-vidu",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("Vidu T2V must not resolve an input reference");
      }),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes: vi.fn(async () => ({ ok: true as const, verified: true })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-vidu-q1-t2v",
      workspaceId: "ws-vidu",
      correlationId: "corr-vidu-submit",
      presetId: "vidu",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "text2video-q1:vidu-artifact",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-vidu-poll",
      presetId: "vidu",
      mode: "text2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-vidu-t2v-output" },
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: VIDU_Q1_T2V_ROUTE_ID,
        adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });

  it("keeps historical generic submissions parseable without advertising that route", async () => {
    let body: Record<string, unknown> | undefined;
    const vendor = createViduRuntimeVendor({
      apiKey: "vidu-key",
      fetchImpl: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        body = requestJsonBody(init);
        return new Response(JSON.stringify({ task_id: "legacy-job" }));
      }) as unknown as typeof fetch,
    });
    await expect(
      vendor.submit({
        taskId: "legacy-task",
        presetId: "vidu",
        mode: "text2video",
        prompt: "historical prompt",
        durationSec: 5,
        resolution: "720p",
        params: { model: "legacy-model", aspect_ratio: "1:1" },
      }),
    ).resolves.toMatchObject({ state: "processing", vendorJobId: "legacy-job" });
    expect(body).toEqual({
      model: "legacy-model",
      prompt: "historical prompt",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "1:1",
    });
    expect(vendor.capabilityRouteClaims?.filter((claim) => claim.mode === "text2video")).toEqual([
      expect.objectContaining({
        adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
        route: expect.objectContaining({ routeId: VIDU_Q1_T2V_ROUTE_ID }),
      }),
    ]);
  });
});
