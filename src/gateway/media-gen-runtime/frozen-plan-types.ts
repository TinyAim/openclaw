export const MEDIA_GEN_RUNTIME_FROZEN_PLAN_SCHEMA_VERSION = 2 as const;
export const MEDIA_GENERATION_INTENT_REFERENCE_DURATION_SEC_MAX = 86_400 as const;

export type MediaGenerationScenario =
  | "text_to_video"
  | "first_frame_to_video"
  | "last_frame_to_video"
  | "first_last_frame_to_video"
  | "subject_reference_to_video"
  | "multimodal_reference_to_video"
  | "video_to_video"
  | "video_edit"
  | "video_extend";
export type MediaOutputAudioPolicy =
  | "silent"
  | "native_generate"
  | "reference_conditioned"
  | "preserve_source";
export type MediaExecutionTopology = "provider_api" | "self_hosted" | "hybrid";
export type MediaServingProtocol = "sglang_video_v1" | "custom";
export type MediaModelLicensePolicyRef = {
  policyId: string;
  revision: number;
  digest: string;
};
export type MediaDataEgressPolicy = {
  mode: "none" | "vendor" | "hybrid";
  destinations?: string[];
  sends?: string[];
};
export type MediaGenerationIntentReferenceRole =
  | "subject"
  | "first_frame"
  | "last_frame"
  | "style"
  | "voice"
  | "motion"
  | "source_video";

export type MediaGenerationIntentReference = {
  role: MediaGenerationIntentReferenceRole;
  ordinal: number;
  required: boolean;
  mediaClass: "image" | "audio" | "video";
  source:
    | { kind: "artifact"; artifactId: string }
    | {
        kind: "runtime_local";
        runtimeLocalRef: string;
        /** Control-plane authority anchor; never a provider reference. */
        companionArtifactId?: string;
      };
  assetRefId?: string;
  authorityRef?: string;
  authorityVerified: boolean;
  mimeType?: string;
  /** Frozen authoritative source duration for typed audio/video references. */
  durationSec?: number;
  sourceDigest?: string;
  consentRef?: string;
  consentAuthorized?: boolean;
};

export type MediaGenerationIntentV2 = {
  schemaVersion: 2;
  identity: {
    projectId: string;
    shotId: string;
    shotVersion: string;
    promptPackId: string;
    promptPackVersion: number;
    promptPackUpdatedAt: string;
    promptPackDigest: string;
    sourceDigests: string[];
  };
  generationScenario: MediaGenerationScenario;
  outputAudioPolicy: MediaOutputAudioPolicy;
  legacyMode: "text2video" | "image2video";
  compiledPrompt: string;
  narrative: {
    visualPrompt: string;
    scriptText?: string;
    negativePrompt?: string;
    plannedStartState?: string;
    targetEndState?: string;
    reservedForLater: string[];
  };
  camera: { cameraPrompt?: string; motionPrompt?: string };
  performance: { actorDirection?: string; requiredEndState?: string };
  look: { stylePrompt?: string; continuityPrompt?: string };
  references: MediaGenerationIntentReference[];
  output: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    fps?: number;
    shotCount: number;
    qualityIntent?: string;
  };
  policy: { authority: "server" };
};

export type MediaGenRuntimeFrozenPlanV2 = {
  schemaVersion: 2;
  previewId: string;
  presetId: string;
  mode: "text2video" | "image2video";
  generationIntent: MediaGenerationIntentV2;
  generationIntentDigest: string;
  generationScenario: MediaGenerationScenario;
  outputAudioPolicy: MediaOutputAudioPolicy;
  providerRouteRef: {
    schemaVersion: 1;
    routeId: string;
    providerId: string;
    modelId: string;
    endpointId: string;
    region: string;
    accountTier: string;
  };
  capabilityProfileRef: { profileId: string; revision: number; digest: string };
  adapterRevision: string;
  executionTopology?: MediaExecutionTopology;
  servingProtocol?: MediaServingProtocol;
  licensePolicyRef?: MediaModelLicensePolicyRef;
  dataEgress?: MediaDataEgressPolicy;
  checkpointDigest?: string;
  runtimeRef: { runtimeId: string; lastSeenAt: string };
  constraintPlan: Array<{
    intentPath: string;
    sourceRef: string;
    sourceRevision: string;
    required: boolean;
    support: "native" | "prompt" | "approximate" | "unsupported";
    providerField?: string;
    providerSlot?: string;
    compiledFragmentDigest?: string;
    reasonCode: string;
    messageKey: string;
  }>;
  inputFingerprint: string;
  intentFingerprint: string;
};
