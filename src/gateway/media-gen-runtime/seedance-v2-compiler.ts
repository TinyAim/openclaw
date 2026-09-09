import { createHash } from "node:crypto";
import type { MediaGenRuntimeSpatialInputEnvelope } from "../media-gen-runtime-http.js";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import { validateSeedanceV2MultimodalV5Intent } from "./seedance-v2-multimodal-v5.js";
import type {
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

export const SEEDANCE_V2_MODEL_ID = "doubao-seedance-2-0-260128";
export const SEEDANCE_V2_ADAPTER_REVISION = "openclaw-seedance-runtime/v2";
export const SEEDANCE_V2_ENDPOINT_ID = "ark.v3.contents.generations.tasks";
export const SEEDANCE_V2_ROUTE_IDS = {
  text2video: "volcengine.ark.seedance2.text2video",
  image2video: "volcengine.ark.seedance2.multimodal",
} as const;
export const SEEDANCE_V2_PROFILE_DIGESTS = {
  text2video: "sha256:bf9a22daab29e985f7d4298ee669a6ea4075e5ed89cc2baec922b06493411aa4",
  image2video: "sha256:5b400420fc13e0a375b4bc5cfaba4b5012f445959120c1a13759b3cfcf83b89b",
} as const;
export const SEEDANCE_V2_LEGACY_TEXT_PROFILE = {
  profileId: "seedance.openclaw-runtime.text2video.v3",
  revision: 3,
  digest: "sha256:1c8083cc0fb0c746a9b55169be2a65ee8fbb183110ed7cc89a2b6d67b3f4ec9d",
} as const;
export const SEEDANCE_V2_LEGACY_IMAGE_PROFILE = {
  profileId: "seedance.openclaw-runtime.multimodal.v3",
  revision: 3,
  digest: "sha256:b46900e086524ddda9b0ca2689dfd85cd56d6d628cd3e614850dbaa30f5fac43",
} as const;
export const SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4 = {
  profileId: "seedance.openclaw-runtime.multimodal.v4",
  revision: 4,
  digest: "sha256:9d47d6d7f5aff4706c2ed70ca4d81b763eca2fb2a6c24ddcbe8b50f8a0f76088",
} as const;

export type SeedanceV2Content =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string };
      role: "first_frame" | "last_frame" | "reference_image";
    }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

export type SeedanceV2CreateBody = {
  model: typeof SEEDANCE_V2_MODEL_ID;
  content: SeedanceV2Content[];
  generate_audio: boolean;
  ratio: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive";
  duration: number;
  resolution: "480p" | "720p" | "1080p" | "4k";
};

export type SeedanceV2CompileResult =
  | {
      ok: true;
      body: SeedanceV2CreateBody;
      providerRequestDigest: string;
      spatialInputEnvelope?: MediaGenRuntimeSpatialInputEnvelope;
    }
  | { ok: false; message: string };

const RATIOS = new Set<SeedanceV2CreateBody["ratio"]>([
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
  "adaptive",
]);
const RESOLUTIONS = new Set<SeedanceV2CreateBody["resolution"]>(["480p", "720p", "1080p", "4k"]);
const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
  "image/heic",
  "image/heif",
]);
const AUDIO_MIME = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"]);
const VIDEO_MIME = new Set(["video/mp4", "video/quicktime"]);
const V4_IMAGE_SCENARIOS = new Set([
  "first_frame_to_video",
  "first_last_frame_to_video",
  "subject_reference_to_video",
  "multimodal_reference_to_video",
]);
const V4_IMAGE_AUDIO_POLICIES = new Set(["silent", "native_generate"]);
const V4_IMAGE_REFERENCE_ROLES = new Set(["subject", "style", "first_frame", "last_frame"]);

function fail(message: string): SeedanceV2CompileResult {
  return { ok: false, message };
}

function normalizedSha(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const token = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/u.test(token) ? `sha256:${token}` : null;
}

