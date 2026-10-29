import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type {
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

export const KLING_IMAGE2VIDEO_V2_MODEL_ID = "kling-v1";
export const KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION = "openclaw-kling-image2video-runtime/v2";
export const KLING_IMAGE2VIDEO_V2_ROUTE_ID = "kling.open.global.image2video.v1";
export const KLING_IMAGE2VIDEO_V2_ENDPOINT_ID = "kling.v1.videos.image2video";
export const KLING_IMAGE2VIDEO_V2_PROFILE_ID = "kling.openclaw-runtime.image2video.v3";
export const KLING_IMAGE2VIDEO_V2_PROFILE_DIGEST =
  "sha256:5fee787dc70949595b79682888d0aaab7c15c74af540ab457bbea774019d5e8d";

export type KlingImage2VideoV2CreateBody = {
  model_name: typeof KLING_IMAGE2VIDEO_V2_MODEL_ID;
  image: string;
  image_tail?: string;
  prompt: string;
  duration: "5" | "10";
};

export type KlingImage2VideoV2CompileResult =
  | {
      ok: true;
      body: KlingImage2VideoV2CreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
  "image/heic",
  "image/heif",
]);

function fail(message: string): KlingImage2VideoV2CompileResult {
  return { ok: false, message };
}

function normalizedSha256(value: string | undefined): string | null {
  if (!value) return null;
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/u.test(hex) ? hex : null;
}

function correlateSources(
  input: MediaGenRuntimeVendorInput,
): { ok: true; slots: Map<string, MediaGenRuntimeSourceSlot> } | { ok: false; message: string } {
  const references = input.frozenPlan?.generationIntent.references ?? [];
  if (input.source) {
    return { ok: false, message: "Kling Adapter V2 requires typed reference slots." };
  }
  const sources = input.sources ?? [];
  if (sources.length !== references.length) {
    return {
      ok: false,
      message: "Resolved Kling reference count does not match the frozen plan.",
    };
  }
  const slots = new Map<string, MediaGenRuntimeSourceSlot>();
  for (const source of sources) {
    const key = `${source.role}:${source.ordinal}`;
    if (slots.has(key)) {
      return { ok: false, message: "Resolved Kling reference slots are not unique." };
    }
    slots.set(key, source);
  }
  for (const reference of references) {
    if (!slots.has(`${reference.role}:${reference.ordinal}`)) {
      return { ok: false, message: "A frozen Kling reference slot was not resolved." };
    }
  }
  return { ok: true, slots };
}

function imageBase64(
  reference: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): string | null {
  if (
    reference.mediaClass !== "image" ||
    reference.authorityVerified !== true ||
    !source.bytes ||
    source.bytes.length === 0 ||
    source.providerRef
  )
    return null;
  const mimeType = source.mimeType.toLowerCase();
  if (
    !IMAGE_MIME_TYPES.has(mimeType) ||
    (reference.mimeType !== undefined && reference.mimeType.toLowerCase() !== mimeType)
  )
    return null;
  const expectedSha256 = normalizedSha256(reference.sourceDigest);
  const resolvedSha256 = normalizedSha256(source.sha256);
  const actualSha256 = createHash("sha256").update(source.bytes).digest("hex");
  if (!expectedSha256 || resolvedSha256 !== expectedSha256 || actualSha256 !== expectedSha256)
    return null;
  return source.bytes.toString("base64");
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "kling" ||
    input.mode !== "image2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.adapterRevision !== KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== KLING_IMAGE2VIDEO_V2_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "kling_open_platform" ||
    plan.providerRouteRef.modelId !== KLING_IMAGE2VIDEO_V2_MODEL_ID ||
    plan.providerRouteRef.endpointId !== KLING_IMAGE2VIDEO_V2_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "global" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== KLING_IMAGE2VIDEO_V2_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 3 ||
    plan.capabilityProfileRef.digest !== KLING_IMAGE2VIDEO_V2_PROFILE_DIGEST
  ) {
    return "The frozen Kling route/profile does not match Image2Video Adapter V2.";
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
  ]);
  const allowedProviderSlots = new Set(["references.first_frame", "references.last_frame"]);
  if (
    plan.constraintPlan.some(
      (row) =>
        (row.providerField !== undefined && !allowedProviderFields.has(row.providerField)) ||
        (row.providerSlot !== undefined && !allowedProviderSlots.has(row.providerSlot)),
    )
  ) {
    return "The frozen Kling plan contains an unimplemented provider mapping.";
  }
  const duration = plan.constraintPlan.find((row) => row.intentPath === "output.durationSec");
  if (duration?.support !== "native" || duration.providerField !== "output.durationSec") {
    return "Kling duration was not frozen as an exact native mapping.";
  }
  for (const path of ["output.aspectRatio", "output.resolution", "output.fps"]) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping && (mapping.support !== "approximate" || mapping.providerField !== undefined)) {
      return "An unverified Kling output field was marked as provider-native.";
    }
  }
  if (Object.keys(input.params ?? {}).length > 0) {
    return "Unplanned provider parameters are not accepted by Kling Adapter V2.";
  }
  return null;
}

