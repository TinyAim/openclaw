import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";
import { createVeoRuntimeVendor } from "./veo-vendor.js";
import {
  compileVeo31T2vRequest,
  VEO31_T2V_ADAPTER_REVISION,
  VEO31_T2V_PROFILE_DIGEST,
  VEO31_T2V_ROUTE_ID,
} from "./veo3-1-t2v-compiler.js";

const PROJECT = "wisclaw-veo-test";
const OPERATION_PREFIX =
  `projects/${PROJECT}/locations/us-central1/publishers/google/models/` +
  "veo-3.1-generate-001/operations/";

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
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A paper boat crosses a rain-filled street at dusk.";
  return {
    schemaVersion: 2,
    previewId: "preview-veo",
    presetId: "veo",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-veo",
        shotId: "shot-veo",
        shotVersion: "R1",
        promptPackId: "pack-veo",
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
      camera: { cameraPrompt: "Low tracking shot beside the boat." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 6,
        aspectRatio: overrides.aspectRatio ?? "9:16",
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
      routeId: VEO31_T2V_ROUTE_ID,
      providerId: "google_vertex_ai",
      modelId: "veo-3.1-generate-001",
      endpointId: "aiplatform.v1.predictLongRunning",
      region: "us-central1",
      accountTier: "adc",
    },
    capabilityProfileRef: {
      profileId: "veo.openclaw-runtime.veo3_1_generate_001.text2video.v2",
      revision: 2,
      digest: VEO31_T2V_PROFILE_DIGEST,
    },
    adapterRevision: VEO31_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-veo", lastSeenAt: "2026-07-31T00:00:00.000Z" },
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
      ...["output.durationSec", "output.aspectRatio", "output.resolution", "output.fps"].map(
        (intentPath) => ({
          intentPath,
          sourceRef: "pack:R1",
          sourceRevision: "R1",
          required: false,
          support: "native" as const,
          providerField: intentPath,
          reasonCode: "output_value_native",
          messageKey: "media.output_value_native",
        }),
      ),
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
    taskId: "task-veo",
    presetId: "veo",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    frozenPlan: plan,
    ...overrides,
  };
}

function vendor(fetchImpl: typeof fetch, maxOutputBytes?: number) {
  return createVeoRuntimeVendor({
    projectId: PROJECT,
    accessTokenProvider: vi.fn(async () => "adc-token"),
    fetchImpl,
    maxOutputBytes,
  });
}

