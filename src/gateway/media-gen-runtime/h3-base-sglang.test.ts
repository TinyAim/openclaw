import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenerationScenario,
  type MediaGenRuntimeFrozenPlanV2,
} from "./frozen-plan.js";
import {
  compileH3BaseSglangRequest,
  type H3BaseSglangProfilePin,
} from "./h3-base-sglang-compiler.js";
import {
  H3_BASE_FL2VA_ADAPTER_REVISION,
  H3_BASE_FL2VA_ROUTE_ID,
  H3_BASE_REF2VA_ADAPTER_REVISION,
  H3_BASE_REF2VA_ROUTE_ID,
  H3_BASE_SGLANG_SCHEMA_REVISION,
  createH3BaseSglangRuntimeVendor,
  normalizeH3BaseSglangBaseUrl,
  normalizeH3BaseStagingDir,
} from "./h3-base-sglang-vendor.js";
import type { MediaGenRuntimeSourceSlot, MediaGenRuntimeVendorInput } from "./types.js";

const CHECKPOINT_DIGEST = `sha256:${"9".repeat(64)}`;
const PROFILE_DIGEST = `sha256:${"8".repeat(64)}`;

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function reference(input: {
  role: "first_frame" | "last_frame" | "subject" | "motion" | "voice";
  ordinal?: number;
  bytes: Buffer;
}): MediaGenerationIntentReference {
  const mediaClass = input.role === "voice" ? "audio" : input.role === "motion" ? "video" : "image";
  const ordinal = input.ordinal ?? 0;
  return {
    role: input.role,
    ordinal,
    required: true,
    mediaClass,
    source: { kind: "artifact", artifactId: `artifact-${input.role}-${ordinal}` },
    authorityVerified: true,
    mimeType:
      mediaClass === "audio" ? "audio/mpeg" : mediaClass === "video" ? "video/mp4" : "image/png",
    ...(mediaClass === "audio" || mediaClass === "video" ? { durationSec: 4 } : {}),
    sourceDigest: `sha256:${sha(input.bytes)}`,
  };
}

function profilePin(profileId: string): H3BaseSglangProfilePin {
  return { profileId, revision: 1, digest: PROFILE_DIGEST };
}

