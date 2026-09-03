import { createHash } from "node:crypto";
import type { MediaGenRuntimeVendorInput } from "./types.js";

export const VEO31_T2V_MODEL_ID = "veo-3.1-generate-001";
export const VEO31_T2V_ADAPTER_REVISION = "openclaw-veo3.1-t2v-runtime/v1";
export const VEO31_T2V_ROUTE_ID = "veo.vertex_ai.us_central1.veo_3_1_generate_001.text_to_video";
export const VEO31_T2V_ENDPOINT_ID = "aiplatform.v1.predictLongRunning";
export const VEO31_T2V_PROFILE_ID = "veo.openclaw-runtime.veo3_1_generate_001.text2video.v2";
// Updated from the server-owned CapabilityProfileRevision after focused digest
// validation. Any route/profile drift is rejected before provider submission.
export const VEO31_T2V_PROFILE_DIGEST =
  "sha256:36471bc16e65076aa447f34a54305030045c7827307a51dc90f84f2c2b31941e";

const DURATIONS = new Set([4, 6, 8]);
const RATIOS = new Set(["16:9", "9:16"]);
const RESOLUTIONS = new Set(["720p", "1080p"]);

export type Veo31T2vCreateBody = {
  instances: [{ prompt: string }];
  parameters: {
    aspectRatio: "16:9" | "9:16";
    durationSeconds: 4 | 6 | 8;
    enhancePrompt: true;
    generateAudio: false;
    personGeneration: "allow_adult";
    resolution: "720p" | "1080p";
    sampleCount: 1;
  };
};

export type Veo31T2vCompileResult =
  | { ok: true; body: Veo31T2vCreateBody; providerRequestDigest: string }
  | { ok: false; message: string };

function fail(message: string): Veo31T2vCompileResult {
  return { ok: false, message };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "veo" ||
    input.mode !== "text2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationScenario !== "text_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.adapterRevision !== VEO31_T2V_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== VEO31_T2V_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "google_vertex_ai" ||
    plan.providerRouteRef.modelId !== VEO31_T2V_MODEL_ID ||
    plan.providerRouteRef.endpointId !== VEO31_T2V_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "us-central1" ||
    plan.providerRouteRef.accountTier !== "adc" ||
    plan.capabilityProfileRef.profileId !== VEO31_T2V_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 2 ||
    plan.capabilityProfileRef.digest !== VEO31_T2V_PROFILE_DIGEST
  ) {
    return "The frozen Veo route/profile does not match Veo 3.1 Text-to-Video.";
  }
  if (input.prompt !== plan.generationIntent.compiledPrompt) {
    return "The runtime prompt does not match the frozen Veo compiled prompt.";
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
    "output.fps",
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        row.providerSlot !== undefined ||
        (row.providerField !== undefined && !allowedProviderFields.has(row.providerField)),
    )
  ) {
    return "The frozen Veo plan contains an unimplemented provider mapping.";
  }
  for (const path of ["output.durationSec", "output.aspectRatio", "output.resolution"] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping?.support !== "native" || mapping.providerField !== path) {
      return `Veo ${path} was not frozen as an exact native mapping.`;
    }
  }
  const prompt = plan.constraintPlan.find((row) => row.intentPath === "compiledPrompt");
  if (prompt?.support !== "prompt" || prompt.providerField !== "prompt") {
    return "The Veo prompt was not frozen as the compiled provider prompt.";
  }
  if (Object.keys(input.params ?? {}).length > 0) {
    return "Unplanned provider parameters are not accepted by the Veo adapter.";
  }
  return null;
}

/** Compile only the official Vertex AI Veo 3.1 GA text-to-video fields. */
export function compileVeo31T2vRequest(input: MediaGenRuntimeVendorInput): Veo31T2vCompileResult {
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
  const ratio = intent.output.aspectRatio;
  const resolution = intent.output.resolution;
  const fpsMapping =
    intent.output.fps === undefined
      ? undefined
      : input.frozenPlan!.constraintPlan.find((row) => row.intentPath === "output.fps");
  if (
    intent.generationScenario !== "text_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.output.shotCount !== 1 ||
    typeof duration !== "number" ||
    !DURATIONS.has(duration) ||
    input.durationSec !== duration ||
    typeof ratio !== "string" ||
    !RATIOS.has(ratio) ||
    typeof resolution !== "string" ||
    !RESOLUTIONS.has(resolution) ||
    input.resolution !== resolution ||
    (intent.output.fps !== undefined &&
      (intent.output.fps !== 24 ||
        fpsMapping?.support !== "native" ||
        fpsMapping.providerField !== "output.fps")) ||
    intent.narrative.negativePrompt !== undefined ||
    intent.references.length !== 0 ||
    input.source !== undefined ||
    (input.sources?.length ?? 0) !== 0 ||
    intent.compiledPrompt.trim().length === 0
  ) {
    return fail("The frozen Veo output constraints are incomplete or unsupported.");
  }

  const body: Veo31T2vCreateBody = {
    instances: [{ prompt: intent.compiledPrompt }],
    parameters: {
      aspectRatio: ratio as "16:9" | "9:16",
      durationSeconds: duration as 4 | 6 | 8,
      // Veo 3.1 does not allow disabling its documented prompt rewriter. Pin
      // the behavior explicitly rather than inheriting a mutable default.
      enhancePrompt: true,
      generateAudio: false,
      personGeneration: "allow_adult",
      resolution: resolution as "720p" | "1080p",
      sampleCount: 1,
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
