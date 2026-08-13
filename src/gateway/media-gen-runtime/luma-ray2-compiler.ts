import { createHash } from "node:crypto";
import type { MediaGenRuntimeVendorInput } from "./types.js";

export const LUMA_RAY2_MODEL_ID = "ray-2";
export const LUMA_RAY2_ADAPTER_REVISION = "openclaw-luma-ray2-runtime/v1";
export const LUMA_RAY2_ROUTE_ID = "luma.dream_machine.v1.ray_2.text_to_video";
export const LUMA_RAY2_ENDPOINT_ID = "luma.dream_machine.v1.generations.video";
export const LUMA_RAY2_PROFILE_ID = "luma.openclaw-runtime.ray2.text2video.v2";
export const LUMA_RAY2_PROFILE_REVISION = 2;
export const LUMA_RAY2_PROFILE_DIGEST =
  "sha256:5e1e7bd0665d20349beed790e1b1d4d6b05925db76c842bfd88b6cb7c496cc06";
export const LUMA_RAY2_LEGACY_PROFILE_ID = "luma.openclaw-runtime.ray2.text2video.v1";
export const LUMA_RAY2_LEGACY_PROFILE_REVISION = 1;
export const LUMA_RAY2_LEGACY_PROFILE_DIGEST =
  "sha256:8672c78e53f61194ab999703754410607d40a3303e762039612f943a194b46d2";

const DURATIONS = new Set([5, 9]);
const ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "9:21"]);
const RESOLUTIONS = new Set(["540p", "720p", "1080p", "4k"]);

export type LumaRay2CreateBody = {
  model: typeof LUMA_RAY2_MODEL_ID;
  prompt: string;
  duration: "5s" | "9s";
  aspect_ratio: string;
  resolution: string;
};

export type LumaRay2CompileResult =
  | {
      ok: true;
      body: LumaRay2CreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

function fail(message: string): LumaRay2CompileResult {
  return { ok: false, message };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  const profile = plan?.capabilityProfileRef;
  const activeProfile =
    profile?.profileId === LUMA_RAY2_PROFILE_ID &&
    profile.revision === LUMA_RAY2_PROFILE_REVISION &&
    profile.digest === LUMA_RAY2_PROFILE_DIGEST;
  const legacyProfile =
    profile?.profileId === LUMA_RAY2_LEGACY_PROFILE_ID &&
    profile.revision === LUMA_RAY2_LEGACY_PROFILE_REVISION &&
    profile.digest === LUMA_RAY2_LEGACY_PROFILE_DIGEST;
  if (
    !plan ||
    input.presetId !== "luma" ||
    input.mode !== "text2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.adapterRevision !== LUMA_RAY2_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== LUMA_RAY2_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "luma_dream_machine" ||
    plan.providerRouteRef.modelId !== LUMA_RAY2_MODEL_ID ||
    plan.providerRouteRef.endpointId !== LUMA_RAY2_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "global" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    (!activeProfile && !legacyProfile)
  ) {
    return "The frozen Luma route/profile does not match Ray 2 Text-to-Video.";
  }
  if (input.prompt !== plan.generationIntent.compiledPrompt) {
    return "The runtime prompt does not match the frozen Luma compiled prompt.";
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
    "output.resolution",
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        row.providerSlot !== undefined ||
        (row.providerField !== undefined && !allowedProviderFields.has(row.providerField)) ||
        (row.required && row.support === "unsupported"),
    )
  ) {
    return "The frozen Luma plan contains an unimplemented provider mapping.";
  }
  for (const expected of [
    { intentPath: "generationScenario", support: "native", providerField: "scenario" },
    { intentPath: "outputAudioPolicy", support: "native", providerField: "output.audio" },
    {
      intentPath: "compiledPrompt",
      support: "prompt",
      providerField: "prompt",
    },
  ] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === expected.intentPath);
    if (
      mapping?.required !== true ||
      mapping.support !== expected.support ||
      mapping.providerField !== expected.providerField
    ) {
      return `Luma ${expected.intentPath} was not frozen as an exact mapping.`;
    }
  }
  for (const path of ["output.durationSec", "output.aspectRatio", "output.resolution"] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping?.support !== "native" || mapping.providerField !== path) {
      return `Luma ${path} was not frozen as an exact native mapping.`;
    }
  }
  const fpsMapping = plan.constraintPlan.find((row) => row.intentPath === "output.fps");
  if (
    fpsMapping &&
    (fpsMapping.support !== "approximate" || fpsMapping.providerField !== undefined)
  ) {
    return "An unverified Luma FPS field was marked as provider-native.";
  }
  if (input.params !== undefined) {
    return "Unplanned provider parameters are not accepted by the Luma adapter.";
  }
  return null;
}

/** Compile only the official Luma SDK v1.21.0 Ray 2 text-to-video request fields. */
export function compileLumaRay2Request(input: MediaGenRuntimeVendorInput): LumaRay2CompileResult {
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
  const aspectRatio = intent.output.aspectRatio;
  const resolution = intent.output.resolution;
  if (
    intent.generationScenario !== "text_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.output.shotCount !== 1 ||
    intent.output.fps !== undefined ||
    intent.references.length !== 0 ||
    input.source !== undefined ||
    input.sources !== undefined ||
    !DURATIONS.has(duration ?? -1) ||
    input.durationSec !== duration ||
    typeof aspectRatio !== "string" ||
    !ASPECT_RATIOS.has(aspectRatio) ||
    typeof resolution !== "string" ||
    !RESOLUTIONS.has(resolution) ||
    input.resolution !== resolution ||
    intent.compiledPrompt.trim().length === 0
  ) {
    return fail("The frozen Luma output constraints are incomplete or unsupported.");
  }

  const body: LumaRay2CreateBody = {
    model: LUMA_RAY2_MODEL_ID,
    prompt: intent.compiledPrompt,
    duration: `${duration}s` as "5s" | "9s",
    aspect_ratio: aspectRatio,
    resolution,
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")}`,
  };
}
