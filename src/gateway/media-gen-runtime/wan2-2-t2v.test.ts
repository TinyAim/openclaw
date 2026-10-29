import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";
import { WAN_DASHSCOPE_LEGACY_BASE_URL, createWanRuntimeVendor } from "./wan-vendor.js";
import {
  compileWan22T2vRequest,
  WAN22_T2V_ADAPTER_REVISION,
  WAN22_T2V_PROFILE_DIGEST,
  WAN22_T2V_ROUTE_ID,
} from "./wan2-2-t2v-compiler.js";

const DASHSCOPE_WORKSPACE_ID = "ws-wan-model-studio";
const DASHSCOPE_BASE_URL = `https://${DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1`;

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function frozenPlan(
  overrides: { durationSec?: number; aspectRatio?: string; resolution?: string } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A paper kite crosses the Beijing skyline in warm sunset light.";
  return {
    schemaVersion: 2,
    previewId: "preview-wan",
    presetId: "wan",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-wan",
        shotId: "shot-wan",
        shotVersion: "R1",
        promptPackId: "pack-wan",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Slow pan right." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "1080p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: WAN22_T2V_ROUTE_ID,
      providerId: "dashscope",
      modelId: "wan2.2-t2v-plus",
      endpointId: "dashscope.api.v1.video_generation.video_synthesis",
      region: "cn-beijing",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: "wan.openclaw-runtime.wan2_2_t2v_plus.text2video.1080p.v2",
      revision: 2,
      digest: WAN22_T2V_PROFILE_DIGEST,
    },
    adapterRevision: WAN22_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-wan", lastSeenAt: "2026-07-31T00:00:00.000Z" },
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
      ...["output.durationSec", "output.aspectRatio", "output.resolution"].map((intentPath) => ({
        intentPath,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native" as const,
        providerField: intentPath,
        reasonCode: "output_value_native",
        messageKey: "media.output_value_native",
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
    taskId: "task-wan",
    presetId: "wan",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Wan 2.2 exact Text-to-Video runtime", () => {
  it("compiles the frozen 1080P route and submits with async DashScope headers", async () => {
    const compiled = compileWan22T2vRequest(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "wan2.2-t2v-plus",
        input: { prompt: expect.any(String) },
        parameters: {
          size: "1920*1080",
          prompt_extend: false,
          watermark: false,
        },
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createWanRuntimeVendor({
      apiKey: "dashscope-secret",
      workspaceId: DASHSCOPE_WORKSPACE_ID,
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(
          JSON.stringify({ output: { task_id: "wan-job-1", task_status: "PENDING" } }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    expect(await vendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: "wan-job-1",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    expect(calls[0]?.url).toBe(
      `${DASHSCOPE_BASE_URL}/services/aigc/video-generation/video-synthesis`,
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer dashscope-secret",
      "x-dashscope-async": "enable",
    });
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("missing Wan request body");
    }
    expect(JSON.parse(requestBody)).toEqual(compiled.ok ? compiled.body : undefined);
  });

  it("rejects stale profiles, raw params, references, and unsupported output drift", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileWan22T2vRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileWan22T2vRequest(vendorInput(frozenPlan(), { params: { seed: 1 } })),
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
    expect(compileWan22T2vRequest(vendorInput(referenced))).toMatchObject({ ok: false });
    expect(compileWan22T2vRequest(vendorInput(frozenPlan({ durationSec: 6 })))).toMatchObject({
      ok: false,
    });
    expect(
      compileWan22T2vRequest(vendorInput(frozenPlan({ aspectRatio: "21:9", resolution: "720p" }))),
    ).toMatchObject({ ok: false });
  });

  it("marks ambiguous creates without leaking transport details", async () => {
    const vendor = createWanRuntimeVendor({
      apiKey: "secret",
      workspaceId: DASHSCOPE_WORKSPACE_ID,
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    });
    const result = await vendor.submit(vendorInput());
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: WAN22_T2V_ROUTE_ID,
        adapterRevision: WAN22_T2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("normalizes lifecycle states and mutates cancellation only for an exact PENDING task", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      if (value.endsWith("/cancel")) {
        return new Response("{}", { status: 200 });
      }
      const id = value.split("/").at(-1);
      if (id === "pending" || id === "queued") {
        return new Response(JSON.stringify({ output: { task_id: id, task_status: "PENDING" } }));
      }
      if (id === "running") {
        return new Response(JSON.stringify({ output: { task_id: id, task_status: "RUNNING" } }));
      }
      if (id === "unknown") {
        return new Response(JSON.stringify({ output: { task_id: id, task_status: "UNKNOWN" } }));
      }
      if (id === "canceled") {
        return new Response(JSON.stringify({ output: { task_id: id, task_status: "CANCELED" } }));
      }
      if (id === "failed") {
        return new Response(
          JSON.stringify({
            output: { task_status: "FAILED", code: "DataInspectionFailed" },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          output: {
            task_status: "SUCCEEDED",
            video_url: "https://media.example/wan.mp4",
          },
        }),
      );
    }) as unknown as typeof fetch;
    const vendor = createWanRuntimeVendor({
      apiKey: "secret",
      workspaceId: DASHSCOPE_WORKSPACE_ID,
      fetchImpl,
    });

    expect(await vendor.poll("pending")).toMatchObject({ state: "processing" });
    expect(await vendor.poll("canceled")).toMatchObject({ state: "canceled" });
    expect(await vendor.reconcile!("failed")).toMatchObject({
      state: "failed",
      reason: "content_blocked",
      providerObservation: { operation: "reconcile", outcome: "failed" },
    });
    expect(await vendor.poll("complete")).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.example/wan.mp4", durationSec: 5 },
    });
    await expect(vendor.cancel!("queued")).resolves.toMatchObject({
      state: "requested",
      providerObservation: { operation: "cancel", outcome: "processing" },
    });
    expect(calls.at(-1)).toEqual({
      url: `${DASHSCOPE_BASE_URL}/tasks/queued/cancel`,
      method: "POST",
    });
    const cancelPostCount = () =>
      calls.filter((call) => call.method === "POST" && call.url.endsWith("/cancel")).length;
    expect(cancelPostCount()).toBe(1);
    await expect(vendor.cancel!("running")).resolves.toMatchObject({
      state: "failed",
    });
    await expect(vendor.cancel!("unknown")).resolves.toMatchObject({
      state: "unknown",
    });
    expect(cancelPostCount()).toBe(1);
  });

  it("rejects missing workspace binding and mismatched cancel precheck receipts", async () => {
    const withoutWorkspace = createWanRuntimeVendor({
      apiKey: "secret",
      fetchImpl: vi.fn(),
    });
    expect(withoutWorkspace.capabilityRouteClaims).toBeUndefined();
    await expect(withoutWorkspace.submit(vendorInput())).resolves.toMatchObject({
      state: "failed",
      reason: "vendor_rejected",
    });
    const spoofedSharedBase = createWanRuntimeVendor({
      apiKey: "secret",
      workspaceId: DASHSCOPE_WORKSPACE_ID,
      baseUrl: WAN_DASHSCOPE_LEGACY_BASE_URL,
      fetchImpl: vi.fn(),
    });
    expect(spoofedSharedBase.capabilityRouteClaims).toBeUndefined();
    await expect(spoofedSharedBase.submit(vendorInput())).resolves.toMatchObject({
      state: "failed",
      reason: "vendor_rejected",
    });

    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            output: { task_id: "another-task", task_status: "PENDING" },
          }),
        ),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const exact = createWanRuntimeVendor({
      apiKey: "secret",
      workspaceId: DASHSCOPE_WORKSPACE_ID,
      fetchImpl,
    });
    await expect(exact.cancel!("task-to-cancel")).resolves.toMatchObject({
      state: "unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("downloads and validates output before the canonical Artifact handoff", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/video-synthesis") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ output: { task_id: "wan-artifact-job", task_status: "PENDING" } }),
        );
      }
      if (value.endsWith("/tasks/wan-artifact-job")) {
        return new Response(
          JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              video_url: "https://media.example/wan.mp4",
            },
          }),
        );
      }
      return new Response(Buffer.from("wan-video-bytes"), {
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-wan-output",
      mimeType: "video/mp4",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-wan",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("Wan T2V must not resolve an input reference");
      }),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [
        createWanRuntimeVendor({
          apiKey: "secret",
          workspaceId: DASHSCOPE_WORKSPACE_ID,
          fetchImpl,
        }),
      ],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-wan",
      workspaceId: "ws-wan",
      correlationId: "corr-wan-submit",
      presetId: "wan",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({ status: "processing", runtimeJobId: "wan-artifact-job" });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-wan-poll",
      presetId: "wan",
      mode: "text2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-wan-output" },
      providerObservation: { operation: "poll", outcome: "succeeded", qualityOutcome: "passed" },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