function providerRef(value: string): string | null {
  if (/^asset:\/\/[a-zA-Z0-9._:/-]+$/u.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function dataUri(source: MediaGenRuntimeSource, mediaClass: "image" | "audio"): string | null {
  if (!source.bytes || source.bytes.length === 0) {
    return null;
  }
  const allowed = mediaClass === "image" ? IMAGE_MIME : AUDIO_MIME;
  if (!allowed.has(source.mimeType.toLowerCase())) {
    return null;
  }
  return `data:${source.mimeType.toLowerCase()};base64,${source.bytes.toString("base64")}`;
}

function correlateSources(
  input: MediaGenRuntimeVendorInput,
): { ok: true; slots: Map<string, MediaGenRuntimeSourceSlot> } | { ok: false; message: string } {
  const refs = input.frozenPlan?.generationIntent.references ?? [];
  if (input.source) {
    return { ok: false, message: "Adapter V2 requires typed reference slots." };
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
  for (const ref of refs) {
    if (!slots.has(`${ref.role}:${ref.ordinal}`)) {
      return { ok: false, message: "A frozen reference slot was not resolved." };
    }
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
  if (ref.mimeType && ref.mimeType.toLowerCase() !== mime) {
    return null;
  }
  if (ref.mediaClass === "image" && !IMAGE_MIME.has(mime)) {
    return null;
  }
  if (ref.mediaClass === "audio" && !AUDIO_MIME.has(mime)) {
    return null;
  }
  if (ref.mediaClass === "video" && !VIDEO_MIME.has(mime)) {
    return null;
  }
  if (ref.source.kind === "artifact" && source.providerRef) {
    return null;
  }
  if (source.providerRef) {
    return providerRef(source.providerRef);
  }
  if (ref.mediaClass === "video") {
    return null;
  }
  return dataUri(source, ref.mediaClass);
}

function contentFor(
  ref: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): SeedanceV2Content | null {
  const url = sourceUrl(ref, source);
  if (!url) {
    return null;
  }
  if (ref.mediaClass === "image") {
    const role =
      ref.role === "first_frame"
        ? "first_frame"
        : ref.role === "last_frame"
          ? "last_frame"
          : ref.role === "subject" || ref.role === "style"
            ? "reference_image"
            : null;
    return role ? { type: "image_url", image_url: { url }, role } : null;
  }
  if (ref.mediaClass === "video") {
    return ref.role === "source_video" || ref.role === "motion"
      ? { type: "video_url", video_url: { url }, role: "reference_video" }
      : null;
  }
  return ref.role === "voice"
    ? { type: "audio_url", audio_url: { url }, role: "reference_audio" }
    : null;
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  const activeProfile =
    input.mode === "text2video"
      ? {
          profileId: "seedance.openclaw-runtime.text2video.v4",
          revision: 4,
          digest: SEEDANCE_V2_PROFILE_DIGESTS.text2video,
        }
      : {
          profileId: "seedance.openclaw-runtime.multimodal.v5",
          revision: 5,
          digest: SEEDANCE_V2_PROFILE_DIGESTS.image2video,
        };
  const profileMatches = Boolean(
    plan &&
    ((plan.capabilityProfileRef.profileId === activeProfile.profileId &&
      plan.capabilityProfileRef.revision === activeProfile.revision &&
      plan.capabilityProfileRef.digest === activeProfile.digest) ||
      (input.mode === "text2video" &&
        plan.capabilityProfileRef.profileId === SEEDANCE_V2_LEGACY_TEXT_PROFILE.profileId &&
        plan.capabilityProfileRef.revision === SEEDANCE_V2_LEGACY_TEXT_PROFILE.revision &&
        plan.capabilityProfileRef.digest === SEEDANCE_V2_LEGACY_TEXT_PROFILE.digest) ||
      (input.mode === "image2video" &&
        plan.capabilityProfileRef.profileId === SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4.profileId &&
        plan.capabilityProfileRef.revision === SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4.revision &&
        plan.capabilityProfileRef.digest === SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4.digest) ||
      (input.mode === "image2video" &&
        plan.capabilityProfileRef.profileId === SEEDANCE_V2_LEGACY_IMAGE_PROFILE.profileId &&
        plan.capabilityProfileRef.revision === SEEDANCE_V2_LEGACY_IMAGE_PROFILE.revision &&
        plan.capabilityProfileRef.digest === SEEDANCE_V2_LEGACY_IMAGE_PROFILE.digest)),
  );
  if (
    !plan ||
    plan.presetId !== "seedance" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.adapterRevision !== SEEDANCE_V2_ADAPTER_REVISION ||
    plan.providerRouteRef.providerId !== "volcengine_ark" ||
    plan.providerRouteRef.modelId !== SEEDANCE_V2_MODEL_ID ||
    plan.providerRouteRef.endpointId !== SEEDANCE_V2_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "cn-beijing" ||
    plan.providerRouteRef.accountTier !== "online" ||
    plan.providerRouteRef.routeId !== SEEDANCE_V2_ROUTE_IDS[input.mode] ||
    !profileMatches
  ) {
    return "The frozen Seedance route/profile does not match Adapter V2.";
  }
  if (input.prompt !== plan.generationIntent.compiledPrompt) {
    return "The runtime prompt does not match the frozen compiled prompt.";
  }
  return null;
}

/**
 * Bind a Spatial receipt only to source slots which the compiler has already
 * checksum-verified and inserted into the native Seedance content array.
 */
function mappedSpatialInputEnvelope(
  input: MediaGenRuntimeVendorInput,
  slots: Map<string, MediaGenRuntimeSourceSlot>,
): MediaGenRuntimeSpatialInputEnvelope | null | undefined {
  const envelope = input.spatialInputEnvelope;
  if (!envelope) return undefined;
  if (!input.executionAttempt || !input.frozenPlanDigest) return null;
  const frozenReferences = input.frozenPlan!.generationIntent.references;
  for (const tuple of envelope.references) {
    const key = `${tuple.role}:${tuple.ordinal}`;
    const reference = frozenReferences.find((item) => `${item.role}:${item.ordinal}` === key);
    const slot = slots.get(key);
    const sourceChecksum = normalizedSha(slot?.source.sha256);
    if (
      !reference ||
      !slot ||
      slot.artifactId !== tuple.artifactId ||
      sourceChecksum !== tuple.checksum ||
      normalizedSha(reference.sourceDigest) !== tuple.checksum
    )
      return null;
  }
  return envelope;
}

/** Compile only documented Ark fields; `params` is validated, never forwarded. */
export function compileSeedanceV2Request(
  input: MediaGenRuntimeVendorInput,
): SeedanceV2CompileResult {
  const identityError = validateFrozenIdentity(input);
  if (identityError) {
    return fail(identityError);
  }
  const intent = input.frozenPlan!.generationIntent;
  const imageOnlyV4Profile =
    input.mode === "image2video" &&
    input.frozenPlan!.capabilityProfileRef.profileId === "seedance.openclaw-runtime.multimodal.v4";
  if (
    imageOnlyV4Profile &&
    (!V4_IMAGE_SCENARIOS.has(intent.generationScenario) ||
      !V4_IMAGE_AUDIO_POLICIES.has(intent.outputAudioPolicy) ||
      intent.references.some(
        (reference) =>
          reference.mediaClass !== "image" ||
          reference.durationSec !== undefined ||
          !V4_IMAGE_REFERENCE_ROLES.has(reference.role),
      ))
  ) {
    return fail("The frozen Seedance V4 profile does not claim this scenario or reference slot.");
  }
  const multimodalV5Profile =
    input.mode === "image2video" &&
    input.frozenPlan!.capabilityProfileRef.profileId === "seedance.openclaw-runtime.multimodal.v5";
  if (multimodalV5Profile) {
    const referenceError = validateSeedanceV2MultimodalV5Intent(intent);
    if (referenceError) return fail(referenceError);
  }
  const output = intent.output;
  if (
    output.shotCount !== 1 ||
    output.fps !== undefined ||
    typeof output.durationSec !== "number" ||
    !Number.isInteger(output.durationSec) ||
    output.durationSec < 4 ||
    output.durationSec > 15 ||
    !RATIOS.has(output.aspectRatio as SeedanceV2CreateBody["ratio"]) ||
    !RESOLUTIONS.has(output.resolution as SeedanceV2CreateBody["resolution"]) ||
    input.durationSec !== output.durationSec ||
    input.resolution !== output.resolution
  ) {
    return fail("The frozen Seedance output constraints are incomplete or unsupported.");
  }
  const paramKeys = Object.keys(input.params ?? {});
  if (
    paramKeys.some((key) => key !== "ratio") ||
    (input.params?.ratio !== undefined && input.params.ratio !== output.aspectRatio)
  ) {
    return fail("Unplanned provider parameters are not accepted by Adapter V2.");
  }
  if (intent.outputAudioPolicy === "preserve_source") {
    return fail("Seedance Adapter V2 does not claim preserve-source audio semantics.");
  }
  const correlated = correlateSources(input);
  if (!correlated.ok) {
    return fail(correlated.message);
  }
  const refs = intent.references;
  const imageCount = refs.filter((ref) => ref.mediaClass === "image").length;
  const videoCount = refs.filter((ref) => ref.mediaClass === "video").length;
  const audioCount = refs.filter((ref) => ref.mediaClass === "audio").length;
  const hasFrameRole = refs.some((ref) => ref.role === "first_frame" || ref.role === "last_frame");
  if (
    imageCount > 9 ||
    videoCount > 3 ||
    audioCount > 3 ||
    (audioCount > 0 && imageCount + videoCount === 0) ||
    (hasFrameRole && refs.some((ref) => ref.role !== "first_frame" && ref.role !== "last_frame")) ||
    (refs.some((ref) => ref.role === "last_frame") &&
      !refs.some((ref) => ref.role === "first_frame"))
  ) {
    return fail("The frozen reference set violates Seedance multimodal limits or exclusions.");
  }
  const content: SeedanceV2Content[] = [{ type: "text", text: intent.compiledPrompt }];
  for (const ref of refs) {
    const slot = correlated.slots.get(`${ref.role}:${ref.ordinal}`)!;
    const mapped = contentFor(ref, slot.source);
    if (!mapped) {
      return fail("A frozen reference cannot be mapped to the documented Seedance schema.");
    }
    content.push(mapped);
  }
  const spatialInputEnvelope = mappedSpatialInputEnvelope(input, correlated.slots);
  if (spatialInputEnvelope === null) {
    return fail("The Spatial envelope does not match the native Seedance source mapping.");
  }
  const body: SeedanceV2CreateBody = {
    model: SEEDANCE_V2_MODEL_ID,
    content,
    generate_audio: intent.outputAudioPolicy !== "silent",
    ratio: output.aspectRatio as SeedanceV2CreateBody["ratio"],
    duration: output.durationSec,
    resolution: output.resolution as SeedanceV2CreateBody["resolution"],
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
    ...(spatialInputEnvelope ? { spatialInputEnvelope } : {}),
  };
}
