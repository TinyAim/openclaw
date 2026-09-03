import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type { MediaGenRuntimeSource, MediaGenRuntimeVendorInput } from "./types.js";

export const LUMA_RAY2_I2V_MODEL_ID = "ray-2";
export const LUMA_RAY2_I2V_ADAPTER_REVISION = "openclaw-luma-ray2-i2v-runtime/v1";
export const LUMA_RAY2_I2V_ROUTE_ID = "luma.dream_machine.v1.ray_2.first_frame_to_video";
export const LUMA_RAY2_I2V_ENDPOINT_ID = "luma.dream_machine.v1.generations.video";
export const LUMA_RAY2_I2V_PROFILE_ID = "luma.openclaw-runtime.ray2.first_frame_to_video.v1";
// Pinned to the server-owned CapabilityProfileRevision so route/profile drift
// fails before a paid provider request leaves the user runtime.
export const LUMA_RAY2_I2V_PROFILE_DIGEST =
  "sha256:57d4ca9d24c2cde63b587b22005dcd7f33a82acf9b1fc90b971928ecef28c311";

const DURATIONS = new Set([5, 9]);
const ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "9:21"]);
const RESOLUTIONS = new Set(["540p", "720p", "1080p", "4k"]);
const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/u;
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/u;

export type LumaRay2I2vCreateBody = {
  model: typeof LUMA_RAY2_I2V_MODEL_ID;
  prompt: string;
  duration: "5s" | "9s";
  aspect_ratio: string;
  resolution: string;
  keyframes: {
    frame0: { type: "image"; url: string };
  };
};

export type LumaRay2I2vCompileResult =
  | {
      ok: true;
      body: LumaRay2I2vCreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

function fail(message: string): LumaRay2I2vCompileResult {
  return { ok: false, message };
}

function normalizedSha256(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return SHA256.exec(value)?.[1] ?? null;
}

function httpsImageUrl(
  reference: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): string | null {
  if (
    reference.role !== "first_frame" ||
    reference.ordinal !== 0 ||
    !reference.required ||
    reference.mediaClass !== "image" ||
    reference.source.kind !== "runtime_local" ||
    !reference.authorityVerified ||
    !source.providerRef ||
    source.bytes
  ) {
    return null;
  }
  const referenceMime = reference.mimeType?.trim().toLowerCase();
  const sourceMime = source.mimeType.trim().toLowerCase();
  if (!referenceMime || !IMAGE_MIME.test(referenceMime) || sourceMime !== referenceMime) {
    return null;
  }
  const expectedSha256 = normalizedSha256(reference.sourceDigest);
  if (!expectedSha256 || normalizedSha256(source.sha256) !== expectedSha256) {
    return null;
  }
  try {
    const url = new URL(source.providerRef);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "luma" ||
    input.mode !== "image2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationScenario !== "first_frame_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.adapterRevision !== LUMA_RAY2_I2V_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== LUMA_RAY2_I2V_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "luma_dream_machine" ||
    plan.providerRouteRef.modelId !== LUMA_RAY2_I2V_MODEL_ID ||
    plan.providerRouteRef.endpointId !== LUMA_RAY2_I2V_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "global" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== LUMA_RAY2_I2V_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 1 ||
    plan.capabilityProfileRef.digest !== LUMA_RAY2_I2V_PROFILE_DIGEST
  ) {
    return "The frozen Luma route/profile does not match Ray 2 first-frame Image-to-Video.";
  }
  return input.prompt === plan.generationIntent.compiledPrompt
    ? null
    : "The runtime prompt does not match the frozen Luma compiled prompt.";
}

function validateMappings(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan!;
  const allowedFields = new Set([
    "scenario",
    "output.audio",
    "prompt",
    "output.durationSec",
    "output.aspectRatio",
    "output.resolution",
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        (row.providerField !== undefined && !allowedFields.has(row.providerField)) ||
        (row.providerSlot !== undefined && row.providerSlot !== "references.first_frame") ||
        (row.required && row.support === "unsupported"),
    )
  ) {
    return "The frozen Luma plan contains an unimplemented provider mapping.";
  }
  for (const [intentPath, providerField] of [
    ["generationScenario", "scenario"],
    ["outputAudioPolicy", "output.audio"],
    ["output.durationSec", "output.durationSec"],
    ["output.aspectRatio", "output.aspectRatio"],
    ["output.resolution", "output.resolution"],
  ] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === intentPath);
    if (mapping?.support !== "native" || mapping.providerField !== providerField) {
      return `Luma ${intentPath} was not frozen as an exact native mapping.`;
    }
  }
  const prompt = plan.constraintPlan.find((row) => row.intentPath === "compiledPrompt");
  if (prompt?.support !== "prompt" || prompt.providerField !== "prompt") {
    return "The Luma prompt was not frozen as the compiled provider prompt.";
  }
  const camera = plan.constraintPlan.find((row) => row.intentPath === "camera.cameraPrompt");
  if (
    (plan.generationIntent.camera.cameraPrompt !== undefined || camera !== undefined) &&
    (camera?.support !== "prompt" || camera.providerField !== "prompt")
  ) {
    return "Luma camera intent must remain prompt-only.";
  }
  const frame = plan.constraintPlan.find((row) => row.intentPath === "references.first_frame.0");
  if (frame?.support !== "native" || frame.providerSlot !== "references.first_frame") {
    return "The Luma first frame was not frozen as keyframes.frame0.";
  }
  if (input.params !== undefined) {
    return "Unplanned provider parameters are not accepted by the Luma adapter.";
  }
  return null;
}

/** Compile one exact Ray 2 first-frame Image-to-Video request without passthrough. */
export function compileLumaRay2I2vRequest(
  input: MediaGenRuntimeVendorInput,
): LumaRay2I2vCompileResult {
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
  const promptLength = Array.from(intent.compiledPrompt.trim()).length;
  if (
    intent.generationScenario !== "first_frame_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    output.shotCount !== 1 ||
    output.fps !== undefined ||
    output.qualityIntent !== undefined ||
    intent.narrative.negativePrompt !== undefined ||
    !DURATIONS.has(output.durationSec ?? -1) ||
    input.durationSec !== output.durationSec ||
    typeof output.aspectRatio !== "string" ||
    !ASPECT_RATIOS.has(output.aspectRatio) ||
    typeof output.resolution !== "string" ||
    !RESOLUTIONS.has(output.resolution) ||
    input.resolution !== output.resolution ||
    promptLength < 3 ||
    promptLength > 5_000 ||
    input.source !== undefined
  ) {
    return fail("The frozen Luma output constraints are incomplete or unsupported.");
  }

  const references = intent.references;
  const sources = input.sources;
  if (
    references.length !== 1 ||
    sources?.length !== 1 ||
    sources[0]?.role !== "first_frame" ||
    sources[0]?.ordinal !== 0
  ) {
    return fail("Luma Ray 2 Image-to-Video requires exactly one typed first frame.");
  }
  const imageUrl = httpsImageUrl(references[0], sources[0].source);
  if (!imageUrl) {
    return fail("The frozen Luma first frame failed URL, MIME, digest, or authority verification.");
  }

  const body: LumaRay2I2vCreateBody = {
    model: LUMA_RAY2_I2V_MODEL_ID,
    prompt: intent.compiledPrompt,
    duration: `${output.durationSec}s` as "5s" | "9s",
    aspect_ratio: output.aspectRatio,
    resolution: output.resolution,
    keyframes: { frame0: { type: "image", url: imageUrl } },
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")}`,
  };
}
