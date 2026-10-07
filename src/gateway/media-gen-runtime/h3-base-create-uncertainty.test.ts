import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenerationScenario,
  type MediaGenRuntimeFrozenPlanV2,
} from "./frozen-plan.js";
import { type H3BaseSglangProfilePin } from "./h3-base-sglang-compiler.js";
import {
  H3_BASE_FL2VA_ADAPTER_REVISION,
  H3_BASE_FL2VA_ROUTE_ID,
  H3_BASE_REF2VA_ADAPTER_REVISION,
  H3_BASE_REF2VA_ROUTE_ID,
  H3_BASE_SGLANG_SCHEMA_REVISION,
  createH3BaseSglangRuntimeVendor,
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
  const mode: MediaGenRuntimeFrozenPlanV2["mode"] =
    input.scenario === "text_to_video" ? "text2video" : "image2video";
  const outputAudioPolicy: MediaGenRuntimeFrozenPlanV2["outputAudioPolicy"] =
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

describe("H3Base create uncertainty preserves local reference inputs", () => {
  async function submit(status: number | "transportFailure", expected: "unknown" | "rejected") {
    const first = Buffer.from("h3-first-frame");
    const last = Buffer.from("h3-last-frame");
    const refs = [
      reference({ role: "first_frame", bytes: first }),
      reference({ role: "last_frame", bytes: last }),
    ];
    const plan = frozenPlan({ variant: "fl2va", scenario: "first_last_frame_to_video", refs });
    expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
    const stagingDir = await mkdtemp(path.join(tmpdir(), "wisclaw-h3-create-"));
    const stagedPaths: string[] = [];
    try {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as { conditions: { uri: string }[] };
        expect(body.conditions).toHaveLength(2);
        for (const [index, condition] of body.conditions.entries()) {
          const file = fileURLToPath(condition.uri);
          stagedPaths.push(file);
          expect(path.dirname(file)).toBe(stagingDir);
          expect(await readFile(file)).toEqual(index === 0 ? first : last);
          expect((await stat(file)).mode & 0o777).toBe(0o600);
        }
        if (status === "transportFailure") throw new Error("test lost create receipt");
        return new Response("{}", { status });
      });
      const vendor = createH3BaseSglangRuntimeVendor({
        variant: "fl2va",
        baseUrl: "http://127.0.0.1:30000",
        servingEngineVersion: H3_BASE_SGLANG_SCHEMA_REVISION,
        checkpointRevision: "test-checkpoint",
        checkpointDigest: CHECKPOINT_DIGEST,
        status: "ready",
        maxConcurrentJobs: 1,
        profilesByScenario: { first_last_frame_to_video: plan.capabilityProfileRef },
        stagingDir,
        fetchImpl,
      });
      expect(vendor.capabilityRouteClaims).toBeUndefined();
      const result = await vendor.submit(
        vendorInput(plan, slots(refs, { first_frame: first, last_frame: last })),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stagedPaths).toHaveLength(2);
      if (expected === "unknown") {
        expect
          .soft(result)
          .toMatchObject({
            state: "submission_unknown",
            providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            providerObservation: { operation: "submit", outcome: "submission_unknown" },
          });
        expect.soft(await readdir(stagingDir)).toHaveLength(2);
        await expect(readFile(stagedPaths[0]!)).resolves.toEqual(first);
        await expect(readFile(stagedPaths[1]!)).resolves.toEqual(last);
      } else {
        expect(result).toMatchObject({
          state: "failed",
          providerObservation: { operation: "submit", outcome: "failed" },
        });
        expect(await readdir(stagingDir)).toEqual([]);
      }
      return result;
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
  it.each([408, 500, 502, 503, 504])(
    "HTTP%s cannot delete possibly accepted job inputs",
    async (status) => {
      await submit(status, "unknown");
    },
  );
  it("keeps the existing lost transport receipt behavior", async () => {
    await submit("transportFailure", "unknown");
  });
  it.each([400, 401, 403, 429])(
    "HTTP%s still cleans definitely rejected inputs",
    async (status) => {
      await submit(status, "rejected");
    },
  );
});
