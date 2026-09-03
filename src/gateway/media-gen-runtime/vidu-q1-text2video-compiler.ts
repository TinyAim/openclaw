import { createHash } from "node:crypto";
import type { MediaGenRuntimeVendorInput } from "./types.js";

export const VIDU_Q1_T2V_MODEL_ID = "viduq1";
export const VIDU_Q1_T2V_ADAPTER_REVISION = "openclaw-vidu-q1-text2video-runtime/v2";
export const VIDU_Q1_T2V_ROUTE_ID = "vidu.enterprise.v2.viduq1.text2video.1080p";
export const VIDU_Q1_T2V_ENDPOINT_ID = "vidu.ent.v2.text2video";
export const VIDU_Q1_T2V_PROFILE_ID = "vidu.openclaw-runtime.viduq1.text2video.1080p.v2";
export const VIDU_Q1_T2V_PROFILE_REVISION = 2;
export const VIDU_Q1_T2V_PROFILE_DIGEST =
  "sha256:88db13a3b63a7556392eada4ef968c6debc8a4d83474dad67a2e067ca435f63f";
export const VIDU_Q1_T2V_HISTORICAL_PROFILE_ID = "vidu.openclaw-runtime.viduq1.text2video.1080p.v1";
export const VIDU_Q1_T2V_HISTORICAL_PROFILE_REVISION = 1;
export const VIDU_Q1_T2V_HISTORICAL_PROFILE_DIGEST =
  "sha256:b41d1a7c25c20bf9c3956663244199ad66f299091c3ee8d8e06d2e6e1d095472";

const RATIOS = new Set<ViduQ1T2vCreateBody["aspect_ratio"]>(["16:9", "9:16", "1:1"]);

export type ViduQ1T2vCreateBody = {
  model: typeof VIDU_Q1_T2V_MODEL_ID;
  style: "general";
  prompt: string;
  duration: 5;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  resolution: "1080p";
  bgm: false;
  movement_amplitude: "auto";
  off_peak: false;
};

export type ViduQ1T2vCompileResult =
  | {
      ok: true;
      body: ViduQ1T2vCreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

function fail(message: string): ViduQ1T2vCompileResult {
  return { ok: false, message };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  const activeProfile =
    plan?.capabilityProfileRef.profileId === VIDU_Q1_T2V_PROFILE_ID &&
    plan.capabilityProfileRef.revision === VIDU_Q1_T2V_PROFILE_REVISION &&
    plan.capabilityProfileRef.digest === VIDU_Q1_T2V_PROFILE_DIGEST;
  const historicalProfile =
    plan?.capabilityProfileRef.profileId === VIDU_Q1_T2V_HISTORICAL_PROFILE_ID &&
    plan.capabilityProfileRef.revision === VIDU_Q1_T2V_HISTORICAL_PROFILE_REVISION &&
    plan.capabilityProfileRef.digest === VIDU_Q1_T2V_HISTORICAL_PROFILE_DIGEST;
  if (
    !plan ||
    input.presetId !== "vidu" ||
    input.mode !== "text2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationScenario !== "text_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.adapterRevision !== VIDU_Q1_T2V_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== VIDU_Q1_T2V_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "vidu_enterprise" ||
    plan.providerRouteRef.modelId !== VIDU_Q1_T2V_MODEL_ID ||
    plan.providerRouteRef.endpointId !== VIDU_Q1_T2V_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "unknown" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    (!activeProfile && !historicalProfile)
  ) {
    return "The frozen Vidu route/profile does not match Q1 Text-to-Video.";
  }
  return input.prompt === plan.generationIntent.compiledPrompt
    ? null
    : "The runtime prompt does not match the frozen Vidu compiled prompt.";
}

function validateMappings(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan!;
  const fields = new Set([
    "scenario",
    "output.audio",
    "prompt",
    "output.durationSec",
    "output.aspectRatio",
    "output.resolution",
    "output.fps",
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        row.providerSlot !== undefined ||
        (row.providerField !== undefined && !fields.has(row.providerField)),
    )
  ) {
    return "The frozen Vidu plan contains an unimplemented provider mapping.";
  }
  for (const [path, providerField] of [
    ["generationScenario", "scenario"],
    ["outputAudioPolicy", "output.audio"],
    ["output.durationSec", "output.durationSec"],
    ["output.aspectRatio", "output.aspectRatio"],
    ["output.resolution", "output.resolution"],
  ] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping?.support !== "native" || mapping.providerField !== providerField) {
      return `Vidu ${path} was not frozen as an exact native mapping.`;
    }
  }
  const prompt = plan.constraintPlan.find((row) => row.intentPath === "compiledPrompt");
  if (prompt?.support !== "prompt" || prompt.providerField !== "prompt") {
    return "The Vidu prompt was not frozen as the compiled provider prompt.";
  }
  if (Object.keys(input.params ?? {}).length > 0) {
    return "Unplanned provider parameters are not accepted by the Vidu Q1 adapter.";
  }
  return null;
}

/** Compile one exact Vidu Q1 text2video request without passthrough. */
export function compileViduQ1T2vRequest(input: MediaGenRuntimeVendorInput): ViduQ1T2vCompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) {
    return fail(identityError);
  }
  const mappingError = validateMappings(input);
  if (mappingError) {
    return fail(mappingError);
  }

  const plan = input.frozenPlan!;
  const intent = plan.generationIntent;
  const output = intent.output;
  const ratio = output.aspectRatio;
  const fpsMapping = plan.constraintPlan.find((row) => row.intentPath === "output.fps");
  if (
    intent.generationScenario !== "text_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.compiledPrompt.trim().length === 0 ||
    intent.compiledPrompt.length > 5_000 ||
    intent.narrative.negativePrompt !== undefined ||
    intent.references.length !== 0 ||
    input.source !== undefined ||
    (input.sources?.length ?? 0) !== 0 ||
    output.shotCount !== 1 ||
    output.durationSec !== 5 ||
    input.durationSec !== 5 ||
    output.resolution !== "1080p" ||
    input.resolution !== "1080p" ||
    typeof ratio !== "string" ||
    !RATIOS.has(ratio as ViduQ1T2vCreateBody["aspect_ratio"]) ||
    (output.fps !== undefined &&
      (output.fps !== 24 ||
        fpsMapping?.support !== "native" ||
        fpsMapping.providerField !== "output.fps"))
  ) {
    return fail("The frozen Vidu output constraints are incomplete or unsupported.");
  }

  const body: ViduQ1T2vCreateBody = {
    model: VIDU_Q1_T2V_MODEL_ID,
    style: "general",
    prompt: intent.compiledPrompt,
    duration: 5,
    aspect_ratio: ratio as ViduQ1T2vCreateBody["aspect_ratio"],
    resolution: "1080p",
    bgm: false,
    movement_amplitude: "auto",
    off_peak: false,
  };
  const serialized = JSON.stringify(body);
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}
