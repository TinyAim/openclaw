import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import {
  COGVIDEOX3_T2V_ADAPTER_REVISION,
  COGVIDEOX3_T2V_ENDPOINT_ID,
  COGVIDEOX3_T2V_MODEL_ID,
  COGVIDEOX3_T2V_PROFILE_DIGEST,
  COGVIDEOX3_T2V_PROFILE_ID,
  COGVIDEOX3_T2V_ROUTE_ID,
  compileCogVideoX3T2vRequest,
} from "./cogvideox3-text2video-compiler.js";
import { COGVIDEOX3_T2V_JOB_PREFIX, createCogVideoX3RuntimeVendor } from "./cogvideox3-vendor.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function frozenPlan(
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    fps?: number;
    outputAudioPolicy?: "silent" | "native_generate";
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A red paper kite rises above a misty riverside town.";
  const native = (intentPath: string, providerField: string) => ({
    intentPath,
    sourceRef: "pack:R1",
    sourceRevision: "R1",
    required: true,
    support: "native" as const,
    providerField,
    reasonCode: "value_native",
    messageKey: "media.value_native",
  });
  const outputAudioPolicy = overrides.outputAudioPolicy ?? "silent";
  return {
    schemaVersion: 2,
    previewId: "preview-cogvideox3",
    presetId: "cogvideox",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-cogvideox3",
        shotId: "shot-cogvideox3",
        shotVersion: "R1",
        promptPackId: "pack-cogvideox3",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy,
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Slow upward crane." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "1080p",
        fps: overrides.fps ?? 30,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: COGVIDEOX3_T2V_ROUTE_ID,
      providerId: "zhipu_open_platform",
      modelId: COGVIDEOX3_T2V_MODEL_ID,
      endpointId: COGVIDEOX3_T2V_ENDPOINT_ID,
      region: "cn",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: COGVIDEOX3_T2V_PROFILE_ID,
      revision: 1,
      digest: COGVIDEOX3_T2V_PROFILE_DIGEST,
    },
    adapterRevision: COGVIDEOX3_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-cogvideox3", lastSeenAt: "2026-08-01T00:00:00Z" },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "output.audio"),
      {
        ...native("compiledPrompt", "prompt"),
        support: "prompt",
      },
      native("output.durationSec", "output.durationSec"),
      native("output.aspectRatio", "output.aspectRatio"),
      native("output.resolution", "output.resolution"),
      native("output.fps", "output.fps"),
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
    taskId: "task-cogvideox3",
    presetId: "cogvideox",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    frozenPlan: plan,
    ...overrides,
  };
}