function frozenPlan(input: {
  scenario: MediaGenerationScenario;
  refs?: MediaGenerationIntentReference[];
  variant: "fl2va" | "ref2va";
}): MediaGenRuntimeFrozenPlanV2 {
  const refs = input.refs ?? [];
  const prompt = "A quiet cinematic moment with spatial audio.";
  const mode = input.scenario === "text_to_video" ? "text2video" : "image2video";
  const outputAudioPolicy =
    input.variant === "ref2va" ? "reference_conditioned" : "native_generate";
  const profileId = `test.h3-base.${input.variant}.${input.scenario}.v1`;
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project-h3-base",
      shotId: "shot-h3-base",
      shotVersion: "R1",
      promptPackId: "pack-h3-base",
      promptPackVersion: 1,
      promptPackUpdatedAt: "2026-08-10T00:00:00.000Z",
      promptPackDigest: `sha256:${"7".repeat(64)}`,
      sourceDigests: refs.map((ref) => ref.sourceDigest!),
    },
    generationScenario: input.scenario,
    outputAudioPolicy,
    legacyMode: mode,
    compiledPrompt: prompt,
    narrative: { visualPrompt: prompt, reservedForLater: [] },
    camera: {},
    performance: {},
    look: {},
    references: refs,
    output: {
      durationSec: 8,
      aspectRatio: "16:9",
      resolution: "768-short-edge",
      fps: 24,
      shotCount: 1,
    },
    policy: { authority: "server" as const },
  };
  return {
    schemaVersion: 2,
    previewId: `preview-${input.variant}`,
    presetId: "hailuo",
    mode,
    generationIntent: intent,
    generationIntentDigest: `intent:sha256:${createHash("sha256").update(stableJson(intent)).digest("hex")}`,
    generationScenario: input.scenario,
    outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: input.variant === "fl2va" ? H3_BASE_FL2VA_ROUTE_ID : H3_BASE_REF2VA_ROUTE_ID,
      providerId: "minimax_open_weights",
      modelId: "MiniMax-H3-Base",
      endpointId: "sglang.video.v1",
      region: "runtime_local",
      accountTier: "local_weights",
    },
    capabilityProfileRef: profilePin(profileId),
    adapterRevision:
      input.variant === "fl2va" ? H3_BASE_FL2VA_ADAPTER_REVISION : H3_BASE_REF2VA_ADAPTER_REVISION,
    executionTopology: "self_hosted",
    servingProtocol: "sglang_video_v1",
    licensePolicyRef: {
      policyId: "minimax.h3-community.test",
      revision: 1,
      digest: `sha256:${"6".repeat(64)}`,
    },
    dataEgress: { mode: "none" },
    checkpointDigest: CHECKPOINT_DIGEST,
    runtimeRef: {
      runtimeId: "runtime-h3-base",
      lastSeenAt: "2026-08-10T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: true,
        support: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      ...refs.map((ref) => ({
        intentPath: `references.${ref.role}.${ref.ordinal}`,
        sourceRef: `artifact:${ref.role}:${ref.ordinal}`,
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerSlot: `conditions.${ref.ordinal}`,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
    ],
    inputFingerprint: "4".repeat(64),
    intentFingerprint: "5".repeat(64),
  };
}

function slots(
  refs: readonly MediaGenerationIntentReference[],
  bytesByRole: Readonly<Record<string, Buffer>>,
): MediaGenRuntimeSourceSlot[] {
  return refs.map((ref) => ({
    role: ref.role,
    ordinal: ref.ordinal,
    source: {
      bytes: bytesByRole[ref.role]!,
      mimeType: ref.mimeType!,
      // The Artifact bridge emits bare hex; the compiler must normalize it.
      sha256: sha(bytesByRole[ref.role]!),
    },
  }));
}

function vendorInput(
  plan: MediaGenRuntimeFrozenPlanV2,
  sources: MediaGenRuntimeSourceSlot[] = [],
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-h3-base",
    presetId: "hailuo",
    mode: plan.mode,
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 8,
    resolution: "768-short-edge",
    params: {},
    sources,
    frozenPlan: plan,
  };
}

function compileOptions(plan: MediaGenRuntimeFrozenPlanV2, variant: "fl2va" | "ref2va") {
  return {
    variant,
    routeId: plan.providerRouteRef.routeId,
    adapterRevision: plan.adapterRevision,
    profilesByScenario: {
      [plan.generationScenario]: plan.capabilityProfileRef,
    },
    checkpointDigest: CHECKPOINT_DIGEST,
    materialize: async ({ index }: { index: number }) => `file:///tmp/h3-ref-${index}.bin`,
  };
}

