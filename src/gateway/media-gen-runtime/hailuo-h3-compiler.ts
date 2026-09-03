import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type {
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

export const HAILUO_H3_MODEL_ID = "MiniMax-H3";
export const HAILUO_H3_ADAPTER_REVISION = "openclaw-hailuo-h3-runtime/v2";
export const HAILUO_H3_ROUTE_ID = "hailuo.minimax.global.h3.multimodal_reference_to_video";
export const HAILUO_H3_ENDPOINT_ID = "minimax.v2.video_generation";
export const HAILUO_H3_PROFILE_ID = "hailuo.openclaw-runtime.h3.multimodal_reference.v2";
export const HAILUO_H3_PROFILE_DIGEST =
  "sha256:bc93ed67d70699875913ac4caa51747ef8768448f6350051482d09c98e7d466d";

type HailuoH3ReferenceContent =
  | { type: "image_url"; image_url: { url: string }; role: "reference_image" }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

export type HailuoH3CreateBody = {
  model: typeof HAILUO_H3_MODEL_ID;
  content: [{ type: "text"; text: string }, ...HailuoH3ReferenceContent[]];
  resolution: "2K";
  duration: number;
  ratio: "adaptive" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
};

export type HailuoH3CompileResult =
  | { ok: true; body: HailuoH3CreateBody; providerRequestDigest: string }
  | { ok: false; message: string };

const RATIOS = new Set<HailuoH3CreateBody["ratio"]>([
  "adaptive",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const VIDEO_MIME = new Set(["video/mp4", "video/quicktime"]);
const AUDIO_MIME = new Set(["audio/wav", "audio/x-wav", "audio/mpeg"]);
const MAX_BYTES = {
  image: 30_000_000,
  video: 50_000_000,
  audio: 15_000_000,
} as const;
const MAX_BODY_BYTES = 64_000_000;

function fail(message: string): HailuoH3CompileResult {
  return { ok: false, message };
}

function normalizedSha(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const token = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/u.test(token) ? `sha256:${token}` : null;
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function correlateSources(
  input: MediaGenRuntimeVendorInput,
): { ok: true; slots: Map<string, MediaGenRuntimeSourceSlot> } | { ok: false; message: string } {
  const refs = input.frozenPlan?.generationIntent.references ?? [];
  if (input.source) {
    return { ok: false, message: "MiniMax H3 requires typed reference slots." };
  }
  const sources = input.sources ?? [];
  if (sources.length !== refs.length) {
    return { ok: false, message: "Resolved reference count does not match the frozen plan." };
  }
  const slots = new Map<string, MediaGenRuntimeSourceSlot>();
  for (const source of sources) {
    const key = `${source.role}:${source.ordinal}`;
    if (slots.has(key)) {
      return { ok: false, message: "Resolved reference slots are not unique." };
    }
    slots.set(key, source);
  }
  if (refs.some((ref) => !slots.has(`${ref.role}:${ref.ordinal}`))) {
    return { ok: false, message: "A frozen reference slot was not resolved." };
  }
  return { ok: true, slots };
}

function sourceUrl(
  ref: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): string | null {
  const expectedSha = normalizedSha(ref.sourceDigest);
  const actualSha = normalizedSha(source.sha256);
  if (!expectedSha || actualSha !== expectedSha) {
    return null;
  }
  const mime = source.mimeType.toLowerCase();
  const allowed =
    ref.mediaClass === "image" ? IMAGE_MIME : ref.mediaClass === "video" ? VIDEO_MIME : AUDIO_MIME;
  if (!allowed.has(mime)) {
    return null;
  }
  if (source.providerRef) {
    return ref.source.kind === "runtime_local" ? httpsUrl(source.providerRef) : null;
  }
  if (
    !source.bytes ||
    source.bytes.length === 0 ||
    source.bytes.length > MAX_BYTES[ref.mediaClass]
  ) {
    return null;
  }
  if (ref.mediaClass === "video" && mime !== "video/mp4") {
    return null;
  }
  const providerMime =
    mime === "audio/mpeg" ? "audio/mp3" : mime === "audio/x-wav" ? "audio/wav" : mime;
  return `data:${providerMime};base64,${source.bytes.toString("base64")}`;
}

function referenceContent(
  ref: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): HailuoH3ReferenceContent | null {
  const url = sourceUrl(ref, source);
  if (!url) {
    return null;
  }
  if (ref.mediaClass === "image" && (ref.role === "subject" || ref.role === "style")) {
    return { type: "image_url", image_url: { url }, role: "reference_image" };
  }
  if (ref.mediaClass === "video" && (ref.role === "motion" || ref.role === "source_video")) {
    return { type: "video_url", video_url: { url }, role: "reference_video" };
  }
  return ref.mediaClass === "audio" && ref.role === "voice"
    ? { type: "audio_url", audio_url: { url }, role: "reference_audio" }
    : null;
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "hailuo" ||
    input.mode !== "image2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationScenario !== "multimodal_reference_to_video" ||
    plan.outputAudioPolicy !== "reference_conditioned" ||
    plan.adapterRevision !== HAILUO_H3_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== HAILUO_H3_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "minimax" ||
    plan.providerRouteRef.modelId !== HAILUO_H3_MODEL_ID ||
    plan.providerRouteRef.endpointId !== HAILUO_H3_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "global" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== HAILUO_H3_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 2 ||
    plan.capabilityProfileRef.digest !== HAILUO_H3_PROFILE_DIGEST
  ) {
    return "The frozen Hailuo route/profile does not match MiniMax H3 reference-to-video.";
  }
  return input.prompt === plan.generationIntent.compiledPrompt
    ? null
    : "The runtime prompt does not match the frozen Hailuo compiled prompt.";
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
  const slots = new Set([
    "references.subject",
    "references.style",
    "references.motion",
    "references.source_video",
    "references.voice",
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        (row.providerField !== undefined && !fields.has(row.providerField)) ||
        (row.providerSlot !== undefined && !slots.has(row.providerSlot)),
    )
  ) {
    return "The frozen Hailuo plan contains an unimplemented provider mapping.";
  }
  for (const path of ["output.durationSec", "output.aspectRatio", "output.resolution"] as const) {
    const mapping = plan.constraintPlan.find((row) => row.intentPath === path);
    if (mapping?.support !== "native" || mapping.providerField !== path) {
      return `Hailuo ${path} was not frozen as an exact native mapping.`;
    }
  }
  const prompt = plan.constraintPlan.find((row) => row.intentPath === "compiledPrompt");
  if (prompt?.support !== "prompt" || prompt.providerField !== "prompt") {
    return "The Hailuo prompt was not frozen as the compiled provider prompt.";
  }
  for (const ref of plan.generationIntent.references) {
    const mapping = plan.constraintPlan.find(
      (row) => row.intentPath === `references.${ref.role}.${ref.ordinal}`,
    );
    if (mapping?.support !== "native" || mapping.providerSlot !== `references.${ref.role}`) {
      return "A Hailuo reference was not frozen as an exact native slot.";
    }
  }
  return Object.keys(input.params ?? {}).length === 0
    ? null
    : "Unplanned provider parameters are not accepted by the Hailuo H3 adapter.";
}

/** Compile one official MiniMax H3 reference-to-video request, without passthrough. */
export function compileHailuoH3Request(input: MediaGenRuntimeVendorInput): HailuoH3CompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) {
    return fail(identityError);
  }
  const mappingError = validateMappings(input);
  if (mappingError) {
    return fail(mappingError);
  }

  const intent = input.frozenPlan!.generationIntent;
  const output = intent.output;
  if (
    intent.compiledPrompt.trim().length === 0 ||
    intent.compiledPrompt.length > 7000 ||
    intent.narrative.negativePrompt !== undefined ||
    output.shotCount !== 1 ||
    output.fps !== undefined ||
    typeof output.durationSec !== "number" ||
    !Number.isInteger(output.durationSec) ||
    output.durationSec < 4 ||
    output.durationSec > 15 ||
    input.durationSec !== output.durationSec ||
    output.resolution !== "2K" ||
    input.resolution !== "2K" ||
    !RATIOS.has(output.aspectRatio as HailuoH3CreateBody["ratio"])
  ) {
    return fail("The frozen Hailuo output constraints are incomplete or unsupported.");
  }

  const refs = intent.references;
  const imageCount = refs.filter((ref) => ref.mediaClass === "image").length;
  const videoCount = refs.filter((ref) => ref.mediaClass === "video").length;
  const audioCount = refs.filter((ref) => ref.mediaClass === "audio").length;
  const timedReferences = refs.filter((ref) => ref.mediaClass !== "image");
  const videoDurationSec = timedReferences
    .filter((ref) => ref.mediaClass === "video")
    .reduce((total, ref) => total + (ref.durationSec ?? 0), 0);
  const audioDurationSec = timedReferences
    .filter((ref) => ref.mediaClass === "audio")
    .reduce((total, ref) => total + (ref.durationSec ?? 0), 0);
  if (
    refs.length < 2 ||
    refs.length > 12 ||
    imageCount > 9 ||
    videoCount > 3 ||
    audioCount < 1 ||
    audioCount > 3 ||
    imageCount + videoCount < 1 ||
    timedReferences.some(
      (ref) =>
        typeof ref.durationSec !== "number" ||
        !Number.isFinite(ref.durationSec) ||
        ref.durationSec < 2 ||
        ref.durationSec > 15,
    ) ||
    videoDurationSec > 15 ||
    audioDurationSec > 15 ||
    refs.some((ref) => ref.mediaClass === "audio" && ref.role !== "voice")
  ) {
    return fail("The frozen references violate MiniMax H3 reference-to-video limits.");
  }
  const correlated = correlateSources(input);
  if (!correlated.ok) {
    return fail(correlated.message);
  }
  const content: HailuoH3CreateBody["content"] = [{ type: "text", text: intent.compiledPrompt }];
  for (const ref of refs) {
    const mapped = referenceContent(
      ref,
      correlated.slots.get(`${ref.role}:${ref.ordinal}`)!.source,
    );
    if (!mapped) {
      return fail("A frozen reference cannot be mapped to the documented MiniMax H3 schema.");
    }
    content.push(mapped);
  }
  const body: HailuoH3CreateBody = {
    model: HAILUO_H3_MODEL_ID,
    content,
    resolution: "2K",
    duration: output.durationSec,
    ratio: output.aspectRatio as HailuoH3CreateBody["ratio"],
  };
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
    return fail("The MiniMax H3 request body exceeds the documented 64 MB limit.");
  }
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}
