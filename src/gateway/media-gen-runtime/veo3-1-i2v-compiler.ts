import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type { MediaGenRuntimeSource, MediaGenRuntimeVendorInput } from "./types.js";

export const VEO31_I2V_MODEL_ID = "veo-3.1-generate-001";
export const VEO31_I2V_ADAPTER_REVISION = "openclaw-veo3.1-i2v-runtime/v1";
export const VEO31_I2V_ROUTE_ID =
  "veo.vertex_ai.us_central1.veo_3_1_generate_001.first_frame_to_video";
export const VEO31_I2V_ENDPOINT_ID = "aiplatform.v1.predictLongRunning";
export const VEO31_I2V_PROFILE_ID =
  "veo.openclaw-runtime.veo3_1_generate_001.first_frame_to_video.v1";
// Pinned to the server-owned CapabilityProfileRevision so route/profile drift
// fails before a paid request leaves the user runtime.
export const VEO31_I2V_PROFILE_DIGEST =
  "sha256:31f44779c074c78eda4dccc74508c941b8eea8422a109591c604cf2baa273dac";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const DURATIONS = new Set([4, 6, 8]);
const ASPECT_RATIOS = new Set(["16:9", "9:16"]);
const RESOLUTIONS = new Set(["720p", "1080p"]);
const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/u;

export type Veo31I2vCreateBody = {
  instances: [
    {
      prompt: string;
      image: { bytesBase64Encoded: string; mimeType: "image/jpeg" | "image/png" };
    },
  ];
  parameters: {
    task: "imageToVideo";
    aspectRatio: "16:9" | "9:16";
    durationSeconds: 4 | 6 | 8;
    enhancePrompt: true;
    generateAudio: false;
    personGeneration: "allow_adult";
    resolution: "720p" | "1080p";
    sampleCount: 1;
    resizeMode: "pad";
  };
};

export type Veo31I2vCompileResult =
  | { ok: true; body: Veo31I2vCreateBody; providerRequestDigest: string }
  | { ok: false; message: string };

function fail(message: string): Veo31I2vCompileResult {
  return { ok: false, message };
}

function normalizedSha256(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return SHA256.exec(value)?.[1] ?? null;
}

function firstFrameImage(
  reference: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): { bytesBase64Encoded: string; mimeType: "image/jpeg" | "image/png" } | null {
  if (
    reference.role !== "first_frame" ||
    reference.ordinal !== 0 ||
    !reference.required ||
    reference.mediaClass !== "image" ||
    reference.source.kind !== "artifact" ||
    !reference.assetRefId ||
    !reference.authorityRef ||
    !reference.authorityVerified ||
    !source.bytes ||
    source.bytes.length === 0 ||
    source.bytes.length > MAX_IMAGE_BYTES ||
    source.providerRef
  ) {
    return null;
  }
  const mimeType = reference.mimeType;
  if (!mimeType || !IMAGE_MIME_TYPES.has(mimeType) || source.mimeType !== mimeType) {
    return null;
  }
  const expectedSha256 = normalizedSha256(reference.sourceDigest);
  const actualSha256 = createHash("sha256").update(source.bytes).digest("hex");
  const resolvedSha256 = source.sha256 === undefined ? undefined : normalizedSha256(source.sha256);
  if (
    !expectedSha256 ||
    actualSha256 !== expectedSha256 ||
    (source.sha256 !== undefined && resolvedSha256 !== expectedSha256)
  ) {
    return null;
  }
  return {
    bytesBase64Encoded: source.bytes.toString("base64"),
    mimeType: mimeType as "image/jpeg" | "image/png",
  };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "veo" ||
    input.mode !== "image2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationScenario !== "first_frame_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.adapterRevision !== VEO31_I2V_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== VEO31_I2V_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "google_vertex_ai" ||
    plan.providerRouteRef.modelId !== VEO31_I2V_MODEL_ID ||
    plan.providerRouteRef.endpointId !== VEO31_I2V_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "us-central1" ||
    plan.providerRouteRef.accountTier !== "adc" ||
    plan.capabilityProfileRef.profileId !== VEO31_I2V_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 1 ||
    plan.capabilityProfileRef.digest !== VEO31_I2V_PROFILE_DIGEST
  ) {
    return "The frozen Veo route/profile does not match Veo 3.1 first-frame Image-to-Video.";
  }
  return input.prompt === plan.generationIntent.compiledPrompt
    ? null
    : "The runtime prompt does not match the frozen Veo compiled prompt.";
}