describe("self-hosted MiniMax H3 Base SGLang runtime", () => {
  it("accepts only a co-located loopback endpoint", () => {
    expect(normalizeH3BaseSglangBaseUrl("http://127.0.0.1:30000")).toBe("http://127.0.0.1:30000");
    expect(normalizeH3BaseSglangBaseUrl("https://localhost:30000")).toBe("https://localhost:30000");
    expect(normalizeH3BaseSglangBaseUrl("https://192.168.1.7:30000", "token")).toBeNull();
    expect(normalizeH3BaseSglangBaseUrl("http://192.168.1.7:30000", "token")).toBeNull();
    expect(normalizeH3BaseSglangBaseUrl("https://sglang.example.com", "token")).toBeNull();
    expect(normalizeH3BaseSglangBaseUrl("http://127.0.0.1:30000/v1")).toBeNull();
    expect(normalizeH3BaseStagingDir("/tmp/wisclaw-h3")).toBe("/tmp/wisclaw-h3");
    expect(normalizeH3BaseStagingDir("/tmp/wisclaw/../other")).toBeNull();
    expect(normalizeH3BaseStagingDir(path.parse(tmpdir()).root)).toBeNull();
  });

  it("compiles exact first+last keyframes and preserves ordered Ref2VA conditions", async () => {
    const firstBytes = Buffer.from("h3-first-frame");
    const lastBytes = Buffer.from("h3-last-frame");
    const flRefs = [
      reference({ role: "first_frame", bytes: firstBytes }),
      reference({ role: "last_frame", bytes: lastBytes }),
    ];
    const flPlan = frozenPlan({
      scenario: "first_last_frame_to_video",
      refs: flRefs,
      variant: "fl2va",
    });
    expect(parseMediaGenRuntimeFrozenPlan(flPlan)).toEqual(flPlan);
    const flCompiled = await compileH3BaseSglangRequest(
      vendorInput(
        flPlan,
        slots(flRefs, { first_frame: firstBytes, last_frame: lastBytes }).reverse(),
      ),
      compileOptions(flPlan, "fl2va"),
    );
    expect(flCompiled).toMatchObject({
      ok: true,
      body: {
        task: "fl2va",
        conditions: [
          { type: "image", role: "keyframe", frame_index: 0 },
          { type: "image", role: "keyframe", frame_index: -1 },
        ],
        target: { short_edge: 768, duration_seconds: 8 },
      },
    });

    const subjectBytes = Buffer.from("h3-subject");
    const voiceBytes = Buffer.from("h3-voice");
    const refRefs = [
      reference({ role: "subject", bytes: subjectBytes }),
      reference({ role: "voice", bytes: voiceBytes }),
    ];
    const refPlan = frozenPlan({
      scenario: "multimodal_reference_to_video",
      refs: refRefs,
      variant: "ref2va",
    });
    const refCompiled = await compileH3BaseSglangRequest(
      vendorInput(refPlan, slots(refRefs, { subject: subjectBytes, voice: voiceBytes }).reverse()),
      compileOptions(refPlan, "ref2va"),
    );
    expect(refCompiled).toMatchObject({
      ok: true,
      body: {
        task: "ref2va",
        seed: 42,
        quality: "lossless",
        conditions: [
          { type: "image", role: "reference" },
          { type: "audio", role: "reference" },
        ],
      },
    });

    const voiceOnlyPlan = frozenPlan({
      scenario: "multimodal_reference_to_video",
      refs: [reference({ role: "voice", bytes: voiceBytes })],
      variant: "ref2va",
    });
    await expect(
      compileH3BaseSglangRequest(
        vendorInput(
          voiceOnlyPlan,
          slots(voiceOnlyPlan.generationIntent.references, { voice: voiceBytes }),
        ),
        compileOptions(voiceOnlyPlan, "ref2va"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("require at least one image or video"),
    });
    const fiveRefs = Array.from({ length: 5 }, (_, ordinal) =>
      reference({ role: "subject", ordinal, bytes: subjectBytes }),
    );
    const overBoundPlan = frozenPlan({
      scenario: "multimodal_reference_to_video",
      refs: fiveRefs,
      variant: "ref2va",
    });
    await expect(
      compileH3BaseSglangRequest(
        vendorInput(overBoundPlan, slots(fiveRefs, { subject: subjectBytes })),
        compileOptions(overBoundPlan, "ref2va"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("between one and four"),
    });
  });

  it("submits, polls local content, reports model identity, and does not advertise fake cancel", async () => {
    const plan = frozenPlan({ scenario: "text_to_video", variant: "fl2va" });
    const calls: Array<{ url: string; method?: string; headers?: HeadersInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: value, method: init?.method, headers: init?.headers });
      if (value.endsWith("/health")) {
        return new Response(null, { status: 200 });
      }
      if (value.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "MiniMaxAI/MiniMax-H3" }] }));
      }
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "h3-job-1",
            model: "MiniMaxAI/MiniMax-H3",
            status: "queued",
          }),
        );
      }
      return new Response(
        JSON.stringify({
          id: "h3-job-1",
          model: "MiniMaxAI/MiniMax-H3",
          status: "completed",
          seconds: 8,
        }),
      );
    }) as unknown as typeof fetch;
    const stagingDir = await mkdtemp(path.join(tmpdir(), "wisclaw-h3-test-"));
    try {
      const vendor = createH3BaseSglangRuntimeVendor({
        variant: "fl2va",
        baseUrl: "http://127.0.0.1:30000",
        authToken: "runtime-secret",
        servingEngineVersion: H3_BASE_SGLANG_SCHEMA_REVISION,
        checkpointRevision: "minimax-h3-base-test",
        checkpointDigest: CHECKPOINT_DIGEST,
        status: "ready",
        maxConcurrentJobs: 1,
        profilesByScenario: {
          text_to_video: plan.capabilityProfileRef,
        },
        stagingDir,
        fetchImpl,
      });
      expect(vendor.isConfigured()).toBe(true);
      expect(vendor.cancel).toBeUndefined();
      expect(vendor.trustedOutputHosts).toEqual(["127.0.0.1"]);
      expect(vendor.capabilityRouteClaims).toBeUndefined();
      expect(vendor.modelServingClaims).toEqual([
        expect.objectContaining({
          modelId: "MiniMax-H3-Base",
          variant: "fl2va",
          servingEngine: "sglang",
          servingProtocol: "sglang_video_v1",
          status: "ready",
        }),
      ]);
      await expect(vendor.registrationSnapshot?.()).resolves.toMatchObject({
        capabilityRouteClaims: expect.arrayContaining([
          expect.objectContaining({
            route: expect.objectContaining({ routeId: H3_BASE_FL2VA_ROUTE_ID }),
          }),
        ]),
        modelServingClaims: [expect.objectContaining({ status: "ready" })],
      });

      await expect(vendor.submit(vendorInput(plan))).resolves.toMatchObject({
        state: "processing",
        vendorJobId: "h3-job-1",
        providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      await expect(vendor.poll("h3-job-1")).resolves.toMatchObject({
        state: "succeeded",
        output: {
          mediaRef: "http://127.0.0.1:30000/v1/videos/h3-job-1/content",
          mimeType: "video/mp4",
          contentHeaders: { authorization: "Bearer runtime-secret" },
          allowInsecureLoopback: true,
        },
      });
      expect(calls.map((call) => [call.method, call.url])).toEqual([
        ["GET", "http://127.0.0.1:30000/health"],
        ["GET", "http://127.0.0.1:30000/v1/models"],
        ["POST", "http://127.0.0.1:30000/v1/videos"],
        ["GET", "http://127.0.0.1:30000/v1/videos/h3-job-1"],
      ]);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  it("withdraws route claims when the live server exposes the wrong model", async () => {
    const plan = frozenPlan({ scenario: "text_to_video", variant: "fl2va" });
    const vendor = createH3BaseSglangRuntimeVendor({
      variant: "fl2va",
      baseUrl: "http://127.0.0.1:30000",
      servingEngineVersion: H3_BASE_SGLANG_SCHEMA_REVISION,
      checkpointRevision: "minimax-h3-base-test",
      checkpointDigest: CHECKPOINT_DIGEST,
      status: "ready",
      profilesByScenario: { text_to_video: plan.capabilityProfileRef },
      stagingDir: "/tmp/wisclaw-h3-probe-test",
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        const value = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        return value.endsWith("/health")
          ? new Response(null, { status: 200 })
          : new Response(JSON.stringify({ data: [{ id: "another-model" }] }));
      }) as unknown as typeof fetch,
    });

    await expect(vendor.registrationSnapshot?.()).resolves.toEqual({
      modelServingClaims: [expect.objectContaining({ status: "error" })],
    });
  });

  it("rejects an existing permissive staging directory without mutating it", async () => {
    const plan = frozenPlan({ scenario: "text_to_video", variant: "fl2va" });
    const stagingDir = await mkdtemp(path.join(tmpdir(), "wisclaw-h3-open-test-"));
    try {
      await chmod(stagingDir, 0o755);
      const vendor = createH3BaseSglangRuntimeVendor({
        variant: "fl2va",
        baseUrl: "http://127.0.0.1:30000",
        servingEngineVersion: H3_BASE_SGLANG_SCHEMA_REVISION,
        checkpointRevision: "minimax-h3-base-test",
        checkpointDigest: CHECKPOINT_DIGEST,
        status: "ready",
        profilesByScenario: { text_to_video: plan.capabilityProfileRef },
        stagingDir,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      });

      await expect(vendor.submit(vendorInput(plan))).resolves.toMatchObject({
        state: "failed",
        reason: "vendor_rejected",
      });
      expect((await stat(stagingDir)).mode & 0o077).toBe(0o055);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  });
});
