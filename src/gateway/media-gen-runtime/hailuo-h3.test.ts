import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenRuntimeFrozenPlanV2,
} from "./frozen-plan.js";
import {
  compileHailuoH3Request,
  HAILUO_H3_ADAPTER_REVISION,
  HAILUO_H3_PROFILE_DIGEST,
  HAILUO_H3_ROUTE_ID,
} from "./hailuo-h3-compiler.js";
import { createHailuoH3RuntimeVendor } from "./hailuo-h3-vendor.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";
function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function reference(input: {
  role: "subject" | "voice" | "motion";
  ordinal?: number;
  bytes: Buffer;
}): MediaGenerationIntentReference {
  const mediaClass =
    input.role === "subject"
      ? ("image" as const)
      : input.role === "voice"
        ? ("audio" as const)
        : ("video" as const);
  const ordinal = input.ordinal ?? 0;
  return {
    role: input.role,
    ordinal,
    required: true,
    mediaClass,
    source: { kind: "artifact", artifactId: `artifact-${input.role}-${ordinal}` },
    assetRefId: `asset-${input.role}-${ordinal}`,
    authorityRef: `artifact:${input.role}-${ordinal}`,
    authorityVerified: true,
    mimeType:
      mediaClass === "image" ? "image/png" : mediaClass === "audio" ? "audio/mpeg" : "video/mp4",
    ...(mediaClass === "image" ? {} : { durationSec: 4 }),
    sourceDigest: `sha256:${sha(input.bytes)}`,
  };
}

