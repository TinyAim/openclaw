import { createHash } from "node:crypto";
import type { MediaGenRuntimeVendorInput } from "./types.js";

export const WAN22_T2V_MODEL_ID = "wan2.2-t2v-plus";
export const WAN22_T2V_ADAPTER_REVISION = "openclaw-wan2.2-t2v-runtime/v2";
export const WAN22_T2V_ROUTE_ID = "wan.dashscope.cn_beijing.wan2_2_t2v_plus.text_to_video";
export const WAN22_T2V_ENDPOINT_ID = "dashscope.api.v1.video_generation.video_synthesis";
export const WAN22_T2V_PROFILE_ID = "wan.openclaw-runtime.wan2_2_t2v_plus.text2video.1080p.v2";
// Pinned to the server-owned CapabilityProfileRevision. The Control API digest
// test rejects any route/profile drift before an exact runtime can register.
export const WAN22_T2V_PROFILE_DIGEST =
  "sha256:b56b1f9a424588c1b5603188d7639b92c4fed29bda82d29c42421edffc4c3af0";

const SIZE_BY_RATIO: Readonly<Record<string, string>> = {
  "16:9": "1920*1080",
  "9:16": "1080*1920",
  "1:1": "1440*1440",
  "4:3": "1632*1248",
  "3:4": "1248*1632",
};

export type Wan22T2vCreateBody = {
  model: typeof WAN22_T2V_MODEL_ID;
  input: { prompt: string };
  parameters: {
    size: string;
    prompt_extend: false;
    watermark: false;
  };
};

export type Wan22T2vCompileResult =
  | { ok: true; body: Wan22T2vCreateBody; providerRequestDigest: string }
  | { ok: false; message: string };

function fail(message: string): Wan22T2vCompileResult {
  return { ok: false, message };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "wan" ||
    input.mode !== "text2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.adapterRevision !== WAN22_T2V_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== WAN22_T2V_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "dashscope" ||
    plan.providerRouteRef.modelId !== WAN22_T2V_MODEL_ID ||
    plan.providerRouteRef.endpointId !== WAN22_T2V_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "cn-beijing" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== WAN22_T2V_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 2 ||
    plan.capabilityProfileRef.digest !== WAN22_T2V_PROFILE_DIGEST
  ) {
    return "The frozen Wan route/profile does not match Wan 2.2 Text-to-Video.";
  }
  if (input.prompt !== plan.generationIntent.compiledPrompt) {
    return "The runtime prompt does not match the frozen Wan compiled prompt.";
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
        (row.providerField !== undefined && !allowedProviderFields.has(row.providerField)),
    )
  ) {
    return "The frozen Wan plan contains an unimplemented provider mapping.";
  }
  for (const path of ["output.durationSec", "output.aspectRatio", "output.resolution"] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping?.support !== "native" || mapping.providerField !== path) {
      return `Wan ${path} was not frozen as an exact native mapping.`;
    }
  }
  if (Object.keys(input.params ?? {}).length > 0) {
    return "Unplanned provider parameters are not accepted by the Wan adapter.";
  }
  return null;
}

/** Compile only the official DashScope Wan 2.2 legacy T2V request fields. */
export function compileWan22T2vRequest(input: MediaGenRuntimeVendorInput): Wan22T2vCompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) {
    return fail(identityError);
  }
  const mappingError = validateMappings(input);
  if (mappingError) {
    return fail(mappingError);
  }

  const intent = input.frozenPlan!.generationIntent;
  const prompt = intent.compiledPrompt;
  const ratio = intent.output.aspectRatio;
  const size = typeof ratio === "string" ? SIZE_BY_RATIO[ratio] : undefined;
  if (
    intent.generationScenario !== "text_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.output.shotCount !== 1 ||
    intent.output.durationSec !== 5 ||
    input.durationSec !== 5 ||
    intent.output.resolution !== "1080p" ||
    input.resolution !== "1080p" ||
    !size ||
    intent.output.fps !== undefined ||
    intent.narrative.negativePrompt !== undefined ||
    intent.references.length !== 0 ||
    input.source !== undefined ||
    (input.sources?.length ?? 0) !== 0 ||
    prompt.trim().length === 0 ||
    Array.from(prompt).length > 800
  ) {
    return fail("The frozen Wan output constraints are incomplete or unsupported.");
  }

  const body: Wan22T2vCreateBody = {
    model: WAN22_T2V_MODEL_ID,
    input: { prompt },
    parameters: {
      size,
      // The server already compiled the prompt. Disable provider-side rewriting
      // so Confirm and execution cannot silently diverge.
      prompt_extend: false,
      watermark: false,
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
