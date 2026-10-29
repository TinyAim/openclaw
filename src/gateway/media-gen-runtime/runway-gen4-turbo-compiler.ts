import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type { MediaGenRuntimeSource, MediaGenRuntimeVendorInput } from "./types.js";

export const RUNWAY_GEN4_TURBO_MODEL_ID = "gen4_turbo";
export const RUNWAY_GEN4_TURBO_ADAPTER_REVISION = "openclaw-runway-gen4-turbo-runtime/v1";
export const RUNWAY_GEN4_TURBO_ROUTE_ID = "runway.api.v1.gen4_turbo.image_to_video";
export const RUNWAY_GEN4_TURBO_ENDPOINT_ID = "runway.v1.image_to_video";
export const RUNWAY_GEN4_TURBO_PROFILE_ID = "runway.openclaw-runtime.gen4_turbo.image2video.v2";
export const RUNWAY_GEN4_TURBO_PROFILE_REVISION = 2;
export const RUNWAY_GEN4_TURBO_PROFILE_DIGEST =
  "sha256:0521fd8cab34fc53d1dae9c7b57d1aded69264020ad6356fba3723bb49731745";
export const RUNWAY_GEN4_TURBO_LEGACY_PROFILE_ID =
  "runway.openclaw-runtime.gen4_turbo.image2video.v1";
export const RUNWAY_GEN4_TURBO_LEGACY_PROFILE_REVISION = 1;
export const RUNWAY_GEN4_TURBO_LEGACY_PROFILE_DIGEST =
  "sha256:585c7dd1fada7457fe9b007dfb9e39d8f9ada78729d69770a6b9ddf4846cb265";

const MAX_IMAGE_DATA_URI_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpg", "image/jpeg", "image/png", "image/webp"]);
const RUNWAY_RATIOS = {
  "16:9": "1280:720",
  "9:16": "720:1280",
  "4:3": "1104:832",
  "3:4": "832:1104",
  "1:1": "960:960",
  "21:9": "1584:672",
} as const;

export type RunwayGen4TurboCreateBody = {
  model: typeof RUNWAY_GEN4_TURBO_MODEL_ID;
  promptImage: string;
  promptText?: string;
  ratio: (typeof RUNWAY_RATIOS)[keyof typeof RUNWAY_RATIOS];
  duration: number;
};

export type RunwayGen4TurboCompileResult =
  | {
      ok: true;
      body: RunwayGen4TurboCreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

function fail(message: string): RunwayGen4TurboCompileResult {
  return { ok: false, message };
}

function normalizedSha256(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/u.test(hex) ? hex : null;
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  const profile = plan?.capabilityProfileRef;
  const matchesActiveProfile =
    profile?.profileId === RUNWAY_GEN4_TURBO_PROFILE_ID &&
    profile.revision === RUNWAY_GEN4_TURBO_PROFILE_REVISION &&
    profile.digest === RUNWAY_GEN4_TURBO_PROFILE_DIGEST;
  const matchesLegacyProfile =
    profile?.profileId === RUNWAY_GEN4_TURBO_LEGACY_PROFILE_ID &&
    profile.revision === RUNWAY_GEN4_TURBO_LEGACY_PROFILE_REVISION &&
    profile.digest === RUNWAY_GEN4_TURBO_LEGACY_PROFILE_DIGEST;
  if (
    !plan ||
    input.presetId !== "runway" ||
    input.mode !== "image2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.adapterRevision !== RUNWAY_GEN4_TURBO_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== RUNWAY_GEN4_TURBO_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "runway_api" ||
    plan.providerRouteRef.modelId !== RUNWAY_GEN4_TURBO_MODEL_ID ||
    plan.providerRouteRef.endpointId !== RUNWAY_GEN4_TURBO_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "global" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    (!matchesActiveProfile && !matchesLegacyProfile)
  ) {
    return "The frozen Runway route/profile does not match Gen-4 Turbo Image-to-Video.";
  }
  if (input.prompt !== plan.generationIntent.compiledPrompt) {
    return "The runtime prompt does not match the frozen Runway compiled prompt.";
  }
  return null;
}

function validateMappings(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan!;
  const allowedProviderFields = new Set([
    "scenario",
    "output.audio",
    "prompt",
    "output.durationSec",
    "output.aspectRatio",
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        (row.providerField !== undefined && !allowedProviderFields.has(row.providerField)) ||
        (row.providerSlot !== undefined && row.providerSlot !== "references.first_frame"),
    )
  ) {
    return "The frozen Runway plan contains an unimplemented provider mapping.";
  }
  for (const [path, providerField] of [
    ["output.durationSec", "output.durationSec"],
    ["output.aspectRatio", "output.aspectRatio"],
  ] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping?.support !== "native" || mapping.providerField !== providerField) {
      return `Runway ${path} was not frozen as an exact native mapping.`;
    }
  }
  for (const path of ["output.resolution", "output.fps"]) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping && (mapping.support !== "approximate" || mapping.providerField !== undefined)) {
      return "An unverified Runway output field was marked as provider-native.";
    }
  }
  if (input.params !== undefined) {
    return "Unplanned provider parameters are not accepted by the Runway adapter.";
  }
  return null;
}

