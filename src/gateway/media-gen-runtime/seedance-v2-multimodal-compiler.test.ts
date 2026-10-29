import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenerationIntentV2,
  type MediaGenerationScenario,
  type MediaGenRuntimeFrozenPlanV2,
  type MediaOutputAudioPolicy,
} from "./frozen-plan.js";
import { compileSeedanceV2Request, SEEDANCE_V2_PROFILE_DIGESTS } from "./seedance-v2-compiler.js";
import type {
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
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

function reference(input: {
  role: MediaGenerationIntentReference["role"];
  ordinal?: number;
  mediaClass: MediaGenerationIntentReference["mediaClass"];
  durationSec?: number;
  kind?: MediaGenerationIntentReference["source"]["kind"];
  mimeType?: string;
}): MediaGenerationIntentReference {
  const ordinal = input.ordinal ?? 0;
  const digest = sha(`${input.role}-${ordinal}`);
  const kind = input.kind ?? (input.mediaClass === "video" ? "runtime_local" : "artifact");
  return {
    role: input.role,
    ordinal,
    required: true,
    mediaClass: input.mediaClass,
    source:
      kind === "runtime_local"
        ? {
            kind,
            runtimeLocalRef: `local-${input.role}-${ordinal}`,
            companionArtifactId: `artifact-${input.role}-${ordinal}`,
          }
        : { kind, artifactId: `artifact-${input.role}-${ordinal}` },
    authorityVerified: true,
    mimeType:
      input.mimeType ??
      (input.mediaClass === "image"
        ? "image/png"
        : input.mediaClass === "audio"
          ? "audio/wav"
          : "video/mp4"),
    ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
    sourceDigest: `sha256:${digest}`,
  };
}

function plan(
  references: MediaGenerationIntentReference[],
  options: {
    scenario?: MediaGenerationScenario;
    audio?: MediaOutputAudioPolicy;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const scenario = options.scenario ?? "multimodal_reference_to_video";
  const audio =
    options.audio ??
    (references.some((item) => item.role === "voice")
      ? "reference_conditioned"
      : "native_generate");
  const intent: MediaGenerationIntentV2 = {
    schemaVersion: 2,
    identity: {
      projectId: "project-seedance-v4",
      shotId: "shot-seedance-v4",
      shotVersion: "R4",
      promptPackId: "prompt-pack-seedance-v4",
      promptPackVersion: 4,
      promptPackUpdatedAt: "2026-08-02T00:00:00.000Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: references.map((item) => item.sourceDigest!),
    },
    generationScenario: scenario,
    outputAudioPolicy: audio,
    legacyMode: "image2video",
    compiledPrompt: "Use every frozen typed reference without truncation.",
    narrative: { visualPrompt: "One bounded multimodal shot.", reservedForLater: [] },
    camera: {},
    performance: {},
    look: {},
    references,
    output: {
      durationSec: 6,
      aspectRatio: "9:16",
      resolution: "1080p",
      shotCount: 1,
    },
    policy: { authority: "server" },
  };
  return {
    schemaVersion: 2,
    previewId: "preview-seedance-v4",
    presetId: "seedance",
    mode: "image2video",
    generationIntent: intent,
    generationIntentDigest: `intent:sha256:${sha(stableJson(intent))}`,
    generationScenario: scenario,
    outputAudioPolicy: audio,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: "volcengine.ark.seedance2.multimodal",
      providerId: "volcengine_ark",
      modelId: "doubao-seedance-2-0-260128",
      endpointId: "ark.v3.contents.generations.tasks",
      region: "cn-beijing",
      accountTier: "online",
    },
    capabilityProfileRef: {
      profileId: "seedance.openclaw-runtime.multimodal.v5",
      revision: 5,
      digest: SEEDANCE_V2_PROFILE_DIGESTS.image2video,
    },
    adapterRevision: "openclaw-seedance-runtime/v2",
    runtimeRef: {
      runtimeId: "runtime-seedance-v4",
      lastSeenAt: "2026-08-02T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "prompt-pack:R4",
        sourceRevision: "R4",
        required: true,
        support: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      ...references.map((item) => ({
        intentPath: `references.${item.role}.${item.ordinal}`,
        sourceRef: `reference:${item.role}:${item.ordinal}`,
        sourceRevision: item.sourceDigest!,
        required: true,
        support: "native" as const,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceFor(ref: MediaGenerationIntentReference): MediaGenRuntimeSource {
  const value = `${ref.role}-${ref.ordinal}`;
  if (ref.mediaClass === "video") {
    return {
      providerRef: `asset://seedance/${value}.mp4`,
      mimeType: ref.mimeType!,
      sha256: sha(value),
    };
  }
  return {
    bytes: Buffer.from(value),
    mimeType: ref.mimeType!,
    sha256: sha(value),
  };
}

function slot(
  ref: MediaGenerationIntentReference,
  source = sourceFor(ref),
): MediaGenRuntimeSourceSlot {
  return { role: ref.role, ordinal: ref.ordinal, source };
}

function vendorInput(
  frozenPlan: MediaGenRuntimeFrozenPlanV2,
  sources = frozenPlan.generationIntent.references.map((ref) => slot(ref)),
  params: Record<string, unknown> = { ratio: "9:16" },
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-seedance-v4",
    presetId: "seedance",
    mode: "image2video",
    prompt: frozenPlan.generationIntent.compiledPrompt,
    durationSec: 6,
    resolution: "1080p",
    params,
    sources,
    frozenPlan,
  };
}

function compile(
  references: MediaGenerationIntentReference[],
  options: Parameters<typeof plan>[1] = {},
) {
  const frozenPlan = plan(references, options);
  return compileSeedanceV2Request(vendorInput(frozenPlan));
}

describe("Seedance V2 active multimodal V5 compiler", () => {
  it("mirrors typed duration parsing while preserving duration-less historical receipts", () => {
    const subject = reference({ role: "subject", mediaClass: "image" });
    const video = reference({ role: "motion", mediaClass: "video", durationSec: 2.5 });
    const audio = reference({ role: "voice", mediaClass: "audio", durationSec: 3 });
    expect(parseMediaGenRuntimeFrozenPlan(plan([subject, video, audio]))).not.toBeNull();
    expect(
      parseMediaGenRuntimeFrozenPlan(
        plan([subject, reference({ role: "voice", mediaClass: "audio" })]),
      ),
    ).not.toBeNull();
    expect(
      parseMediaGenRuntimeFrozenPlan(
        plan([reference({ role: "subject", mediaClass: "image", durationSec: 2 })]),
      ),
    ).toBeNull();
    expect(
      parseMediaGenRuntimeFrozenPlan(
        plan([subject, reference({ role: "motion", mediaClass: "video", durationSec: 1.9 })]),
      ),
    ).not.toBeNull();
    expect(
      parseMediaGenRuntimeFrozenPlan(
        plan([subject, reference({ role: "motion", mediaClass: "video", durationSec: 86_400.1 })]),
      ),
    ).toBeNull();
  });

  it("maps typed image, video, and audio references to the exact official roles", () => {
    const refs = [
      reference({ role: "subject", mediaClass: "image" }),
      reference({ role: "source_video", mediaClass: "video", durationSec: 6 }),
      reference({ role: "motion", mediaClass: "video", durationSec: 4 }),
      reference({ role: "voice", mediaClass: "audio", durationSec: 3 }),
    ];
    const compiled = compile(refs);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.body.content).toEqual([
      { type: "text", text: "Use every frozen typed reference without truncation." },
      expect.objectContaining({ type: "image_url", role: "reference_image" }),
      expect.objectContaining({ type: "video_url", role: "reference_video" }),
      expect.objectContaining({ type: "video_url", role: "reference_video" }),
      expect.objectContaining({ type: "audio_url", role: "reference_audio" }),
    ]);
    expect(Object.keys(compiled.body)).toEqual([
      "model",
      "content",
      "generate_audio",
      "ratio",
      "duration",
      "resolution",
    ]);
    expect(compiled.body.generate_audio).toBe(true);
  });

  it("preserves all official maximum-count references without truncation", () => {
    const refs = [
      ...Array.from({ length: 5 }, (_, ordinal) =>
        reference({ role: "subject", ordinal, mediaClass: "image" }),
      ),
      ...Array.from({ length: 4 }, (_, ordinal) =>
        reference({ role: "style", ordinal, mediaClass: "image" }),
      ),
      reference({ role: "source_video", mediaClass: "video", durationSec: 5 }),
      ...Array.from({ length: 2 }, (_, ordinal) =>
        reference({ role: "motion", ordinal, mediaClass: "video", durationSec: 5 }),
      ),
      ...Array.from({ length: 3 }, (_, ordinal) =>
        reference({ role: "voice", ordinal, mediaClass: "audio", durationSec: 5 }),
      ),
    ];
    const compiled = compile(refs);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.body.content).toHaveLength(16);
    expect(compiled.body.content.filter((item) => item.type === "image_url")).toHaveLength(9);
    expect(compiled.body.content.filter((item) => item.type === "video_url")).toHaveLength(3);
    expect(compiled.body.content.filter((item) => item.type === "audio_url")).toHaveLength(3);
  });

  it("keeps strict first/last-frame modes mutually exclusive with multimodal references", () => {
    const first = reference({ role: "first_frame", mediaClass: "image" });
    const last = reference({ role: "last_frame", mediaClass: "image" });
    expect(
      compile([first, last], { scenario: "first_last_frame_to_video", audio: "silent" }),
    ).toMatchObject({ ok: true });
    expect(
      compile([first, reference({ role: "subject", mediaClass: "image" })], {
        scenario: "first_frame_to_video",
        audio: "silent",
      }),
    ).toMatchObject({ ok: false });
    expect(
      compile([first, reference({ role: "voice", mediaClass: "audio", durationSec: 3 })], {
        scenario: "multimodal_reference_to_video",
      }),
    ).toMatchObject({ ok: false });
  });

  it("requires every audio reference to be conditioned by image/video media", () => {
    expect(
      compile([reference({ role: "voice", mediaClass: "audio", durationSec: 3 })]),
    ).toMatchObject({ ok: false });
    expect(
      compile(
        [
          reference({ role: "subject", mediaClass: "image" }),
          reference({ role: "voice", mediaClass: "audio", durationSec: 3 }),
        ],
        { audio: "native_generate" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects count overflow independently for image, video, and audio", () => {
    const imageOverflow = Array.from({ length: 10 }, (_, ordinal) =>
      reference({ role: "subject", ordinal, mediaClass: "image" }),
    );
    const videoOverflow = [
      reference({ role: "subject", mediaClass: "image" }),
      ...Array.from({ length: 4 }, (_, ordinal) =>
        reference({ role: "motion", ordinal, mediaClass: "video", durationSec: 3 }),
      ),
    ];
    const audioOverflow = [
      reference({ role: "subject", mediaClass: "image" }),
      ...Array.from({ length: 4 }, (_, ordinal) =>
        reference({ role: "voice", ordinal, mediaClass: "audio", durationSec: 3 }),
      ),
    ];
    expect(compile(imageOverflow)).toMatchObject({ ok: false });
    expect(compile(videoOverflow)).toMatchObject({ ok: false });
    expect(compile(audioOverflow)).toMatchObject({ ok: false });
  });

  it("rejects missing, out-of-range, aggregate-overflow, and image durations", () => {
    const subject = reference({ role: "subject", mediaClass: "image" });
    expect(
      compile([
        subject,
        reference({ role: "motion", mediaClass: "video", durationSec: 2 }),
        reference({ role: "voice", mediaClass: "audio", durationSec: 15 }),
      ]),
    ).toMatchObject({ ok: true });
    expect(compile([subject, reference({ role: "motion", mediaClass: "video" })])).toMatchObject({
      ok: false,
    });
    expect(
      compile([subject, reference({ role: "motion", mediaClass: "video", durationSec: 1.9 })]),
    ).toMatchObject({ ok: false });
    expect(
      compile([subject, reference({ role: "voice", mediaClass: "audio", durationSec: 15.1 })]),
    ).toMatchObject({ ok: false });
    expect(
      compile([
        subject,
        reference({ role: "voice", ordinal: 0, mediaClass: "audio", durationSec: 8 }),
        reference({ role: "voice", ordinal: 1, mediaClass: "audio", durationSec: 8 }),
      ]),
    ).toMatchObject({ ok: false });
    expect(
      compile([
        subject,
        reference({ role: "motion", ordinal: 0, mediaClass: "video", durationSec: 8 }),
        reference({ role: "motion", ordinal: 1, mediaClass: "video", durationSec: 8 }),
      ]),
    ).toMatchObject({ ok: false });
    expect(
      compile([reference({ role: "subject", mediaClass: "image", durationSec: 2 })]),
    ).toMatchObject({ ok: false });
  });

  it("rejects unsupported role/media and source mappings without fallback", () => {
    const wrongRole = reference({
      role: "subject",
      mediaClass: "video",
      durationSec: 3,
    });
    expect(compile([wrongRole])).toMatchObject({ ok: false });

    expect(
      compile([
        reference({ role: "subject", mediaClass: "image" }),
        reference({
          role: "motion",
          mediaClass: "video",
          durationSec: 3,
          mimeType: "video/webm",
        }),
      ]),
    ).toMatchObject({ ok: false });

    const artifactVideo = reference({
      role: "source_video",
      mediaClass: "video",
      durationSec: 3,
      kind: "artifact",
    });
    const frozenPlan = plan([artifactVideo], { scenario: "video_edit" });
    expect(
      compileSeedanceV2Request(
        vendorInput(frozenPlan, [
          slot(artifactVideo, {
            providerRef: "asset://seedance/source-video.mp4",
            mimeType: "video/mp4",
            sha256: sha("source_video-0"),
          }),
        ]),
      ),
    ).toMatchObject({ ok: false });

    const runtimeVideo = reference({
      role: "source_video",
      mediaClass: "video",
      durationSec: 3,
    });
    const runtimePlan = plan([runtimeVideo], { scenario: "video_edit" });
    for (const source of [
      {
        providerRef: "asset://seedance/source-video.mp4",
        mimeType: "video/quicktime",
        sha256: sha("source_video-0"),
      },
      {
        providerRef: "asset://seedance/source-video.mp4",
        mimeType: "video/mp4",
        sha256: sha("wrong-source"),
      },
    ]) {
      expect(
        compileSeedanceV2Request(vendorInput(runtimePlan, [slot(runtimeVideo, source)])),
      ).toMatchObject({ ok: false });
    }

    for (const runtimeLocalRef of [
      "asset://not-an-opaque-handle",
      "file:///tmp/source.mp4",
      "/tmp/source.mp4",
      `a${"x".repeat(128)}`,
    ]) {
      const providerRefAsHandle = {
        ...runtimeVideo,
        source: { kind: "runtime_local" as const, runtimeLocalRef },
      };
      expect(compile([providerRefAsHandle], { scenario: "video_edit" })).toMatchObject({
        ok: false,
      });
    }

    const missingCompanion = {
      ...runtimeVideo,
      source: {
        kind: "runtime_local" as const,
        runtimeLocalRef: "local-source-video-0",
      },
    };
    expect(compile([missingCompanion], { scenario: "video_edit" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects generic provider params and unsupported preserve-source audio semantics", () => {
    const sourceVideo = reference({
      role: "source_video",
      mediaClass: "video",
      durationSec: 6,
    });
    const frozenPlan = plan([sourceVideo], { scenario: "video_extend" });
    expect(
      compileSeedanceV2Request(
        vendorInput(frozenPlan, undefined, { ratio: "9:16", vendor_magic: true }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compile([sourceVideo], { scenario: "video_extend", audio: "preserve_source" }),
    ).toMatchObject({ ok: false });
  });

  it.each(["video_to_video", "video_edit", "video_extend"] as const)(
    "accepts the official prompt-directed %s scenario with one typed source video",
    (scenario) => {
      expect(
        compile([reference({ role: "source_video", mediaClass: "video", durationSec: 6 })], {
          scenario,
        }),
      ).toMatchObject({ ok: true });
    },
  );
});
