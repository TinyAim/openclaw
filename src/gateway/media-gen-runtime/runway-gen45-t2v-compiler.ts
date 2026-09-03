import { createHash } from "node:crypto";
import type { MediaGenRuntimeVendorInput } from "./types.js";

export const RUNWAY_GEN45_T2V_MODEL_ID = "gen4.5";
export const RUNWAY_GEN45_T2V_ADAPTER_REVISION = "openclaw-runway-gen4.5-t2v-runtime/v1";
export const RUNWAY_GEN45_T2V_ROUTE_ID = "runway.api.v1.gen4_5.text_to_video.720p";
export const RUNWAY_GEN45_T2V_ENDPOINT_ID = "runway.v1.text_to_video";
export const RUNWAY_GEN45_T2V_PROFILE_ID = "runway.openclaw-runtime.gen4_5.text_to_video.720p.v2";
export const RUNWAY_GEN45_T2V_PROFILE_REVISION = 2;
export const RUNWAY_GEN45_T2V_PROFILE_DIGEST =
  "sha256:5dc496515f8001806bb88838145e2aa8322617d1ca1cdbc2079acfe7be781f88";
export const RUNWAY_GEN45_T2V_LEGACY_PROFILE_ID =
  "runway.openclaw-runtime.gen4_5.text_to_video.720p.v1";
export const RUNWAY_GEN45_T2V_LEGACY_PROFILE_REVISION = 1;
export const RUNWAY_GEN45_T2V_LEGACY_PROFILE_DIGEST =
  "sha256:3222c85f9a29d06e52a0ba73ea9260195eb8267ddedbd0af9ee8e39aa3910757";

const RUNWAY_T2V_RATIOS = {
  "16:9": "1280:720",
  "9:16": "720:1280",
} as const;

export type RunwayGen45T2vCreateBody = {
  model: typeof RUNWAY_GEN45_T2V_MODEL_ID;
  promptText: string;
  ratio: (typeof RUNWAY_T2V_RATIOS)[keyof typeof RUNWAY_T2V_RATIOS];
  duration: number;
};

export type RunwayGen45T2vCompileResult =
  | {
      ok: true;
      body: RunwayGen45T2vCreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

function fail(message: string): RunwayGen45T2vCompileResult {
  return { ok: false, message };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  const profile = plan?.capabilityProfileRef;
  const matchesActiveProfile =
    profile?.profileId === RUNWAY_GEN45_T2V_PROFILE_ID &&
    profile.revision === RUNWAY_GEN45_T2V_PROFILE_REVISION &&
    profile.digest === RUNWAY_GEN45_T2V_PROFILE_DIGEST;
  const matchesLegacyProfile =
    profile?.profileId === RUNWAY_GEN45_T2V_LEGACY_PROFILE_ID &&
    profile.revision === RUNWAY_GEN45_T2V_LEGACY_PROFILE_REVISION &&
    profile.digest === RUNWAY_GEN45_T2V_LEGACY_PROFILE_DIGEST;
  if (
    !plan ||
    input.presetId !== "runway" ||
    input.mode !== "text2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationScenario !== "text_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.adapterRevision !== RUNWAY_GEN45_T2V_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== RUNWAY_GEN45_T2V_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "runway_api" ||
    plan.providerRouteRef.modelId !== RUNWAY_GEN45_T2V_MODEL_ID ||
    plan.providerRouteRef.endpointId !== RUNWAY_GEN45_T2V_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "global" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    (!matchesActiveProfile && !matchesLegacyProfile)
  ) {
    return "The frozen Runway route/profile does not match Gen-4.5 Text-to-Video.";
  }
  if (input.prompt !== plan.generationIntent.compiledPrompt) {
    return "The runtime prompt does not match the frozen Runway compiled prompt.";
  }
  return null;
}

function validateMappings(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan!;
  const exactMappings = new Map<string, { support: "native" | "prompt"; providerField: string }>([
    ["generationScenario", { support: "native", providerField: "scenario" }],
    ["outputAudioPolicy", { support: "native", providerField: "output.audio" }],
    ["compiledPrompt", { support: "prompt", providerField: "prompt" }],
    ["output.durationSec", { support: "native", providerField: "output.durationSec" }],
    ["output.aspectRatio", { support: "native", providerField: "output.aspectRatio" }],
    ["output.resolution", { support: "native", providerField: "output.resolution" }],
  ]);
  const allowedProviderFields = new Set(
    [...exactMappings.values()].map((mapping) => mapping.providerField),
  );
  if (
    plan.constraintPlan.some(
      (row) =>
        row.providerSlot !== undefined ||
        (row.providerField !== undefined && !allowedProviderFields.has(row.providerField)),
    )
  ) {
    return "The frozen Runway plan contains an unimplemented provider mapping.";
  }
  for (const [intentPath, expected] of exactMappings) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === intentPath);
    if (
      !mapping ||
      mapping.support !== expected.support ||
      mapping.providerField !== expected.providerField
    ) {
      return `Runway ${intentPath} was not frozen as an exact mapping.`;
    }
  }
  const fpsMapping = plan.constraintPlan.find((row) => row.intentPath === "output.fps");
  if (
    fpsMapping &&
    (fpsMapping.support !== "approximate" || fpsMapping.providerField !== undefined)
  ) {
    return "An unverified Runway FPS field was marked as provider-native.";
  }
  if (input.params !== undefined) {
    return "Unplanned provider parameters are not accepted by the Runway adapter.";
  }
  return null;
}

/** Compile only the pinned Runway Gen-4.5 Text-to-Video request fields. */
export function compileRunwayGen45T2vRequest(
  input: MediaGenRuntimeVendorInput,
): RunwayGen45T2vCompileResult {
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
  const prompt = intent.compiledPrompt;
  if (
    intent.generationScenario !== "text_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.output.shotCount !== 1 ||
    duration === undefined ||
    !Number.isInteger(duration) ||
    duration < 2 ||
    duration > 10 ||
    input.durationSec !== duration ||
    typeof neutralRatio !== "string" ||
    !(neutralRatio in RUNWAY_T2V_RATIOS) ||
    intent.output.resolution !== "720p" ||
    input.resolution !== "720p" ||
    intent.output.fps !== undefined ||
    intent.references.length !== 0 ||
    input.source !== undefined ||
    input.sources !== undefined ||
    prompt.trim().length === 0 ||
    prompt.length > 1_000
  ) {
    return fail("The frozen Runway output constraints are incomplete or unsupported.");
  }

  const body: RunwayGen45T2vCreateBody = {
    model: RUNWAY_GEN45_T2V_MODEL_ID,
    promptText: prompt,
    ratio: RUNWAY_T2V_RATIOS[neutralRatio as keyof typeof RUNWAY_T2V_RATIOS],
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