function firstFrameDataUri(
  reference: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): string | null {
  if (
    reference.role !== "first_frame" ||
    reference.ordinal !== 0 ||
    reference.mediaClass !== "image" ||
    !reference.authorityVerified ||
    !source.bytes ||
    source.bytes.length === 0 ||
    source.providerRef
  ) {
    return null;
  }
  const mimeType = source.mimeType.trim().toLowerCase();
  if (!IMAGE_MIME_TYPES.has(mimeType) || reference.mimeType?.trim().toLowerCase() !== mimeType) {
    return null;
  }
  const expectedSha256 = normalizedSha256(reference.sourceDigest);
  const resolvedSha256 = normalizedSha256(source.sha256);
  const actualSha256 = createHash("sha256").update(source.bytes).digest("hex");
  if (!expectedSha256 || resolvedSha256 !== expectedSha256 || actualSha256 !== expectedSha256) {
    return null;
  }
  const dataUri = `data:${mimeType};base64,${source.bytes.toString("base64")}`;
  return Buffer.byteLength(dataUri, "utf8") <= MAX_IMAGE_DATA_URI_BYTES ? dataUri : null;
}

/** Compile only the stable Gen-4 Turbo Image-to-Video v5.13.0 schema. */
export function compileRunwayGen4TurboRequest(
  input: MediaGenRuntimeVendorInput,
): RunwayGen4TurboCompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) {
    return fail(identityError);
  }
  const mappingError = validateMappings(input);
  if (mappingError) {
    return fail(mappingError);
  }

  const intent = input.frozenPlan!.generationIntent;
  const duration = intent.output.durationSec;
  const neutralRatio = intent.output.aspectRatio;
  if (
    intent.generationScenario !== "first_frame_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.output.shotCount !== 1 ||
    intent.output.fps !== undefined ||
    duration === undefined ||
    !Number.isInteger(duration) ||
    duration < 2 ||
    duration > 10 ||
    input.durationSec !== duration ||
    typeof neutralRatio !== "string" ||
    !(neutralRatio in RUNWAY_RATIOS) ||
    intent.compiledPrompt.length > 1_000 ||
    (intent.compiledPrompt.length > 0 && intent.compiledPrompt.trim().length === 0)
  ) {
    return fail("The frozen Runway output constraints are incomplete or unsupported.");
  }
  if (input.resolution !== undefined && input.resolution !== intent.output.resolution) {
    return fail("The runtime Runway resolution does not match the frozen intent.");
  }

  const references = intent.references;
  const sources = input.sources ?? [];
  if (
    input.source ||
    references.length !== 1 ||
    sources.length !== 1 ||
    references[0]?.role !== "first_frame" ||
    references[0]?.ordinal !== 0 ||
    sources[0]?.role !== "first_frame" ||
    sources[0]?.ordinal !== 0
  ) {
    return fail("Runway requires exactly one typed first-frame reference.");
  }
  const promptImage = firstFrameDataUri(references[0], sources[0].source);
  if (!promptImage) {
    return fail("The frozen Runway first frame failed size, MIME, or digest verification.");
  }

  const body: RunwayGen4TurboCreateBody = {
    model: RUNWAY_GEN4_TURBO_MODEL_ID,
    promptImage,
    ...(intent.compiledPrompt.length > 0 ? { promptText: intent.compiledPrompt } : {}),
    ratio: RUNWAY_RATIOS[neutralRatio as keyof typeof RUNWAY_RATIOS],
    duration,
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")}`,
  };
}
