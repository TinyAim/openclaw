import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";
import { WAN22_I2V_JOB_PREFIX, createWanRuntimeVendor } from "./wan-vendor.js";
import {
  compileWan22I2vRequest,
  WAN22_I2V_ADAPTER_REVISION,
  WAN22_I2V_ENDPOINT_ID,
  WAN22_I2V_MODEL_ID,
  WAN22_I2V_PROFILE_DIGEST,
  WAN22_I2V_PROFILE_ID,
  WAN22_I2V_ROUTE_ID,
} from "./wan2-2-i2v-compiler.js";
import { wanTestJpeg, wanTestPng, wanTestSha } from "./wan2-2-i2v.test-support.js";

const FRAME_BYTES = wanTestPng(640, 360);

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
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A paper kite rises while the camera slowly tilts upward.";
  return {
    schemaVersion: 2,
    previewId: "preview-wan-i2v",
    presetId: "wan",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-wan-i2v",
        shotId: "shot-wan-i2v",
        shotVersion: "R1",
        promptPackId: "pack-wan-i2v",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${wanTestSha(FRAME_BYTES)}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
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
          source: { kind: "artifact", artifactId: "artifact-wan-frame" },
          assetRefId: "asset-wan-frame",
          authorityRef: "artifact:wan-frame",
          authorityVerified: true,
          mimeType: "image/png",
          sourceDigest: `sha256:${wanTestSha(FRAME_BYTES)}`,
        },
      ],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "1080p",
        ...(overrides.fps === undefined ? {} : { fps: overrides.fps }),
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: WAN22_I2V_ROUTE_ID,
      providerId: "dashscope",
      modelId: WAN22_I2V_MODEL_ID,
      endpointId: WAN22_I2V_ENDPOINT_ID,
      region: "cn-beijing",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: WAN22_I2V_PROFILE_ID,
      revision: 1,
      digest: WAN22_I2V_PROFILE_DIGEST,
    },
    adapterRevision: WAN22_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-wan", lastSeenAt: "2026-08-01T00:00:00.000Z" },
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
        sourceRef: "asset:asset-wan-frame",
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
      ].map(([intentPath, providerField]) => ({
        intentPath,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: true,
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
    source: { bytes, mimeType, sha256: wanTestSha(bytes) },
  };
}

function planForBytes(bytes: Buffer, mimeType = "image/png"): MediaGenRuntimeFrozenPlanV2 {
  const plan = frozenPlan();
  const reference = plan.generationIntent.references[0];
  if (!reference) {
    throw new Error("Wan test plan is missing its first-frame reference.");
  }
  plan.generationIntent.identity.sourceDigests = [`sha256:${wanTestSha(bytes)}`];
  reference.sourceDigest = `sha256:${wanTestSha(bytes)}`;
  reference.mimeType = mimeType;
  return plan;
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-wan-i2v",
    presetId: "wan",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    sources: [sourceSlot(FRAME_BYTES, plan.generationIntent.references[0]?.mimeType)],
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Wan 2.2 exact first-frame Image-to-Video runtime", () => {
  it("compiles verified Artifact bytes into the documented DashScope request", async () => {
    const compiled = compileWan22I2vRequest(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "wan2.2-i2v-plus",
        input: {
          prompt: "A paper kite rises while the camera slowly tilts upward.",
          img_url: `data:image/png;base64,${FRAME_BYTES.toString("base64")}`,
        },
        parameters: { resolution: "1080P", prompt_extend: false, watermark: true },
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      return new Response(
        JSON.stringify({ output: { task_id: "wan-i2v-1", task_status: "PENDING" } }),
      );
    }) as unknown as typeof fetch;
    const submitted = await createWanRuntimeVendor({ apiKey: "key", fetchImpl }).submit(
      vendorInput(),
    );
    expect(submitted).toMatchObject({
      state: "processing",
      vendorJobId: `${WAN22_I2V_JOB_PREFIX}wan-i2v-1`,
      providerObservation: {
        routeId: WAN22_I2V_ROUTE_ID,
        adapterRevision: WAN22_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual(
      compiled.ok ? compiled.body : undefined,
    );

    const jpegBytes = wanTestJpeg(640, 360);
    expect(
      compileWan22I2vRequest(
        vendorInput(planForBytes(jpegBytes, "image/jpeg"), {
          sources: [sourceSlot(jpegBytes, "image/jpeg")],
        }),
      ),
    ).toMatchObject({
      ok: true,
      body: { input: { img_url: expect.stringMatching(/^data:image\/jpeg;base64,/u) } },
    });
  });

  it("fails closed on drift, passthrough, provider refs, and invalid image constraints", async () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileWan22I2vRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileWan22I2vRequest(vendorInput(frozenPlan(), { params: { seed: 7 } })),
    ).toMatchObject({ ok: false });
    expect(
      compileWan22I2vRequest(
        vendorInput(frozenPlan(), {
          sources: [
            {
              role: "first_frame",
              ordinal: 0,
              source: { providerRef: "https://private.example/frame.png", mimeType: "image/png" },
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });

    for (const bytes of [wanTestPng(239, 360), wanTestPng(640, 480), wanTestPng(640, 360, 6)]) {
      expect(
        compileWan22I2vRequest(
          vendorInput(planForBytes(bytes), {
            sources: [sourceSlot(bytes)],
          }),
        ),
      ).toMatchObject({ ok: false });
    }
    const oversized = Buffer.concat([FRAME_BYTES, Buffer.alloc(10 * 1024 * 1024)]);
    expect(
      compileWan22I2vRequest(
        vendorInput(planForBytes(oversized), {
          sources: [sourceSlot(oversized)],
        }),
      ),
    ).toMatchObject({ ok: false });
    const digestDrift = sourceSlot();
    digestDrift.source.sha256 = "f".repeat(64);
    expect(
      compileWan22I2vRequest(vendorInput(frozenPlan(), { sources: [digestDrift] })),
    ).toMatchObject({ ok: false });
    expect(compileWan22I2vRequest(vendorInput(frozenPlan({ fps: 30 })))).toMatchObject({
      ok: false,
    });

    const unsupported = frozenPlan();
    unsupported.providerRouteRef.routeId = "wan.dashscope.unknown.image2video";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      await createWanRuntimeVendor({ apiKey: "key", fetchImpl }).submit(vendorInput(unsupported)),
    ).toMatchObject({
      state: "failed",
      reason: "vendor_rejected",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps ambiguous submit and restart polling bound to the I2V receipt", async () => {
    const ambiguous = createWanRuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    });
    const unknown = await ambiguous.submit(vendorInput());
    expect(unknown).toMatchObject({
      state: "submission_unknown",
      providerObservation: {
        routeId: WAN22_I2V_ROUTE_ID,
        adapterRevision: WAN22_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("private transport detail");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(requestUrl(url));
      return calls.length === 1
        ? new Response(JSON.stringify({ output: { task_status: "RUNNING" } }))
        : new Response(
            JSON.stringify({
              output: {
                task_status: "SUCCEEDED",
                video_url: "https://media.example/wan-i2v.mp4",
              },
            }),
          );
    }) as unknown as typeof fetch;
    const restarted = createWanRuntimeVendor({ apiKey: "key", fetchImpl });
    const receipt = `${WAN22_I2V_JOB_PREFIX}wan-i2v-9`;
    expect(await restarted.poll(receipt)).toMatchObject({ state: "processing" });
    expect(await restarted.reconcile?.(receipt)).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.example/wan-i2v.mp4", durationSec: 5 },
      providerObservation: {
        routeId: WAN22_I2V_ROUTE_ID,
        adapterRevision: WAN22_I2V_ADAPTER_REVISION,
        operation: "reconcile",
        outcome: "succeeded",
      },
    });
    expect(calls).toEqual([
      "https://dashscope.aliyuncs.com/api/v1/tasks/wan-i2v-9",
      "https://dashscope.aliyuncs.com/api/v1/tasks/wan-i2v-9",
    ]);
  });

  it("redeems the role-scoped grant and hands output bytes to Artifact Center", async () => {
    const outputBytes = Buffer.from("wan-i2v-video-bytes");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/video-synthesis") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ output: { task_id: "wan-artifact-i2v", task_status: "PENDING" } }),
        );
      }
      if (value.endsWith("/tasks/wan-artifact-i2v")) {
        return new Response(
          JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              video_url: "https://media.example/wan-i2v-output.mp4",
            },
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
      sha256: wanTestSha(FRAME_BYTES),
    }));
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-wan-i2v-output",
      mimeType: "video/mp4",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-wan",
      register: vi.fn(async () => undefined),
      resolveArtifactReference,
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createWanRuntimeVendor({ apiKey: "key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
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
      taskId: "task-wan-i2v",
      workspaceId: "ws-wan",
      correlationId: "corr-wan-i2v-submit",
      presetId: "wan",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-wan-frame",
          role: "first_frame",
          ordinal: 0,
        },
      ],
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${WAN22_I2V_JOB_PREFIX}wan-artifact-i2v`,
    });
    expect(resolveArtifactReference).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-wan-frame",
        role: "first_frame",
      }),
    );
    const completed = await executor.dispatch({
      ...dispatch,
      op: "poll",
      correlationId: "corr-wan-i2v-poll",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-wan-i2v-output" },
      providerObservation: {
        routeId: WAN22_I2V_ROUTE_ID,
        adapterRevision: WAN22_I2V_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
      snapshot: { moderationStatus: "runtime_enforced", labelingStatus: "runtime_applied" },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