function validateMappings(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan!;
  const expectedMappings = new Map<
    string,
    { support: "native" | "prompt"; providerField?: string; providerSlot?: string }
  >([
    ["generationScenario", { support: "native", providerField: "scenario" }],
    ["outputAudioPolicy", { support: "native", providerField: "output.audio" }],
    ["compiledPrompt", { support: "prompt", providerField: "prompt" }],
    ["camera.cameraPrompt", { support: "prompt", providerField: "prompt" }],
    ["references.first_frame.0", { support: "native", providerSlot: "references.first_frame" }],
    ["output.durationSec", { support: "native", providerField: "output.durationSec" }],
    ["output.aspectRatio", { support: "native", providerField: "output.aspectRatio" }],
    ["output.resolution", { support: "native", providerField: "output.resolution" }],
    ["output.fps", { support: "native", providerField: "output.fps" }],
  ]);
  if (
    plan.constraintPlan.some((row) => {
      if (row.required && row.support === "unsupported") {
        return true;
      }
      const expected = expectedMappings.get(row.intentPath);
      if (!expected) {
        return (
          row.providerSlot !== undefined ||
          (row.providerField !== undefined &&
            (row.support !== "prompt" || row.providerField !== "prompt"))
        );
      }
      return (
        row.support !== expected.support ||
        row.providerField !== expected.providerField ||
        row.providerSlot !== expected.providerSlot
      );
    })
  ) {
    return "The frozen Veo plan contains an unimplemented provider mapping.";
  }

  const requireMapping = (intentPath: string): boolean =>
    plan.constraintPlan.filter((row) => row.intentPath === intentPath).length === 1;
  for (const intentPath of [
    "generationScenario",
    "outputAudioPolicy",
    "compiledPrompt",
    "references.first_frame.0",
    "output.durationSec",
    "output.aspectRatio",
    "output.resolution",
  ]) {
    if (!requireMapping(intentPath)) {
      return `Veo ${intentPath} is missing its exact frozen mapping.`;
    }
  }
  const camera = plan.constraintPlan.find((row) => row.intentPath === "camera.cameraPrompt");
  if (plan.generationIntent.camera.cameraPrompt !== undefined && camera === undefined) {
    return "Veo camera intent must remain prompt-only.";
  }
  const fps = plan.constraintPlan.find((row) => row.intentPath === "output.fps");
  if (plan.generationIntent.output.fps !== undefined && fps === undefined) {
    return "Veo fixed FPS must retain its exact native mapping.";
  }
  if (input.params !== undefined) {
    return "Unplanned provider parameters are not accepted by the Veo adapter.";
  }
  return null;
}

/** Compile one exact Vertex AI Veo 3.1 first-frame request without passthrough. */
export function compileVeo31I2vRequest(input: MediaGenRuntimeVendorInput): Veo31I2vCompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) {
    return fail(identityError);
  }
  const mappingError = validateMappings(input);
  if (mappingError) {
    return fail(mappingError);
  }

  const intent = input.frozenPlan!.generationIntent;
  const output = intent.output;
  if (
    intent.generationScenario !== "first_frame_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    output.shotCount !== 1 ||
    !DURATIONS.has(output.durationSec ?? -1) ||
    input.durationSec !== output.durationSec ||
    typeof output.aspectRatio !== "string" ||
    !ASPECT_RATIOS.has(output.aspectRatio) ||
    typeof output.resolution !== "string" ||
    !RESOLUTIONS.has(output.resolution) ||
    input.resolution !== output.resolution ||
    (output.fps !== undefined && output.fps !== 24) ||
    output.qualityIntent !== undefined ||
    intent.narrative.negativePrompt !== undefined ||
    intent.compiledPrompt.trim().length === 0 ||
    input.source !== undefined
  ) {
    return fail("The frozen Veo output constraints are incomplete or unsupported.");
  }

  const references = intent.references;
  const sources = input.sources;
  if (
    references.length !== 1 ||
    sources?.length !== 1 ||
    sources[0]?.role !== "first_frame" ||
    sources[0]?.ordinal !== 0
  ) {
    return fail("Veo 3.1 Image-to-Video requires exactly one typed first frame.");
  }
  const image = firstFrameImage(references[0], sources[0].source);
  if (!image) {
    return fail("The frozen Veo first frame failed byte, MIME, digest, or authority verification.");
  }

  const body: Veo31I2vCreateBody = {
    instances: [{ prompt: intent.compiledPrompt, image }],
    parameters: {
      task: "imageToVideo",
      aspectRatio: output.aspectRatio as "16:9" | "9:16",
      durationSeconds: output.durationSec as 4 | 6 | 8,
      enhancePrompt: true,
      generateAudio: false,
      personGeneration: "allow_adult",
      resolution: output.resolution as "720p" | "1080p",
      sampleCount: 1,
      resizeMode: "pad",
    },
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")}`,
  };
}