describe("Veo 3.1 exact Text-to-Video runtime", () => {
  it("compiles and submits the frozen GA Vertex AI request", async () => {
    const compiled = compileVeo31T2vRequest(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        instances: [{ prompt: expect.any(String) }],
        parameters: {
          aspectRatio: "9:16",
          durationSeconds: 6,
          enhancePrompt: true,
          generateAudio: false,
          personGeneration: "allow_adult",
          resolution: "1080p",
          sampleCount: 1,
        },
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      return new Response(JSON.stringify({ name: `${OPERATION_PREFIX}operation-1` }));
    }) as unknown as typeof fetch;
    const runtimeVendor = vendor(fetchImpl);
    expect(runtimeVendor.capabilityRouteClaims).toEqual([
      expect.objectContaining({
        mode: "text2video",
        route: expect.objectContaining({ routeId: VEO31_T2V_ROUTE_ID }),
        adapterRevision: VEO31_T2V_ADAPTER_REVISION,
      }),
    ]);
    expect(runtimeVendor.supportsMultiReference).toBe(true);
    expect(await runtimeVendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: "operation-1",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    expect(calls[0]?.url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/" +
        "projects/wisclaw-veo-test/locations/us-central1/publishers/google/models/" +
        "veo-3.1-generate-001:predictLongRunning",
    );
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer adc-token" });
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("missing Veo request body");
    }
    expect(JSON.parse(requestBody)).toEqual(compiled.ok ? compiled.body : undefined);
  });

  it("rejects profile drift, raw params, references, and unsupported output values", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileVeo31T2vRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileVeo31T2vRequest(vendorInput(frozenPlan(), { params: { sampleCount: 4 } })),
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
    expect(compileVeo31T2vRequest(vendorInput(referenced))).toMatchObject({ ok: false });
    expect(compileVeo31T2vRequest(vendorInput(frozenPlan({ durationSec: 5 })))).toMatchObject({
      ok: false,
    });
    expect(
      compileVeo31T2vRequest(
        vendorInput(frozenPlan({ aspectRatio: "1:1", resolution: "4k", fps: 30 })),
      ),
    ).toMatchObject({ ok: false });
  });

  it("distinguishes local ADC failure from an ambiguous provider submission", async () => {
    const authFailure = createVeoRuntimeVendor({
      projectId: PROJECT,
      accessTokenProvider: vi.fn(async () => {
        throw new Error("private credential path");
      }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const rejected = await authFailure.submit(vendorInput());
    expect(rejected).toMatchObject({
      state: "failed",
      reason: "auth",
      providerObservation: { operation: "submit", outcome: "failed" },
    });
    expect(JSON.stringify(rejected)).not.toContain("private credential path");

    const ambiguous = vendor(
      vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    );
    const result = await ambiguous.submit(vendorInput());
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: VEO31_T2V_ROUTE_ID,
        adapterRevision: VEO31_T2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("normalizes operation lifecycle and keeps unsupported remote cancel unclaimed", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new Error("missing Veo poll body");
      }
      const body = JSON.parse(requestBody) as { operationName: string };
      calls.push({ url: requestUrl(url), body });
      const id = body.operationName.split("/").at(-1);
      if (id === "pending") {
        return new Response(JSON.stringify({ name: body.operationName, done: false }));
      }
      if (id === "canceled") {
        return new Response(
          JSON.stringify({
            name: body.operationName,
            done: true,
            error: { code: 1, status: "CANCELLED" },
          }),
        );
      }
      if (id === "filtered") {
        return new Response(
          JSON.stringify({
            name: body.operationName,
            done: true,
            response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["policy"] },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          name: body.operationName,
          done: true,
          response: {
            raiMediaFilteredCount: 0,
            videos: [
              {
                bytesBase64Encoded: Buffer.from("veo-video").toString("base64"),
                mimeType: "video/mp4",
              },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const runtimeVendor = vendor(fetchImpl);

    expect(await runtimeVendor.poll("pending")).toMatchObject({ state: "processing" });
    expect(await runtimeVendor.poll("canceled")).toMatchObject({ state: "canceled" });
    expect(await runtimeVendor.reconcile!("filtered")).toMatchObject({
      state: "failed",
      reason: "content_blocked",
      providerObservation: { operation: "reconcile", outcome: "failed" },
    });
    expect(await runtimeVendor.poll("complete")).toMatchObject({
      state: "succeeded",
      output: {
        mediaRef: `data:video/mp4;base64,${Buffer.from("veo-video").toString("base64")}`,
        mimeType: "video/mp4",
      },
    });
    expect("cancel" in runtimeVendor).toBe(false);
    expect(calls[0]?.body).toEqual({ operationName: `${OPERATION_PREFIX}pending` });
  });

  it("reconciles before returning not-supported cancel with zero Artifact handoff", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: `${OPERATION_PREFIX}still-processing`,
            done: false,
          }),
        ),
    ) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async () => {
      throw new Error("Veo cancel must not hand off an Artifact");
    });
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-veo",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("Veo T2V cancel must not resolve an input reference");
      }),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor(fetchImpl)],
      fetchImpl,
    });

    await expect(
      executor.dispatch({
        op: "cancel",
        taskId: "task-veo-cancel",
        workspaceId: "ws-veo",
        correlationId: "corr-veo-cancel",
        presetId: "veo",
        mode: "text2video",
        runtimeJobId: "still-processing",
      }),
    ).resolves.toMatchObject({
      status: "canceled",
      runtimeJobId: "still-processing",
      runtimeStopOutcome: {
        state: "not_supported",
        reasonCode: "adapter_not_supported",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(handoffArtifact).not.toHaveBeenCalled();
  });

  it("bounds inline output and completes compliance, quality, and Artifact handoff", async () => {
    const outputBytes = Buffer.from("veo-inline-video-bytes");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const value = requestUrl(url);
      if (value.endsWith(":predictLongRunning")) {
        return new Response(JSON.stringify({ name: `${OPERATION_PREFIX}artifact-job` }));
      }
      return new Response(
        JSON.stringify({
          name: `${OPERATION_PREFIX}artifact-job`,
          done: true,
          response: {
            raiMediaFilteredCount: 0,
            videos: [
              {
                bytesBase64Encoded: outputBytes.toString("base64"),
                mimeType: "video/mp4",
              },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ bytes, sha256 }: { bytes: Buffer; sha256: string }) => {
      expect(bytes).toEqual(outputBytes);
      return { artifactId: "artifact-veo-output", mimeType: "video/mp4", sha256 };
    });
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-veo",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("Veo T2V must not resolve an input reference");
      }),
      handoffArtifact,
    };
    const screenOutput = vi.fn(async (input: { mediaRef: string }) => {
      expect(input.mediaRef).toMatch(/^data:video\/mp4;base64,/u);
      return { allowed: true };
    });
    const validateMediaBytes = vi.fn(async ({ bytes }: { bytes: Buffer }) => {
      expect(bytes).toEqual(outputBytes);
      return { ok: true as const };
    });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor(fetchImpl, 1024)],
      fetchImpl,
      moderation: {
        screenInput: vi.fn(async () => ({ allowed: true })),
        screenOutput,
      },
      labeler: { applyLabel: vi.fn(async (output) => ({ ...output, applied: true })) },
      validateMediaBytes,
      maxMediaBytes: 1024,
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-veo",
      workspaceId: "ws-veo",
      correlationId: "corr-veo-submit",
      presetId: "veo",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 6,
      resolution: "1080p",
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({ status: "processing", runtimeJobId: "artifact-job" });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-veo-poll",
      presetId: "veo",
      mode: "text2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-veo-output" },
      providerObservation: { operation: "poll", outcome: "succeeded", qualityOutcome: "passed" },
      snapshot: { moderationStatus: "runtime_enforced", labelingStatus: "runtime_applied" },
    });
    expect(screenOutput).toHaveBeenCalledTimes(1);
    expect(validateMediaBytes).toHaveBeenCalledTimes(1);
    expect(handoffArtifact).toHaveBeenCalledTimes(1);

    const tooSmall = vendor(fetchImpl, 4);
    expect(await tooSmall.poll("artifact-job")).toMatchObject({
      state: "failed",
      reason: "download_failed",
    });
  });
});
