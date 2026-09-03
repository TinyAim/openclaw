import type { MediaGenerationIntentReference, MediaGenerationIntentV2 } from "./frozen-plan.js";

const SCENARIOS = new Set([
  "first_frame_to_video",
  "first_last_frame_to_video",
  "subject_reference_to_video",
  "multimodal_reference_to_video",
  "video_to_video",
  "video_edit",
  "video_extend",
]);
const AUDIO_POLICIES = new Set(["silent", "native_generate", "reference_conditioned"]);
const MEDIA_CLASS = {
  subject: "image",
  style: "image",
  first_frame: "image",
  last_frame: "image",
  voice: "audio",
  motion: "video",
  source_video: "video",
} as const satisfies Record<
  MediaGenerationIntentReference["role"],
  MediaGenerationIntentReference["mediaClass"]
>;
const MIME: Record<MediaGenerationIntentReference["mediaClass"], ReadonlySet<string>> = {
  image: new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/bmp",
    "image/tiff",
    "image/gif",
    "image/heic",
    "image/heif",
  ]),
  audio: new Set(["audio/wav", "audio/mpeg"]),
  video: new Set(["video/mp4", "video/quicktime"]),
};
const DURATION_SEC_MIN = 2;
const DURATION_SEC_MAX = 15;
const TOTAL_DURATION_SEC_MAX = 15;
const RUNTIME_LOCAL_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function scenarioMatches(intent: MediaGenerationIntentV2): boolean {
  const refs = intent.references;
  const count = (role: MediaGenerationIntentReference["role"]) =>
    refs.filter((ref) => ref.role === role).length;
  const only = (...roles: MediaGenerationIntentReference["role"][]) =>
    refs.every((ref) => roles.includes(ref.role));
  switch (intent.generationScenario) {
    case "first_frame_to_video":
      return refs.length === 1 && count("first_frame") === 1;
    case "first_last_frame_to_video":
      return refs.length === 2 && count("first_frame") === 1 && count("last_frame") === 1;
    case "subject_reference_to_video":
      return refs.length > 0 && only("subject");
    case "multimodal_reference_to_video":
      return refs.length >= 2 && new Set(refs.map((ref) => ref.role)).size >= 2;
    case "video_to_video":
    case "video_edit":
    case "video_extend":
      return count("source_video") === 1;
    case "text_to_video":
      return false;
  }
}

/** Local execution mirror of the pinned official multimodal create-task schema. */
export function validateSeedanceV2MultimodalV5Intent(
  intent: MediaGenerationIntentV2,
): string | null {
  if (
    !SCENARIOS.has(intent.generationScenario) ||
    !AUDIO_POLICIES.has(intent.outputAudioPolicy) ||
    intent.references.length === 0 ||
    !scenarioMatches(intent)
  ) {
    return "The active Seedance multimodal profile does not claim this scenario.";
  }
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;
  let videoDurationSec = 0;
  let audioDurationSec = 0;
  for (const ref of intent.references) {
    if (MEDIA_CLASS[ref.role] !== ref.mediaClass) {
      return "A Seedance reference role does not match its documented media class.";
    }
    const frozenMime = ref.mimeType?.toLowerCase();
    if (!frozenMime || !MIME[ref.mediaClass].has(frozenMime)) {
      return "A Seedance reference MIME type is absent or outside the pinned profile.";
    }
    if (ref.mediaClass === "video" && ref.source.kind !== "runtime_local") {
      return "Seedance video references require an opaque runtime-local source handle.";
    }
    if (
      ref.source.kind === "runtime_local" &&
      !RUNTIME_LOCAL_HANDLE.test(ref.source.runtimeLocalRef)
    ) {
      return "A runtime-local source handle must be an opaque bounded token.";
    }
    if (ref.source.kind === "runtime_local" && !ref.source.companionArtifactId) {
      return "Seedance V5 runtime-local references require a companion Artifact authority anchor.";
    }
    if (ref.mediaClass === "image") {
      if (ref.durationSec !== undefined) {
        return "Seedance image references must not carry a duration.";
      }
      imageCount += 1;
      continue;
    }
    if (
      typeof ref.durationSec !== "number" ||
      !Number.isFinite(ref.durationSec) ||
      ref.durationSec < DURATION_SEC_MIN ||
      ref.durationSec > DURATION_SEC_MAX
    ) {
      return "Every Seedance audio/video reference requires a frozen 2-15 second duration.";
    }
    if (ref.mediaClass === "video") {
      videoCount += 1;
      videoDurationSec += ref.durationSec;
    } else {
      audioCount += 1;
      audioDurationSec += ref.durationSec;
    }
  }
  const hasFrameRole = intent.references.some(
    (ref) => ref.role === "first_frame" || ref.role === "last_frame",
  );
  const voiceCount = intent.references.filter((ref) => ref.role === "voice").length;
  if (
    imageCount > 9 ||
    videoCount > 3 ||
    audioCount > 3 ||
    videoDurationSec > TOTAL_DURATION_SEC_MAX ||
    audioDurationSec > TOTAL_DURATION_SEC_MAX ||
    (audioCount > 0 && imageCount + videoCount === 0) ||
    voiceCount > 0 !== (intent.outputAudioPolicy === "reference_conditioned") ||
    (hasFrameRole &&
      intent.references.some((ref) => ref.role !== "first_frame" && ref.role !== "last_frame")) ||
    (intent.references.some((ref) => ref.role === "last_frame") &&
      !intent.references.some((ref) => ref.role === "first_frame"))
  ) {
    return "The frozen reference set violates Seedance multimodal limits or exclusions.";
  }
  return null;
}
