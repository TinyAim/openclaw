import { createHash } from "node:crypto";
import type { MediaGenRuntimeVendorInput } from "./types.js";
import {
  WAN_ASPECT_RATIO_PARTS,
  type WanAspectRatio,
  wanImageDataUri,
} from "./wan-image-source.js";

export const WAN22_I2V_MODEL_ID = "wan2.2-i2v-plus";
export const WAN22_I2V_ADAPTER_REVISION = "openclaw-wan2.2-i2v-runtime/v1";
export const WAN22_I2V_ROUTE_ID = "wan.dashscope.cn_beijing.wan2_2_i2v_plus.first_frame_to_video";
export const WAN22_I2V_ENDPOINT_ID = "dashscope.api.v1.video_generation.video_synthesis";
export const WAN22_I2V_PROFILE_ID =
  "wan.openclaw-runtime.wan2_2_i2v_plus.first_frame_to_video.1080p.v1";
// Pinned to the server-owned CapabilityProfileRevision. The Control API digest
// test rejects route/profile drift before this paid adapter can register.
export const WAN22_I2V_PROFILE_DIGEST =
  "sha256:588eecd6645bde4f315d0854e533d8227d577c1864c5faa2f9730f7dd0717fd1";

export type Wan22I2vCreateBody = {
  model: typeof WAN22_I2V_MODEL_ID;
  input: { prompt: string; img_url: string };
  parameters: {
    resolution: "1080P";
    prompt_extend: false;
    watermark: true;
  };
};

export type Wan22I2vCompileResult =
  | { ok: true; body: Wan22I2vCreateBody; providerRequestDigest: string }
  | { ok: false; message: string };

function fail(message: string): Wan22I2vCompileResult {
  return { ok: false, message };
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "wan" ||
    input.mode !== "image2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationScenario !== "first_frame_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.adapterRevision !== WAN22_I2V_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== WAN22_I2V_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "dashscope" ||
    plan.providerRouteRef.modelId !== WAN22_I2V_MODEL_ID ||
    plan.providerRouteRef.endpointId !== WAN22_I2V_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "cn-beijing" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== WAN22_I2V_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 1 ||
    plan.capabilityProfileRef.digest !== WAN22_I2V_PROFILE_DIGEST
  ) {
    return "The frozen Wan route/profile does not match Wan 2.2 first-frame Image-to-Video.";
  }
  return input.prompt === plan.generationIntent.compiledPrompt
    ? null
    : "The runtime prompt does not match the frozen Wan compiled prompt.";
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
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        (row.providerSlot !== undefined && row.providerSlot !== "references.first_frame") ||
        (row.providerField !== undefined && !fields.has(row.providerField)) ||
        (row.required && row.support === "unsupported"),
    )
  ) {
    return "The frozen Wan plan contains an unimplemented provider mapping.";
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
      return `Wan ${path} was not frozen as an exact native mapping.`;
    }
  }
  const prompt = plan.constraintPlan.find((row) => row.intentPath === "compiledPrompt");
  if (prompt?.support !== "prompt" || prompt.providerField !== "prompt") {
    return "The Wan prompt was not frozen as the compiled provider prompt.";
  }
  const frame = plan.constraintPlan.find((row) => row.intentPath === "references.first_frame.0");
  if (frame?.support !== "native" || frame.providerSlot !== "references.first_frame") {
    return "The Wan first frame was not frozen as an exact native slot.";
  }
  return Object.keys(input.params ?? {}).length === 0
    ? null
    : "Unplanned provider parameters are not accepted by the Wan adapter.";
}

/** Compile one exact official DashScope Wan 2.2 first-frame request. */
export function compileWan22I2vRequest(input: MediaGenRuntimeVendorInput): Wan22I2vCompileResult {
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
  const promptLength = Array.from(intent.compiledPrompt).length;
  if (
    intent.generationScenario !== "first_frame_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.output.shotCount !== 1 ||
    intent.output.durationSec !== 5 ||
    input.durationSec !== 5 ||
    typeof ratio !== "string" ||
    !(ratio in WAN_ASPECT_RATIO_PARTS) ||
    intent.output.resolution !== "1080p" ||
    input.resolution !== "1080p" ||
    intent.output.fps !== undefined ||
    intent.output.qualityIntent !== undefined ||
    intent.narrative.negativePrompt !== undefined ||
    promptLength < 1 ||
    promptLength > 800 ||
    intent.compiledPrompt.trim().length === 0 ||
    input.source !== undefined
  ) {
    return fail("The frozen Wan output constraints are incomplete or unsupported.");
  }

  const references = intent.references;
  const sources = input.sources ?? [];
  if (
    references.length !== 1 ||
    sources.length !== 1 ||
    references[0]?.role !== "first_frame" ||
    references[0]?.ordinal !== 0 ||
    sources[0]?.role !== "first_frame" ||
    sources[0]?.ordinal !== 0
  ) {
    return fail("Wan 2.2 Image-to-Video requires exactly one typed first frame.");
  }
  const imageUrl = wanImageDataUri({
    reference: references[0],
    source: sources[0].source,
    role: "first_frame",
    expectedRatio: ratio as WanAspectRatio,
  });
  if (!imageUrl) {
    return fail(
      "The frozen Wan first frame failed authority, MIME, size, dimensions, ratio, or digest verification.",
    );
  }

  const body: Wan22I2vCreateBody = {
    model: WAN22_I2V_MODEL_ID,
    input: { prompt: intent.compiledPrompt, img_url: imageUrl },
    parameters: {
      resolution: "1080P",
      // The server already compiled the prompt. Disable provider rewriting so
      // Confirm and paid execution cannot silently diverge.
      prompt_extend: false,
      watermark: true,
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