/** Compile only fields evidenced by Kling's current official Image2Video class. */
export function compileKlingImage2VideoV2Request(
  input: MediaGenRuntimeVendorInput,
): KlingImage2VideoV2CompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) return fail(identityError);
  const mappingError = validateMappings(input);
  if (mappingError) return fail(mappingError);
  const intent = input.frozenPlan!.generationIntent;
  if (
    intent.outputAudioPolicy !== "silent" ||
    !["first_frame_to_video", "first_last_frame_to_video"].includes(intent.generationScenario) ||
    intent.output.shotCount !== 1 ||
    intent.output.fps !== undefined ||
    (intent.output.durationSec !== 5 && intent.output.durationSec !== 10) ||
    input.durationSec !== intent.output.durationSec ||
    (input.resolution !== undefined && input.resolution !== intent.output.resolution)
  ) {
    return fail("The frozen Kling output constraints are incomplete or unsupported.");
  }
  const references = intent.references;
  const firstFrames = references.filter((item) => item.role === "first_frame");
  const lastFrames = references.filter((item) => item.role === "last_frame");
  if (
    firstFrames.length !== 1 ||
    lastFrames.length > 1 ||
    references.length !== firstFrames.length + lastFrames.length ||
    (intent.generationScenario === "first_frame_to_video" && lastFrames.length !== 0) ||
    (intent.generationScenario === "first_last_frame_to_video" && lastFrames.length !== 1)
  ) {
    return fail("The frozen Kling frame roles do not match the generation scenario.");
  }
  const correlated = correlateSources(input);
  if (!correlated.ok) return fail(correlated.message);
  const firstFrame = firstFrames[0]!;
  const firstSource = correlated.slots.get(`${firstFrame.role}:${firstFrame.ordinal}`)!.source;
  const image = imageBase64(firstFrame, firstSource);
  if (!image) {
    return fail("The frozen Kling first frame failed MIME or digest verification.");
  }
  let imageTail: string | undefined;
  if (lastFrames[0]) {
    const lastFrame = lastFrames[0];
    const lastSource = correlated.slots.get(`${lastFrame.role}:${lastFrame.ordinal}`)!.source;
    imageTail = imageBase64(lastFrame, lastSource) ?? undefined;
    if (!imageTail) {
      return fail("The frozen Kling last frame failed MIME or digest verification.");
    }
  }
  const body: KlingImage2VideoV2CreateBody = {
    model_name: KLING_IMAGE2VIDEO_V2_MODEL_ID,
    image,
    ...(imageTail ? { image_tail: imageTail } : {}),
    prompt: intent.compiledPrompt,
    duration: String(intent.output.durationSec) as "5" | "10",
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")}`,
  };
}