function frozenPlan(refs: MediaGenerationIntentReference[]): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "Same traveler crosses a windy station, pauses, then speaks softly.";
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project-hailuo",
      shotId: "shot-hailuo",
      shotVersion: "R1",
      promptPackId: "pack-hailuo",
      promptPackVersion: 1,
      promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: refs.map((ref) => ref.sourceDigest!),
    },
    generationScenario: "multimodal_reference_to_video" as const,
    outputAudioPolicy: "reference_conditioned" as const,
    legacyMode: "image2video" as const,
    compiledPrompt: prompt,
    narrative: { visualPrompt: prompt, reservedForLater: [] },
    camera: { cameraPrompt: "Slow tracking shot." },
    performance: { actorDirection: "Pause, then speak." },
    look: {},
    references: refs,
    output: {
      durationSec: 8,
      aspectRatio: "9:16",
      resolution: "2K",
      shotCount: 1,
    },
    policy: { authority: "server" as const },
  };
  return {
    schemaVersion: 2,
    previewId: "preview-hailuo-h3",
    presetId: "hailuo",
    mode: "image2video",
    generationIntent: intent,
    generationIntentDigest: `intent:sha256:${createHash("sha256").update(stableJson(intent)).digest("hex")}`,
    generationScenario: intent.generationScenario,
    outputAudioPolicy: intent.outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: HAILUO_H3_ROUTE_ID,
      providerId: "minimax",
      modelId: "MiniMax-H3",
      endpointId: "minimax.v2.video_generation",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: "hailuo.openclaw-runtime.h3.multimodal_reference.v2",
      revision: 2,
      digest: HAILUO_H3_PROFILE_DIGEST,
    },
    adapterRevision: HAILUO_H3_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-hailuo",
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
      ...refs.map((ref) => ({
        intentPath: `references.${ref.role}.${ref.ordinal}`,
        sourceRef: `asset:${ref.assetRefId}`,
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerSlot: `references.${ref.role}`,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
      ...["output.durationSec", "output.aspectRatio", "output.resolution"].map((intentPath) => ({
        intentPath,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native" as const,
        providerField: intentPath,
        reasonCode: "output_native",
        messageKey: "media.output_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function slot(ref: MediaGenerationIntentReference, bytes: Buffer): MediaGenRuntimeSourceSlot {
  return {
    role: ref.role,
    ordinal: ref.ordinal,
    source: {
      bytes,
      mimeType: ref.mimeType!,
      sha256: sha(bytes),
    },
  };
}

function vendorInput(
  plan: MediaGenRuntimeFrozenPlanV2,
  sources: MediaGenRuntimeSourceSlot[],
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-hailuo",
    presetId: "hailuo",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 8,
    resolution: "2K",
    sources,
    frozenPlan: plan,
    ...overrides,
  };
}

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

describe("MiniMax H3 exact multimodal runtime", () => {
  const imageBytes = Buffer.from("hailuo-subject-image");
  const voiceBytes = Buffer.from("hailuo-reference-voice");

  function fixture() {
    const refs = [
      reference({ role: "subject", bytes: imageBytes }),
      reference({ role: "voice", bytes: voiceBytes }),
    ];
    const plan = frozenPlan(refs);
    const sources = [slot(refs[0], imageBytes), slot(refs[1], voiceBytes)];
    return { refs, plan, sources, input: vendorInput(plan, sources) };
  }

  it("parses and compiles the exact H3 reference body", () => {
    const { plan, input } = fixture();
    expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
    const compiled = compileHailuoH3Request(input);
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "MiniMax-H3",
        resolution: "2K",
        duration: 8,
        ratio: "9:16",
        content: [
          { type: "text" },
          { type: "image_url", role: "reference_image" },
          { type: "audio_url", role: "reference_audio" },
        ],
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(compiled)).not.toContain("runtime-hailuo");
  });

  it("rejects profile drift, raw params, unresolved digests, and audio-only input", () => {
    const { plan, sources } = fixture();
    plan.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileHailuoH3Request(vendorInput(plan, sources))).toMatchObject({ ok: false });
    const clean = fixture();
    expect(compileHailuoH3Request({ ...clean.input, params: { ratio: "1:1" } })).toMatchObject({
      ok: false,
    });
    clean.sources[0].source.sha256 = sha("different-image");
    expect(compileHailuoH3Request(clean.input)).toMatchObject({ ok: false });

    const voice = reference({ role: "voice", bytes: voiceBytes });
    const audioOnly = frozenPlan([voice]);
    expect(compileHailuoH3Request(vendorInput(audioOnly, [slot(voice, voiceBytes)]))).toMatchObject(
      { ok: false },
    );
  });

  it("normalizes create, query, queued cancel, and ambiguous submission", async () => {
    const { input } = fixture();
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "424010985738629" }));
      }
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({
            task_id: "queued-cancel",
            action: "cancel",
            status: "cancelled",
          }),
        );
      }
      if (value.endsWith("/queued-cancel")) {
        return new Response(
          JSON.stringify({
            task: {
              id: "queued-cancel",
              model: "MiniMax-H3",
              status: "queued",
            },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          task: {
            id: "424010985738629",
            model: "MiniMax-H3",
            status: "succeeded",
            content: { url: "https://cdn.example/h3.mp4" },
            resolution: "2K",
            duration: 8,
            ratio: "9:16",
          },
        }),
      );
    }) as unknown as typeof fetch;
    const vendor = createHailuoH3RuntimeVendor({ apiKey: "minimax-key", fetchImpl });
    expect(vendor.capabilityRouteClaims).toEqual([
      expect.objectContaining({
        adapterRevision: "openclaw-hailuo-h3-runtime/v2",
        route: expect.objectContaining({
          routeId: HAILUO_H3_ROUTE_ID,
          modelId: "MiniMax-H3",
          endpointId: "minimax.v2.video_generation",
        }),
      }),
    ]);
    expect(await vendor.submit(input)).toMatchObject({
      state: "processing",
      vendorJobId: "424010985738629",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    expect(await vendor.reconcile!("424010985738629")).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://cdn.example/h3.mp4", resolution: "2K" },
      providerObservation: { operation: "reconcile", outcome: "succeeded" },
    });
    await vendor.cancel!("queued-cancel");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET", "DELETE"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.minimax.io/v2/video_generation",
      "https://api.minimax.io/v2/query/video_generation/424010985738629",
      "https://api.minimax.io/v2/query/video_generation/queued-cancel",
      "https://api.minimax.io/v2/video_generation/queued-cancel",
    ]);

    const unknown = createHailuoH3RuntimeVendor({
      apiKey: "minimax-key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    });
    const result = await unknown.submit(input);
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("maps every documented non-success status and never deletes a terminal receipt as cancel", async () => {
    const statuses = new Map([
      ["job-queued", "queued"],
      ["job-running", "running"],
      ["job-cancelled", "cancelled"],
      ["job-expired", "expired"],
      ["job-succeeded", "succeeded"],
    ]);
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      const id = value.split("/").at(-1)!;
      const status = statuses.get(id)!;
      return new Response(
        JSON.stringify({
          task: {
            id,
            model: "MiniMax-H3",
            status,
            ...(status === "succeeded"
              ? {
                  content: { url: "https://cdn.example/h3.mp4" },
                  resolution: "2K",
                  duration: 8,
                }
              : {}),
          },
        }),
      );
    }) as unknown as typeof fetch;
    const vendor = createHailuoH3RuntimeVendor({ apiKey: "minimax-key", fetchImpl });

    expect(await vendor.poll("job-queued")).toMatchObject({ state: "processing" });
    expect(await vendor.poll("job-running")).toMatchObject({ state: "processing" });
    expect(await vendor.poll("job-cancelled")).toMatchObject({ state: "canceled" });
    expect(await vendor.poll("job-expired")).toMatchObject({
      state: "failed",
      reason: "vendor_failed",
    });
    await expect(vendor.cancel!("job-succeeded")).rejects.toThrow("can cancel only a queued task");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("completes moderation, quality, labeling, download, and Artifact handoff", async () => {
    const { plan } = fixture();
    const outputBytes = Buffer.from("hailuo-h3-output-video");
    const handoffArtifact = vi.fn(async ({ bytes, sha256 }: { bytes: Buffer; sha256: string }) => {
      expect(bytes).toEqual(outputBytes);
      return { artifactId: "artifact-hailuo-output", mimeType: "video/mp4", sha256 };
    });
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-hailuo",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async ({ artifactId }) =>
        artifactId.includes("subject")
          ? { bytes: imageBytes, mimeType: "image/png", sha256: sha(imageBytes) }
          : { bytes: voiceBytes, mimeType: "audio/mpeg", sha256: sha(voiceBytes) },
      ),
      handoffArtifact,
    };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "hailuo-artifact-job" }));
      }
      if (value.includes("/v2/query/")) {
        return new Response(
          JSON.stringify({
            task: {
              id: "hailuo-artifact-job",
              model: "MiniMax-H3",
              status: "succeeded",
              content: { url: "https://cdn.example/hailuo.mp4" },
              resolution: "2K",
              duration: 8,
              ratio: "9:16",
            },
          }),
        );
      }
      return new Response(outputBytes, {
        headers: { "content-type": "video/mp4", "content-length": String(outputBytes.length) },
      });
    }) as unknown as typeof fetch;
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createHailuoH3RuntimeVendor({ apiKey: "minimax-key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["cdn.example"],
      moderation: {
        screenInput: vi.fn(async () => ({ allowed: true })),
        screenOutput: vi.fn(async () => ({ allowed: true })),
      },
      labeler: { applyLabel: vi.fn(async (output) => ({ ...output, applied: true })) },
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-hailuo",
      workspaceId: "ws-hailuo",
      correlationId: "corr-hailuo-submit",
      presetId: "hailuo",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 8,
      resolution: "2K",
      references: [
        { kind: "artifact", artifactId: "artifact-subject-0", role: "subject", ordinal: 0 },
        { kind: "artifact", artifactId: "artifact-voice-0", role: "voice", ordinal: 0 },
      ],
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({ status: "processing", runtimeJobId: "hailuo-artifact-job" });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-hailuo-poll",
      presetId: "hailuo",
      mode: "image2video",
      runtimeJobId: "hailuo-artifact-job",
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-hailuo-output" },
      providerObservation: { operation: "poll", outcome: "succeeded", qualityOutcome: "passed" },
      snapshot: {
        executionOwner: "user_runtime",
        moderationStatus: "runtime_enforced",
        labelingStatus: "runtime_applied",
      },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
