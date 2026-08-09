import { createHash } from "node:crypto";
import type { MediaGenRuntimeVendorInput } from "./types.js";

export const KLING_T2V_V2_MODEL_ID = "kling-v1";
export const KLING_T2V_V2_ADAPTER_REVISION = "openclaw-kling-text2video-runtime/v2";
export const KLING_T2V_V2_ROUTE_ID = "kling.open.global.kling_v1.text2video.std";
export const KLING_T2V_V2_ENDPOINT_ID = "kling.v1.videos.text2video";
export const KLING_T2V_V2_PROFILE_ID = "kling.openclaw-runtime.kling_v1.text2video.std.v2";
export const KLING_T2V_V2_PROFILE_REVISION = 2;
export const KLING_T2V_V2_PROFILE_DIGEST =
  "sha256:f53106fae45b82efceacdfb43a31391df03e2ecda18a6e5a9ae3770d21a41f93";

const ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1"]);

export type KlingT2vV2CreateBody = {
  model_name: typeof KLING_T2V_V2_MODEL_ID;
  prompt: string;
  cfg_scale: 0.5;
  mode: "std";
  aspect_ratio: "16:9" | "9:16" | "1:1";
  duration: "5" | "10";
};

export type KlingT2vV2CompileResult =
  | {
      ok: true;
      body: KlingT2vV2CreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

function fail(message: string): KlingT2vV2CompileResult {
  return { ok: false, message };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "kling" ||
    input.mode !== "text2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.adapterRevision !== KLING_T2V_V2_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== KLING_T2V_V2_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "kling_open_platform" ||
    plan.providerRouteRef.modelId !== KLING_T2V_V2_MODEL_ID ||
    plan.providerRouteRef.endpointId !== KLING_T2V_V2_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "global" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== KLING_T2V_V2_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== KLING_T2V_V2_PROFILE_REVISION ||
    plan.capabilityProfileRef.digest !== KLING_T2V_V2_PROFILE_DIGEST
  ) {
    return "The frozen Kling route/profile does not match Text-to-Video Adapter V2.";
  }
  if (input.prompt !== plan.generationIntent.compiledPrompt) {
    return "The runtime prompt does not match the frozen Kling compiled prompt.";
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
        row.providerSlot !== undefined ||
        (row.providerField !== undefined && !allowedProviderFields.has(row.providerField)),
    )
  ) {
    return "The frozen Kling plan contains an unimplemented provider mapping.";
  }
  for (const path of ["output.durationSec", "output.aspectRatio"] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping?.support !== "native" || mapping.providerField !== path) {
      return `Kling ${path} was not frozen as an exact native mapping.`;
    }
  }
  for (const path of ["output.resolution", "output.fps"] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping && (mapping.support !== "approximate" || mapping.providerField !== undefined)) {
      return "An unverified Kling output field was marked as provider-native.";
    }
  }
  if (Object.keys(input.params ?? {}).length > 0) {
    return "Unplanned provider parameters are not accepted by Kling Text-to-Video Adapter V2.";
  }
  return null;
}

/** Compile only the pinned official Kling v1 Text-to-Video fields. */
export function compileKlingT2vV2Request(
  input: MediaGenRuntimeVendorInput,
): KlingT2vV2CompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) {
    return fail(identityError);
  }
  const mappingError = validateMappings(input);
  if (mappingError) {
    return fail(mappingError);
  }

  const intent = input.frozenPlan!.generationIntent;
  const ratio = intent.output.aspectRatio;
  const duration = intent.output.durationSec;
  const prompt = intent.compiledPrompt;
  if (
    intent.generationScenario !== "text_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.output.shotCount !== 1 ||
    (duration !== 5 && duration !== 10) ||
    input.durationSec !== duration ||
    typeof ratio !== "string" ||
    !ASPECT_RATIOS.has(ratio) ||
    intent.output.resolution !== undefined ||
    input.resolution !== undefined ||
    intent.output.fps !== undefined ||
    intent.references.length !== 0 ||
    input.source !== undefined ||
    (input.sources?.length ?? 0) !== 0 ||
    prompt.trim().length === 0
  ) {
    return fail("The frozen Kling output constraints are incomplete or unsupported.");
  }

  const body: KlingT2vV2CreateBody = {
    model_name: KLING_T2V_V2_MODEL_ID,
    prompt,
    cfg_scale: 0.5,
    mode: "std",
    aspect_ratio: ratio as KlingT2vV2CreateBody["aspect_ratio"],
    duration: String(duration) as KlingT2vV2CreateBody["duration"],
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")}`,
  };
}
