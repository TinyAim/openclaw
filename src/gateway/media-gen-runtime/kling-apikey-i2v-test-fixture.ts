import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  KLING_APIKEY_2_6_I2V_PROFILE_DIGEST,
  type KlingApiKeyPreparedSubmission,
} from "./kling-apikey-i2v-compiler.js";
import type { MediaGenRuntimeVendorInput } from "./types.js";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}
export function klingFixture(): {
  input: MediaGenRuntimeVendorInput;
  prepared: KlingApiKeyPreparedSubmission;
} {
  const bytes = readFileSync(
    new URL("../../../test/fixtures/media/roof-camera-sky.jpg", import.meta.url),
  );
  const sha = createHash("sha256").update(bytes).digest("hex");
  const ref = {
    role: "first_frame" as const,
    ordinal: 0,
    required: true,
    mediaClass: "image" as const,
    source: { kind: "artifact" as const, artifactId: "artifact-frame" },
    authorityVerified: true,
    mimeType: "image/jpeg",
    sourceDigest: `sha256:${sha}`,
  };
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project",
      shotId: "shot",
      shotVersion: "v1",
      promptPackId: "pack",
      promptPackVersion: 1,
      promptPackUpdatedAt: "2026-10-28T00:00:00Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: [ref.sourceDigest],
    },
    generationScenario: "first_frame_to_video" as const,
    outputAudioPolicy: "silent" as const,
    legacyMode: "image2video" as const,
    compiledPrompt: "A small boat at dawn",
    narrative: { visualPrompt: "A small boat at dawn", reservedForLater: [] },
    camera: {},
    performance: {},
    look: {},
    references: [ref],
    output: { durationSec: 5, resolution: "720p", shotCount: 1 },
    policy: { authority: "server" as const },
  };
  const mapping = (intentPath: string, support: "native" | "prompt") => ({
    intentPath,
    sourceRef: "source:v1",
    sourceRevision: "v1",
    required: true,
    support,
    reasonCode: "supported",
    messageKey: "media.supported",
  });
  return {
    input: {
      taskId: "task",
      presetId: "kling",
      mode: "image2video",
      prompt: intent.compiledPrompt,
      durationSec: 5,
      resolution: "720p",
      sources: [
        {
          role: "first_frame",
          ordinal: 0,
          artifactId: "artifact-frame",
          source: { bytes, mimeType: "image/jpeg", sha256: sha },
        },
      ],
      frozenPlan: {
        schemaVersion: 2,
        previewId: "preview",
        presetId: "kling",
        mode: "image2video",
        generationIntent: intent,
        generationIntentDigest: `intent:sha256:${createHash("sha256").update(stable(intent)).digest("hex")}`,
        generationScenario: intent.generationScenario,
        outputAudioPolicy: intent.outputAudioPolicy,
        providerRouteRef: {
          schemaVersion: 1,
          routeId: "kling-apikey-2.6-i2v-sg/v1",
          providerId: "kling_open_platform",
          modelId: "kling-2.6",
          endpointId: "kling.api.v2.image-to-video",
          region: "global",
          accountTier: "api_key",
        },
        capabilityProfileRef: {
          profileId: "kling.openclaw-runtime.kling_2_6.image2video.sg.v1",
          revision: 1,
          digest: KLING_APIKEY_2_6_I2V_PROFILE_DIGEST,
        },
        adapterRevision: "openclaw-kling-apikey-2.6-i2v-runtime/v1",
        runtimeRef: { runtimeId: "runtime", lastSeenAt: "2026-10-28T00:00:00Z" },
        constraintPlan: [
          mapping("generationScenario", "native"),
          mapping("outputAudioPolicy", "native"),
          mapping("compiledPrompt", "prompt"),
          mapping("references.first_frame.0", "native"),
        ],
        inputFingerprint: "a".repeat(64),
        intentFingerprint: "b".repeat(64),
      },
    },
    prepared: {
      externalTaskId: "attempt-123",
      frames: [
        {
          role: "first_frame",
          ordinal: 0,
          artifactId: "artifact-frame",
          sourceDigest: `sha256:${sha}`,
          mimeType: "image/jpeg",
          width: 1634,
          height: 1225,
          byteLength: bytes.length,
          url: "https://prepared.example/frame",
        },
      ],
    },
  };
}

export function klingTwoFrameFixture(): ReturnType<typeof klingFixture> {
  const result = klingFixture();
  const plan = result.input.frozenPlan!;
  const bytes = readFileSync(
    new URL("../../../test/fixtures/media/roof-camera-sky.jpg", import.meta.url),
  );
  const sha = createHash("sha256").update(bytes).digest("hex");
  const ref = {
    role: "last_frame" as const,
    ordinal: 0,
    required: true,
    mediaClass: "image" as const,
    source: { kind: "artifact" as const, artifactId: "artifact-last" },
    authorityVerified: true,
    mimeType: "image/jpeg",
    sourceDigest: `sha256:${sha}`,
  };
  plan.generationIntent.references.push(ref);
  plan.generationIntent.identity.sourceDigests.push(ref.sourceDigest);
  plan.generationScenario = plan.generationIntent.generationScenario = "first_last_frame_to_video";
  plan.outputAudioPolicy = plan.generationIntent.outputAudioPolicy = "native_generate";
  plan.generationIntent.output.durationSec = result.input.durationSec = 10;
  plan.generationIntent.output.resolution = result.input.resolution = "1080p";
  plan.constraintPlan.push({
    intentPath: "references.last_frame.0",
    sourceRef: "source:v1",
    sourceRevision: "v1",
    required: true,
    support: "native",
    reasonCode: "supported",
    messageKey: "media.supported",
  });
  plan.generationIntentDigest = `intent:sha256:${createHash("sha256").update(stable(plan.generationIntent)).digest("hex")}`;
  result.input.sources!.push({
    role: "last_frame",
    ordinal: 0,
    artifactId: "artifact-last",
    source: { bytes, mimeType: "image/jpeg", sha256: sha },
  });
  result.prepared = {
    ...result.prepared,
    frames: [
      ...result.prepared.frames,
      {
        role: "last_frame",
        ordinal: 0,
        artifactId: "artifact-last",
        sourceDigest: `sha256:${sha}`,
        mimeType: "image/jpeg",
        width: 1634,
        height: 1225,
        byteLength: bytes.length,
        url: "https://prepared.example/last",
      },
    ],
  };
  return result;
}
