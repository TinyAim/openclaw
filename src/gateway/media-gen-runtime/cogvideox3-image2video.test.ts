import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import {
  COGVIDEOX3_I2V_ADAPTER_REVISION,
  COGVIDEOX3_I2V_ENDPOINT_ID,
  COGVIDEOX3_I2V_MODEL_ID,
  COGVIDEOX3_I2V_PROFILE_DIGEST,
  COGVIDEOX3_I2V_PROFILE_ID,
  COGVIDEOX3_I2V_ROUTE_ID,
  compileCogVideoX3I2vRequest,
} from "./cogvideox3-image2video-compiler.js";
import { COGVIDEOX3_I2V_JOB_PREFIX, createCogVideoX3RuntimeVendor } from "./cogvideox3-vendor.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

const FRAME_BYTES = Buffer.from("cogvideox3-first-frame");

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
    mimeType?: string;
    prompt?: string;
    outputAudioPolicy?: "silent" | "native_generate";
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A paper boat glides forward as gentle ripples spread.";
  const outputAudioPolicy = overrides.outputAudioPolicy ?? "silent";
  return {
    schemaVersion: 2,
    previewId: "preview-cogvideox3-i2v",
    presetId: "cogvideox",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-cogvideox3-i2v",
        shotId: "shot-cogvideox3-i2v",
        shotVersion: "R1",
        promptPackId: "pack-cogvideox3-i2v",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${sha(FRAME_BYTES)}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy,
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "artifact", artifactId: "artifact-cogvideox3-frame" },
          assetRefId: "asset-cogvideox3-frame",
          authorityRef: "artifact:cogvideox3-frame",
          authorityVerified: true,
          mimeType: overrides.mimeType ?? "image/png",
          sourceDigest: `sha256:${sha(FRAME_BYTES)}`,
        },
      ],
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
    generationScenario: "first_frame_to_video",
    outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: COGVIDEOX3_I2V_ROUTE_ID,
      providerId: "zhipu_open_platform",
      modelId: COGVIDEOX3_I2V_MODEL_ID,
      endpointId: COGVIDEOX3_I2V_ENDPOINT_ID,
      region: "cn",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: COGVIDEOX3_I2V_PROFILE_ID,
      revision: 1,
      digest: COGVIDEOX3_I2V_PROFILE_DIGEST,
    },
    adapterRevision: COGVIDEOX3_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-cogvideox3", lastSeenAt: "2026-08-01T00:00:00Z" },
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
        intentPath: "references.first_frame.0",
        sourceRef: "asset:asset-cogvideox3-frame",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerSlot: "references.first_frame",
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      },
      ...[
        ["output.durationSec", "output.durationSec"],
        ["output.aspectRatio", "output.aspectRatio"],
        ["output.resolution", "output.resolution"],
        ["output.fps", "output.fps"],
      ].map(([intentPath, providerField]) => ({
        intentPath,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native" as const,
        providerField,
        reasonCode: "output_native",
        messageKey: "media.output_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlot(bytes = FRAME_BYTES, mimeType = "image/png"): MediaGenRuntimeSourceSlot {
  return {
    role: "first_frame",
    ordinal: 0,
    source: { bytes, mimeType, sha256: sha(bytes) },
  };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-cogvideox3-i2v",
    presetId: "cogvideox",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    sources: [sourceSlot(FRAME_BYTES, plan.generationIntent.references[0]?.mimeType)],
    frozenPlan: plan,
    ...overrides,
  };
}

describe("CogVideoX-3 exact Image-to-Video runtime", () => {
  it("compiles one verified first frame into the documented Base64 image_url", async () => {
    const compiled = compileCogVideoX3I2vRequest(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "cogvideox-3",
        image_url: `data:image/png;base64,${FRAME_BYTES.toString("base64")}`,
        prompt: "A paper boat glides forward as gentle ripples spread.",
        quality: "quality",
        with_audio: false,
        watermark_enabled: true,
        size: "1920x1080",
        fps: 30,
        duration: 5,
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      return new Response(JSON.stringify({ id: "zhipu-i2v-1", task_status: "PROCESSING" }));
    }) as unknown as typeof fetch;
    const submitted = await createCogVideoX3RuntimeVendor({
      apiKey: "zhipu-key",
      fetchImpl,
    }).submit(vendorInput());
    expect(submitted).toMatchObject({
      state: "processing",
      vendorJobId: `${COGVIDEOX3_I2V_JOB_PREFIX}zhipu-i2v-1`,
      providerObservation: {
        routeId: COGVIDEOX3_I2V_ROUTE_ID,
        adapterRevision: COGVIDEOX3_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe("https://open.bigmodel.cn/api/paas/v4/videos/generations");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual(
      compiled.ok ? compiled.body : undefined,
    );
  });

  it("rejects route drift, passthrough, unverified sources, MIME drift, and oversized images", async () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileCogVideoX3I2vRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3I2vRequest(vendorInput(frozenPlan(), { params: { quality: "speed" } })),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3I2vRequest(
        vendorInput(frozenPlan({ mimeType: "image/webp" }), {
          sources: [sourceSlot(FRAME_BYTES, "image/webp")],
        }),
      ),
    ).toMatchObject({ ok: false });
    const digestDrift = sourceSlot();
    digestDrift.source.sha256 = "f".repeat(64);
    expect(
      compileCogVideoX3I2vRequest(vendorInput(frozenPlan(), { sources: [digestDrift] })),
    ).toMatchObject({ ok: false });

    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const oversizedPlan = frozenPlan();
    oversizedPlan.generationIntent.references[0].sourceDigest = `sha256:${sha(oversized)}`;
    expect(
      compileCogVideoX3I2vRequest(vendorInput(oversizedPlan, { sources: [sourceSlot(oversized)] })),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3I2vRequest(
        vendorInput(frozenPlan({ durationSec: 6, resolution: "4k", fps: 24 })),
      ),
    ).toMatchObject({ ok: false });

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      await createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl }).submit(
        vendorInput(frozenPlan(), { source: sourceSlot().source, sources: undefined }),
      ),
    ).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps ambiguous submit and restart-safe polling bound to the I2V route", async () => {
    const ambiguous = createCogVideoX3RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    });
    const unknown = await ambiguous.submit(vendorInput());
    expect(unknown).toMatchObject({
      state: "submission_unknown",
      providerObservation: {
        routeId: COGVIDEOX3_I2V_ROUTE_ID,
        adapterRevision: COGVIDEOX3_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("private transport detail");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(requestUrl(url));
      return calls.length === 1
        ? new Response(JSON.stringify({ id: "job-i2v-9", task_status: "PROCESSING" }))
        : new Response(
            JSON.stringify({
              id: "job-i2v-9",
              task_status: "SUCCESS",
              video_result: [{ url: "https://media.bigmodel.example/i2v.mp4" }],
            }),
          );
    }) as unknown as typeof fetch;
    const restarted = createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl });
    const receipt = `${COGVIDEOX3_I2V_JOB_PREFIX}job-i2v-9`;
    expect(await restarted.poll(receipt)).toMatchObject({ state: "processing" });
    expect(await restarted.reconcile?.(receipt)).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.bigmodel.example/i2v.mp4", resolution: "1080p" },
      providerObservation: {
        routeId: COGVIDEOX3_I2V_ROUTE_ID,
        adapterRevision: COGVIDEOX3_I2V_ADAPTER_REVISION,
        operation: "reconcile",
        outcome: "succeeded",
      },
    });
  });

  it("resolves the first-frame grant and hands the validated output to Artifact Center", async () => {
    const outputBytes = Buffer.from("cogvideox3-i2v-video-bytes");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const value = requestUrl(url);
      if (value.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ id: "artifact-i2v-job", task_status: "PROCESSING" }));
      }
      if (value.includes("/async-result/")) {
        return new Response(
          JSON.stringify({
            id: "artifact-i2v-job",
            task_status: "SUCCESS",
            video_result: [{ url: "https://media.bigmodel.example/i2v-output.mp4" }],
          }),
        );
      }
      return new Response(outputBytes, {
        headers: { "content-type": "video/mp4", "content-length": String(outputBytes.length) },
      });
    }) as unknown as typeof fetch;
    const resolveArtifactReference = vi.fn(async () => ({
      bytes: FRAME_BYTES,
      mimeType: "image/png",
      sha256: sha(FRAME_BYTES),
    }));
    const handoffArtifact = vi.fn(async ({ bytes, sha256 }: { bytes: Buffer; sha256: string }) => {
      expect(bytes).toEqual(outputBytes);
      return { artifactId: "artifact-cogvideox3-i2v", mimeType: "video/mp4", sha256 };
    });
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-cogvideox3",
      register: vi.fn(async () => undefined),
      resolveArtifactReference,
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
      taskId: "task-cogvideox3-i2v",
      workspaceId: "ws-cogvideox3",
      correlationId: "corr-cogvideox3-i2v-submit",
      presetId: "cogvideox",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-cogvideox3-frame",
          role: "first_frame",
          ordinal: 0,
        },
      ],
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${COGVIDEOX3_I2V_JOB_PREFIX}artifact-i2v-job`,
    });
    expect(resolveArtifactReference).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-cogvideox3-frame",
        role: "first_frame",
      }),
    );
    const completed = await executor.dispatch({
      ...dispatch,
      op: "poll",
      correlationId: "corr-cogvideox3-i2v-poll",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-cogvideox3-i2v" },
      providerObservation: {
        routeId: COGVIDEOX3_I2V_ROUTE_ID,
        adapterRevision: COGVIDEOX3_I2V_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
      snapshot: { moderationStatus: "runtime_enforced", labelingStatus: "runtime_applied" },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
