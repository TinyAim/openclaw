import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type { MediaGenRuntimeSourceSlot, MediaGenRuntimeVendorInput } from "./types.js";
import {
  WAN_ASPECT_RATIO_PARTS,
  type WanAspectRatio,
  wanImageDataUri,
} from "./wan-image-source.js";

export const WAN22_FIRST_LAST_MODEL_ID = "wan2.2-kf2v-flash";
export const WAN22_FIRST_LAST_ADAPTER_REVISION = "openclaw-wan2.2-kf2v-runtime/v1";
export const WAN22_FIRST_LAST_ROUTE_ID =
  "wan.dashscope.cn_beijing.wan2_2_kf2v_flash.first_last_frame_to_video";
export const WAN22_FIRST_LAST_ENDPOINT_ID = "dashscope.api.v1.image2video.video_synthesis";
export const WAN22_FIRST_LAST_PROFILE_ID =
  "wan.openclaw-runtime.wan2_2_kf2v_flash.first_last_frame_to_video.1080p.v1";
export const WAN22_FIRST_LAST_PROFILE_DIGEST =
  "sha256:57b7e56a605441ef621a63a1752f0bbc07ef7a10bfa589d923310d55b779210f";

export type Wan22FirstLastCreateBody = {
  model: typeof WAN22_FIRST_LAST_MODEL_ID;
  input: { prompt: string; first_frame_url: string; last_frame_url: string };
  parameters: {
    resolution: "1080P";
    prompt_extend: false;
    watermark: true;
  };
};

export type Wan22FirstLastCompileResult =
  | { ok: true; body: Wan22FirstLastCreateBody; providerRequestDigest: string }
  | { ok: false; message: string };

function fail(message: string): Wan22FirstLastCompileResult {
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
    plan.generationScenario !== "first_last_frame_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.adapterRevision !== WAN22_FIRST_LAST_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== WAN22_FIRST_LAST_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "dashscope" ||
    plan.providerRouteRef.modelId !== WAN22_FIRST_LAST_MODEL_ID ||
    plan.providerRouteRef.endpointId !== WAN22_FIRST_LAST_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "cn-beijing" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== WAN22_FIRST_LAST_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 1 ||
    plan.capabilityProfileRef.digest !== WAN22_FIRST_LAST_PROFILE_DIGEST
  ) {
    return "The frozen Wan route/profile does not match Wan 2.2 first/last-frame generation.";
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
  const slots = new Set(["references.first_frame", "references.last_frame"]);
  if (
    plan.constraintPlan.some(
      (row) =>
        (row.providerSlot !== undefined && !slots.has(row.providerSlot)) ||
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
  for (const role of ["first_frame", "last_frame"] as const) {
    const frame = plan.constraintPlan.find((row) => row.intentPath === `references.${role}.0`);
    if (frame?.support !== "native" || frame.providerSlot !== `references.${role}`) {
      return `The Wan ${role} was not frozen as an exact native slot.`;
    }
  }
  return Object.keys(input.params ?? {}).length === 0
    ? null
    : "Unplanned provider parameters are not accepted by the Wan adapter.";
}

function correlateSources(
  references: readonly MediaGenerationIntentReference[],
  sources: readonly MediaGenRuntimeSourceSlot[],
): Map<string, MediaGenRuntimeSourceSlot> | null {
  if (sources.length !== references.length) {
    return null;
  }
  const slots = new Map<string, MediaGenRuntimeSourceSlot>();
  for (const source of sources) {
    const key = `${source.role}:${source.ordinal}`;
    if (slots.has(key)) {
      return null;
    }
    slots.set(key, source);
  }
  return references.every((reference) => slots.has(`${reference.role}:${reference.ordinal}`))
    ? slots
    : null;
}

/** Compile one exact official DashScope Wan 2.2 first/last-frame request. */
export function compileWan22FirstLastRequest(
  input: MediaGenRuntimeVendorInput,
): Wan22FirstLastCompileResult {
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
    intent.generationScenario !== "first_last_frame_to_video" ||
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
  const firstFrame = references.find((reference) => reference.role === "first_frame");
  const lastFrame = references.find((reference) => reference.role === "last_frame");
  if (
    references.length !== 2 ||
    !firstFrame ||
    !lastFrame ||
    firstFrame.ordinal !== 0 ||
    lastFrame.ordinal !== 0
  ) {
    return fail("Wan 2.2 first/last-frame requires exactly one typed frame per role.");
  }
  const sources = correlateSources(references, input.sources ?? []);
  if (!sources) {
    return fail("Resolved Wan frame slots do not match the frozen plan.");
  }
  const firstFrameUrl = wanImageDataUri({
    reference: firstFrame,
    source: sources.get("first_frame:0")!.source,
    role: "first_frame",
    expectedRatio: ratio as WanAspectRatio,
  });
  const lastFrameUrl = wanImageDataUri({
    reference: lastFrame,
    source: sources.get("last_frame:0")!.source,
    role: "last_frame",
  });
  if (!firstFrameUrl || !lastFrameUrl) {
    return fail(
      "A frozen Wan frame failed authority, MIME, size, dimensions, ratio, or digest verification.",
    );
  }

  const body: Wan22FirstLastCreateBody = {
    model: WAN22_FIRST_LAST_MODEL_ID,
    input: {
      prompt: intent.compiledPrompt,
      first_frame_url: firstFrameUrl,
      last_frame_url: lastFrameUrl,
    },
    parameters: {
      resolution: "1080P",
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