describe("CogVideoX-3 exact Text-to-Video runtime", () => {
  it("compiles both frozen audio policies into the documented exact body", async () => {
    expect(compileCogVideoX3T2vRequest(vendorInput())).toMatchObject({
      ok: true,
      body: {
        model: "cogvideox-3",
        quality: "quality",
        with_audio: false,
        watermark_enabled: true,
        size: "1920x1080",
        fps: 30,
        duration: 5,
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    const audioPlan = frozenPlan({
      durationSec: 10,
      aspectRatio: "9:16",
      fps: 60,
      outputAudioPolicy: "native_generate",
    });
    expect(compileCogVideoX3T2vRequest(vendorInput(audioPlan))).toMatchObject({
      ok: true,
      body: {
        with_audio: true,
        size: "1080x1920",
        fps: 60,
        duration: 10,
      },
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      return new Response(JSON.stringify({ id: "zhipu-job-1", task_status: "PROCESSING" }));
    }) as unknown as typeof fetch;
    const submitted = await createCogVideoX3RuntimeVendor({
      apiKey: "zhipu-key",
      fetchImpl,
    }).submit(vendorInput(audioPlan));
    expect(submitted).toMatchObject({
      state: "processing",
      vendorJobId: `${COGVIDEOX3_T2V_JOB_PREFIX}zhipu-job-1`,
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    expect(calls[0]?.url).toBe("https://open.bigmodel.cn/api/paas/v4/videos/generations");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer zhipu-key",
    });
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("missing CogVideoX-3 request body");
    }
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "cogvideox-3",
      with_audio: true,
      watermark_enabled: true,
    });
  });

  it("rejects profile drift, passthrough, references, and unsupported output before fetch", async () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileCogVideoX3T2vRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3T2vRequest(vendorInput(frozenPlan(), { params: { quality: "speed" } })),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3T2vRequest(
        vendorInput(frozenPlan(), {
          source: { bytes: Buffer.from("image"), mimeType: "image/png" },
        }),
      ),
    ).toMatchObject({ ok: false });
    const referenced = frozenPlan();
    referenced.generationIntent.references.push({
      role: "first_frame",
      ordinal: 0,
      required: true,
      mediaClass: "image",
      source: { kind: "artifact", artifactId: "artifact-not-supported" },
      authorityVerified: true,
    });
    expect(compileCogVideoX3T2vRequest(vendorInput(referenced))).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3T2vRequest(vendorInput(frozenPlan({ prompt: "界".repeat(513) }))),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3T2vRequest(
        vendorInput(frozenPlan({ durationSec: 6, resolution: "4k", fps: 24 })),
      ),
    ).toMatchObject({ ok: false });

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      await createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl }).submit(
        vendorInput(frozenPlan(), { params: { user_id: "private" } }),
      ),
    ).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("distinguishes ambiguous submission from normalized provider failures", async () => {
    const ambiguous = createCogVideoX3RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    });
    const unknown = await ambiguous.submit(vendorInput());
    expect(unknown).toMatchObject({
      state: "submission_unknown",
      providerObservation: { operation: "submit", outcome: "submission_unknown" },
    });
    expect(JSON.stringify(unknown)).not.toContain("private transport detail");

    const noReceipt = createCogVideoX3RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ task_status: "PROCESSING" })),
      ) as unknown as typeof fetch,
    });
    expect(await noReceipt.submit(vendorInput())).toMatchObject({
      state: "submission_unknown",
    });

    const rejected = createCogVideoX3RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "token private-provider-value" } }), {
            status: 401,
          }),
      ) as unknown as typeof fetch,
    });
    const failure = await rejected.submit(vendorInput());
    expect(failure).toMatchObject({ state: "failed", reason: "auth" });
    expect(JSON.stringify(failure)).not.toContain("private-provider-value");
  });

  it("polls and reconciles a prefixed job across vendor instances", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(requestUrl(url));
      return calls.length === 1
        ? new Response(JSON.stringify({ id: "job-9", task_status: "PROCESSING" }))
        : new Response(
            JSON.stringify({
              id: "job-9",
              task_status: "SUCCESS",
              video_result: [{ url: "https://media.bigmodel.example/video.mp4" }],
            }),
          );
    }) as unknown as typeof fetch;
    const receipt = `${COGVIDEOX3_T2V_JOB_PREFIX}job-9`;
    const restarted = createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl });
    expect(await restarted.poll(receipt)).toMatchObject({
      state: "processing",
      providerObservation: { operation: "poll", outcome: "processing" },
    });
    expect(await restarted.reconcile?.(receipt)).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.bigmodel.example/video.mp4", resolution: "1080p" },
      providerObservation: { operation: "reconcile", outcome: "succeeded" },
    });
    expect(calls).toEqual([
      "https://open.bigmodel.cn/api/paas/v4/async-result/job-9",
      "https://open.bigmodel.cn/api/paas/v4/async-result/job-9",
    ]);
    expect("cancel" in restarted).toBe(false);
  });

  it("fails closed on unsafe output URLs and unknown task states", async () => {
    const unsafe = createCogVideoX3RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "job-unsafe",
              task_status: "SUCCESS",
              video_result: [{ url: "http://unsafe.example/video.mp4" }],
            }),
          ),
      ) as unknown as typeof fetch,
    });
    expect(await unsafe.poll(`${COGVIDEOX3_T2V_JOB_PREFIX}job-unsafe`)).toMatchObject({
      state: "failed",
      reason: "download_failed",
    });
    const unknown = createCogVideoX3RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ id: "job-new", task_status: "NEW_STATE" })),
      ) as unknown as typeof fetch,
    });
    expect(await unknown.poll(`${COGVIDEOX3_T2V_JOB_PREFIX}job-new`)).toMatchObject({
      state: "failed",
      reason: "vendor_failed",
    });
  });

  it("downloads, validates, labels, and hands the completed video to Artifact Center", async () => {
    const outputBytes = Buffer.from("cogvideox3-video-bytes");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const value = requestUrl(url);
      if (value.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ id: "artifact-job", task_status: "PROCESSING" }));
      }
      if (value.includes("/async-result/")) {
        return new Response(
          JSON.stringify({
            id: "artifact-job",
            task_status: "SUCCESS",
            video_result: [{ url: "https://media.bigmodel.example/output.mp4" }],
          }),
        );
      }
      return new Response(outputBytes, {
        headers: { "content-type": "video/mp4", "content-length": String(outputBytes.length) },
      });
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ bytes, sha256 }: { bytes: Buffer; sha256: string }) => {
      expect(bytes).toEqual(outputBytes);
      return { artifactId: "artifact-cogvideox3", mimeType: "video/mp4", sha256 };
    });
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-cogvideox3",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("CogVideoX-3 T2V must not resolve input artifacts");
      }),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.bigmodel.example"],
      moderation: {
        screenInput: vi.fn(async () => ({ allowed: true })),
        screenOutput: vi.fn(async () => ({ allowed: true })),
      },
      labeler: { applyLabel: vi.fn(async (output) => ({ ...output, applied: true })) },
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-cogvideox3",
      workspaceId: "ws-cogvideox3",
      correlationId: "corr-cogvideox3-submit",
      presetId: "cogvideox",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${COGVIDEOX3_T2V_JOB_PREFIX}artifact-job`,
    });
    const completed = await executor.dispatch({
      ...dispatch,
      op: "poll",
      correlationId: "corr-cogvideox3-poll",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-cogvideox3" },
      providerObservation: { operation: "poll", outcome: "succeeded", qualityOutcome: "passed" },
      snapshot: { moderationStatus: "runtime_enforced", labelingStatus: "runtime_applied" },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
