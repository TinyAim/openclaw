import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenRuntimeFrozenPlanV2,
} from "./frozen-plan.js";
import {
  compileKlingImage2VideoV2Request,
  KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
  KLING_IMAGE2VIDEO_V2_PROFILE_DIGEST,
  KLING_IMAGE2VIDEO_V2_ROUTE_ID,
} from "./kling-image2video-v2-compiler.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import type { MediaGenRuntimeSourceSlot, MediaGenRuntimeVendorInput } from "./types.js";

const FIRST_BYTES = Buffer.from("kling-first-frame");
const LAST_BYTES = Buffer.from("kling-last-frame");

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function frameReference(
  role: "first_frame" | "last_frame",
  bytes: Buffer,
): MediaGenerationIntentReference {
  return {
    role,
    ordinal: 0,
    required: true,
    mediaClass: "image",
    source: { kind: "artifact", artifactId: `artifact-${role}` },
    assetRefId: `asset-${role}`,
    authorityRef: `artifact:${role}`,
    authorityVerified: true,
    mimeType: "image/png",
    sourceDigest: `sha256:${sha(bytes)}`,
  };
}

function frozenPlan(
  references = [
    frameReference("first_frame", FIRST_BYTES),
    frameReference("last_frame", LAST_BYTES),
  ],
): MediaGenRuntimeFrozenPlanV2 {
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project-short-drama",
      shotId: "shot-2-of-3",
      shotVersion: "R4",
      promptPackId: "prompt-pack-vertical",
      promptPackVersion: 3,
      promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: references.map((item) => item.sourceDigest!),
    },
    generationScenario: "first_last_frame_to_video" as const,
    outputAudioPolicy: "silent" as const,
    legacyMode: "image2video" as const,
    compiledPrompt: "9:16 short drama shot 2; medium tracking shot; avoid text artifacts",
    narrative: {
      visualPrompt: "A courier crosses frame and stops at a red door.",
      negativePrompt: "text artifacts",
      reservedForLater: [],
    },
    camera: { cameraPrompt: "medium tracking shot" },
    performance: {},
    look: { continuityPrompt: "same wardrobe and warm practical light" },
    references,
    output: {
      durationSec: 5,
      aspectRatio: "9:16",
      resolution: "1080p",
      shotCount: 1,
    },
    policy: { authority: "server" as const },
  };
  return {
    schemaVersion: 2,
    previewId: "preview-kling-image-v2",
    presetId: "kling",
    mode: "image2video",
    generationIntent: intent,
    generationIntentDigest: `intent:sha256:${createHash("sha256").update(stableJson(intent)).digest("hex")}`,
    generationScenario: intent.generationScenario,
    outputAudioPolicy: intent.outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: KLING_IMAGE2VIDEO_V2_ROUTE_ID,
      providerId: "kling_open_platform",
      modelId: "kling-v1",
      endpointId: "kling.v1.videos.image2video",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: "kling.openclaw-runtime.image2video.v3",
      revision: 3,
      digest: KLING_IMAGE2VIDEO_V2_PROFILE_DIGEST,
    },
    adapterRevision: KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-kling",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        providerField: "scenario",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        providerField: "output.audio",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: true,
        support: "prompt",
        providerField: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      ...references.map((reference) => ({
        intentPath: `references.${reference.role}.${reference.ordinal}`,
        sourceRef: `asset:${reference.assetRefId}`,
        sourceRevision: "R3",
        required: true,
        support: "native" as const,
        providerSlot: `references.${reference.role}`,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
      {
        intentPath: "output.durationSec",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: false,
        support: "native",
        providerField: "output.durationSec",
        reasonCode: "duration_native",
        messageKey: "media.duration_native",
      },
      {
        intentPath: "output.aspectRatio",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: false,
        support: "approximate",
        reasonCode: "output_value_profile_unknown",
        messageKey: "media.output_value_profile_unknown",
      },
      {
        intentPath: "output.resolution",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: false,
        support: "approximate",
        reasonCode: "output_value_profile_unknown",
        messageKey: "media.output_value_profile_unknown",
      },
    ],
    inputFingerprint: "2".repeat(64),
    intentFingerprint: "3".repeat(64),
  };
}

function sourceSlots(plan: MediaGenRuntimeFrozenPlanV2): MediaGenRuntimeSourceSlot[] {
  return plan.generationIntent.references.map((reference) => ({
    role: reference.role,
    ordinal: reference.ordinal,
    source: {
      bytes: reference.role === "first_frame" ? FIRST_BYTES : LAST_BYTES,
      mimeType: "image/png",
      sha256: reference.sourceDigest!.slice(7),
    },
  }));
}

function vendorInput(plan = frozenPlan()): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-kling-v2",
    presetId: "kling",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 5,
    sources: sourceSlots(plan),
    frozenPlan: plan,
  };
}

describe("Kling exact I2V create outcome uncertainty", () => {
  async function submit(status: number, body = "{}") {
    const input = vendorInput();
    expect(parseMediaGenRuntimeFrozenPlan(input.frozenPlan)).toEqual(input.frozenPlan);
    expect(compileKlingImage2VideoV2Request(input)).toMatchObject({ ok: true });
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status }),
    );
    const vendor = createKlingRuntimeVendor({
      accessKey: "test-only-access",
      secret: "test-only-secret",
      fetchImpl,
    });
    expect(vendor.capabilityRouteClaims?.some((claim) => claim.mode === "image2video")).toBe(false);
    const result = await vendor.submit(input);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    return result;
  }
  it.each([408, 500, 502, 503, 504])("HTTP%s retains an unknown create outcome", async (status) => {
    expect(await submit(status)).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      providerObservation: { operation: "submit", outcome: "submission_unknown" },
    });
  });
  it.each(["{", "null", "{}"])(
    "unreadable successful create %s requires reconciliation",
    async (body) => {
      expect(await submit(200, body)).toMatchObject({
        state: "submission_unknown",
        providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        providerObservation: { operation: "submit", outcome: "submission_unknown" },
      });
    },
  );
  it.each([
    [400, "vendor_rejected"],
    [401, "auth"],
    [403, "auth"],
    [429, "quota"],
  ] as const)("HTTP%s retains definite rejection %s", async (status, reason) => {
    expect(await submit(status)).toMatchObject({
      state: "failed",
      reason,
      providerObservation: { operation: "submit", outcome: "failed" },
    });
  });
  it("retains an explicit numeric business rejection", async () => {
    expect(
      await submit(200, JSON.stringify({ code: 1003, message: "Request rejected." })),
    ).toMatchObject({
      state: "failed",
      reason: "vendor_rejected",
      providerObservation: { operation: "submit", outcome: "failed" },
    });
  });
  it("retains a durable successful job receipt", async () => {
    expect(
      await submit(200, JSON.stringify({ code: 0, data: { task_id: "new-job" } })),
    ).toMatchObject({
      state: "processing",
      vendorJobId: "image2video-v2:new-job",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
  });
});
