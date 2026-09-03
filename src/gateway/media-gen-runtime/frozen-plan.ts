import { createHash } from "node:crypto";
import {
  MEDIA_GENERATION_INTENT_REFERENCE_DURATION_SEC_MAX,
  MEDIA_GEN_RUNTIME_FROZEN_PLAN_SCHEMA_VERSION,
  type MediaGenerationIntentReference,
  type MediaGenerationIntentReferenceRole,
  type MediaGenerationIntentV2,
  type MediaGenerationScenario,
  type MediaGenRuntimeFrozenPlanV2,
  type MediaOutputAudioPolicy,
} from "./frozen-plan-types.js";

export { MEDIA_GEN_RUNTIME_FROZEN_PLAN_SCHEMA_VERSION } from "./frozen-plan-types.js";
export { MEDIA_GENERATION_INTENT_REFERENCE_DURATION_SEC_MAX } from "./frozen-plan-types.js";
export type {
  MediaGenerationIntentReference,
  MediaGenerationIntentReferenceRole,
  MediaGenerationIntentV2,
  MediaDataEgressPolicy,
  MediaExecutionTopology,
  MediaGenerationScenario,
  MediaGenRuntimeFrozenPlanV2,
  MediaModelLicensePolicyRef,
  MediaOutputAudioPolicy,
  MediaServingProtocol,
} from "./frozen-plan-types.js";

const SCENARIOS = new Set<MediaGenerationScenario>([
  "text_to_video",
  "first_frame_to_video",
  "last_frame_to_video",
  "first_last_frame_to_video",
  "subject_reference_to_video",
  "multimodal_reference_to_video",
  "video_to_video",
  "video_edit",
  "video_extend",
]);
const AUDIO = new Set<MediaOutputAudioPolicy>([
  "silent",
  "native_generate",
  "reference_conditioned",
  "preserve_source",
]);
const ROLES = new Set<MediaGenerationIntentReferenceRole>([
  "subject",
  "first_frame",
  "last_frame",
  "style",
  "voice",
  "motion",
  "source_video",
]);
const SUPPORT = new Set(["native", "prompt", "approximate", "unsupported"]);
const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const INTENT_SHA = /^intent:sha256:[a-f0-9]{64}$/u;
const HEX = /^[a-f0-9]{64}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function token(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value.trim());
}

function text(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" && value.length <= 100_000 && (allowEmpty || value.trim().length > 0)
  );
}

function optionalText(value: unknown): boolean {
  return value === undefined || text(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function intentDigest(value: MediaGenerationIntentV2): string {
  return `intent:sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function parseReference(raw: unknown): MediaGenerationIntentReference | null {
  const value = record(raw);
  if (
    !value ||
    !exact(value, [
      "role",
      "ordinal",
      "required",
      "mediaClass",
      "source",
      "assetRefId",
      "authorityRef",
      "authorityVerified",
      "mimeType",
      "durationSec",
      "sourceDigest",
      "consentRef",
      "consentAuthorized",
    ])
  )
    return null;
  const source = record(value.source);
  if (!source || !exact(source, ["kind", "artifactId", "runtimeLocalRef", "companionArtifactId"]))
    return null;
  const sourceOk =
    source.kind === "artifact"
      ? token(source.artifactId) &&
        source.runtimeLocalRef === undefined &&
        source.companionArtifactId === undefined
      : source.kind === "runtime_local" &&
        token(source.runtimeLocalRef) &&
        source.artifactId === undefined &&
        (source.companionArtifactId === undefined || token(source.companionArtifactId));
  if (
    !ROLES.has(value.role as MediaGenerationIntentReferenceRole) ||
    typeof value.ordinal !== "number" ||
    !Number.isInteger(value.ordinal) ||
    value.ordinal < 0 ||
    typeof value.required !== "boolean" ||
    !["image", "audio", "video"].includes(String(value.mediaClass)) ||
    !sourceOk ||
    typeof value.authorityVerified !== "boolean" ||
    (value.assetRefId !== undefined && !token(value.assetRefId)) ||
    (value.authorityRef !== undefined && !token(value.authorityRef)) ||
    (value.mimeType !== undefined && !token(value.mimeType)) ||
    (value.durationSec !== undefined &&
      (value.mediaClass === "image" ||
        typeof value.durationSec !== "number" ||
        !Number.isFinite(value.durationSec) ||
        value.durationSec <= 0 ||
        value.durationSec > MEDIA_GENERATION_INTENT_REFERENCE_DURATION_SEC_MAX)) ||
    (value.sourceDigest !== undefined &&
      (typeof value.sourceDigest !== "string" || !SHA.test(value.sourceDigest))) ||
    (value.consentRef !== undefined && !token(value.consentRef)) ||
    (value.consentAuthorized !== undefined && typeof value.consentAuthorized !== "boolean")
  )
    return null;
  return raw as MediaGenerationIntentReference;
}

function scenarioMatches(intent: MediaGenerationIntentV2): boolean {
  const counts = new Map<MediaGenerationIntentReferenceRole, number>();
  for (const ref of intent.references) counts.set(ref.role, (counts.get(ref.role) ?? 0) + 1);
  const roles = [...counts.keys()];
  const exactRoles = (...expected: MediaGenerationIntentReferenceRole[]) =>
    roles.length === expected.length && expected.every((role) => counts.has(role));
  const valid = (() => {
    switch (intent.generationScenario) {
      case "text_to_video":
        return intent.references.length === 0;
      case "first_frame_to_video":
        return exactRoles("first_frame") && counts.get("first_frame") === 1;
      case "last_frame_to_video":
        return exactRoles("last_frame") && counts.get("last_frame") === 1;
      case "first_last_frame_to_video":
        return (
          exactRoles("first_frame", "last_frame") &&
          counts.get("first_frame") === 1 &&
          counts.get("last_frame") === 1
        );
      case "subject_reference_to_video":
        return exactRoles("subject") && (counts.get("subject") ?? 0) > 0;
      case "multimodal_reference_to_video":
        return intent.references.length >= 2 && roles.length >= 2;
      case "video_to_video":
      case "video_edit":
      case "video_extend":
        return counts.get("source_video") === 1;
    }
  })();
  return (
    valid &&
    (intent.outputAudioPolicy !== "reference_conditioned" || counts.has("voice")) &&
    (intent.outputAudioPolicy !== "preserve_source" || counts.has("source_video"))
  );
}

function parseIntent(raw: unknown): MediaGenerationIntentV2 | null {
  const value = record(raw);
  if (
    !value ||
    !exact(value, [
      "schemaVersion",
      "identity",
      "generationScenario",
      "outputAudioPolicy",
      "legacyMode",
      "compiledPrompt",
      "narrative",
      "camera",
      "performance",
      "look",
      "references",
      "output",
      "policy",
    ])
  )
    return null;
  const identity = record(value.identity);
  const narrative = record(value.narrative);
  const camera = record(value.camera);
  const performance = record(value.performance);
  const look = record(value.look);
  const output = record(value.output);
  const policy = record(value.policy);
  if (
    !identity ||
    !narrative ||
    !camera ||
    !performance ||
    !look ||
    !output ||
    !policy ||
    !exact(identity, [
      "projectId",
      "shotId",
      "shotVersion",
      "promptPackId",
      "promptPackVersion",
      "promptPackUpdatedAt",
      "promptPackDigest",
      "sourceDigests",
    ]) ||
    !exact(narrative, [
      "visualPrompt",
      "scriptText",
      "negativePrompt",
      "plannedStartState",
      "targetEndState",
      "reservedForLater",
    ]) ||
    !exact(camera, ["cameraPrompt", "motionPrompt"]) ||
    !exact(performance, ["actorDirection", "requiredEndState"]) ||
    !exact(look, ["stylePrompt", "continuityPrompt"]) ||
    !exact(output, [
      "durationSec",
      "aspectRatio",
      "resolution",
      "fps",
      "shotCount",
      "qualityIntent",
    ]) ||
    !exact(policy, ["authority"])
  )
    return null;
  if (
    value.schemaVersion !== 2 ||
    !SCENARIOS.has(value.generationScenario as MediaGenerationScenario) ||
    !AUDIO.has(value.outputAudioPolicy as MediaOutputAudioPolicy) ||
    !["text2video", "image2video"].includes(String(value.legacyMode)) ||
    !text(value.compiledPrompt) ||
    !token(identity.projectId) ||
    !token(identity.shotId) ||
    !text(identity.shotVersion) ||
    !token(identity.promptPackId) ||
    typeof identity.promptPackVersion !== "number" ||
    !Number.isInteger(identity.promptPackVersion) ||
    identity.promptPackVersion < 1 ||
    !text(identity.promptPackUpdatedAt) ||
    typeof identity.promptPackDigest !== "string" ||
    !SHA.test(identity.promptPackDigest) ||
    !Array.isArray(identity.sourceDigests) ||
    identity.sourceDigests.some((item) => typeof item !== "string" || !SHA.test(item)) ||
    !text(narrative.visualPrompt, true) ||
    !Array.isArray(narrative.reservedForLater) ||
    narrative.reservedForLater.some((item) => !text(item)) ||
    !optionalText(narrative.scriptText) ||
    !optionalText(narrative.negativePrompt) ||
    !optionalText(narrative.plannedStartState) ||
    !optionalText(narrative.targetEndState) ||
    !optionalText(camera.cameraPrompt) ||
    !optionalText(camera.motionPrompt) ||
    !optionalText(performance.actorDirection) ||
    !optionalText(performance.requiredEndState) ||
    !optionalText(look.stylePrompt) ||
    !optionalText(look.continuityPrompt) ||
    !Array.isArray(value.references) ||
    policy.authority !== "server" ||
    typeof output.shotCount !== "number" ||
    !Number.isInteger(output.shotCount) ||
    output.shotCount < 1 ||
    (output.durationSec !== undefined &&
      (typeof output.durationSec !== "number" ||
        !Number.isFinite(output.durationSec) ||
        output.durationSec <= 0)) ||
    (output.fps !== undefined &&
      (typeof output.fps !== "number" || !Number.isInteger(output.fps) || output.fps <= 0)) ||
    !optionalText(output.aspectRatio) ||
    !optionalText(output.resolution) ||
    !optionalText(output.qualityIntent)
  )
    return null;
  const references = value.references.map(parseReference);
  if (references.some((item) => item === null)) return null;
  const intent = raw as MediaGenerationIntentV2;
  if (
    new Set(intent.references.map((ref) => `${ref.role}:${ref.ordinal}`)).size !==
      intent.references.length ||
    intent.legacyMode !==
      (intent.generationScenario === "text_to_video" ? "text2video" : "image2video") ||
    !scenarioMatches(intent)
  )
    return null;
  return intent;
}

function parseMappings(raw: unknown): MediaGenRuntimeFrozenPlanV2["constraintPlan"] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: MediaGenRuntimeFrozenPlanV2["constraintPlan"] = [];
  for (const item of raw) {
    const row = record(item);
    if (
      !row ||
      !exact(row, [
        "intentPath",
        "sourceRef",
        "sourceRevision",
        "required",
        "support",
        "providerField",
        "providerSlot",
        "compiledFragmentDigest",
        "reasonCode",
        "messageKey",
      ]) ||
      !token(row.intentPath) ||
      !token(row.sourceRef) ||
      !token(row.sourceRevision) ||
      typeof row.required !== "boolean" ||
      !SUPPORT.has(String(row.support)) ||
      (row.providerField !== undefined && !token(row.providerField)) ||
      (row.providerSlot !== undefined && !token(row.providerSlot)) ||
      (row.compiledFragmentDigest !== undefined &&
        (typeof row.compiledFragmentDigest !== "string" ||
          !/^fragment:sha256:[a-f0-9]{64}$/u.test(row.compiledFragmentDigest))) ||
      !token(row.reasonCode) ||
      !token(row.messageKey) ||
      out.some((existing) => existing.intentPath === row.intentPath)
    )
      return null;
    out.push(item as MediaGenRuntimeFrozenPlanV2["constraintPlan"][number]);
  }
  return out;
}

export function parseMediaGenRuntimeFrozenPlan(raw: unknown): MediaGenRuntimeFrozenPlanV2 | null {
  const value = record(raw);
  if (
    !value ||
    !exact(value, [
      "schemaVersion",
      "previewId",
      "presetId",
      "mode",
      "generationIntent",
      "generationIntentDigest",
      "generationScenario",
      "outputAudioPolicy",
      "providerRouteRef",
      "capabilityProfileRef",
      "adapterRevision",
      "executionTopology",
      "servingProtocol",
      "licensePolicyRef",
      "dataEgress",
      "checkpointDigest",
      "runtimeRef",
      "constraintPlan",
      "inputFingerprint",
      "intentFingerprint",
    ]) ||
    value.schemaVersion !== MEDIA_GEN_RUNTIME_FROZEN_PLAN_SCHEMA_VERSION
  )
    return null;
  const intent = parseIntent(value.generationIntent);
  const route = record(value.providerRouteRef);
  const profile = record(value.capabilityProfileRef);
  const license = value.licensePolicyRef === undefined ? undefined : record(value.licensePolicyRef);
  const egress = value.dataEgress === undefined ? undefined : record(value.dataEgress);
  const runtime = record(value.runtimeRef);
  const mappings = parseMappings(value.constraintPlan);
  if (
    !intent ||
    !route ||
    !profile ||
    !runtime ||
    !mappings ||
    !exact(route, [
      "schemaVersion",
      "routeId",
      "providerId",
      "modelId",
      "endpointId",
      "region",
      "accountTier",
    ]) ||
    route.schemaVersion !== 1 ||
    [
      route.routeId,
      route.providerId,
      route.modelId,
      route.endpointId,
      route.region,
      route.accountTier,
    ].some((item) => !token(item)) ||
    !exact(profile, ["profileId", "revision", "digest"]) ||
    !token(profile.profileId) ||
    typeof profile.revision !== "number" ||
    !Number.isInteger(profile.revision) ||
    profile.revision < 1 ||
    typeof profile.digest !== "string" ||
    !SHA.test(profile.digest) ||
    (value.executionTopology !== undefined &&
      !["provider_api", "self_hosted", "hybrid"].includes(String(value.executionTopology))) ||
    (value.servingProtocol !== undefined &&
      !["sglang_video_v1", "custom"].includes(String(value.servingProtocol))) ||
    (value.licensePolicyRef !== undefined &&
      (!license ||
        !exact(license, ["policyId", "revision", "digest"]) ||
        !token(license.policyId) ||
        typeof license.revision !== "number" ||
        !Number.isInteger(license.revision) ||
        license.revision < 1 ||
        typeof license.digest !== "string" ||
        !SHA.test(license.digest))) ||
    (value.dataEgress !== undefined &&
      (!egress ||
        !exact(egress, ["mode", "destinations", "sends"]) ||
        !["none", "vendor", "hybrid"].includes(String(egress.mode)) ||
        (egress.destinations !== undefined &&
          (!Array.isArray(egress.destinations) ||
            egress.destinations.some((item) => !token(item)))) ||
        (egress.sends !== undefined &&
          (!Array.isArray(egress.sends) || egress.sends.some((item) => !token(item)))) ||
        (egress.mode === "none" &&
          ((Array.isArray(egress.destinations) && egress.destinations.length > 0) ||
            (Array.isArray(egress.sends) && egress.sends.length > 0))))) ||
    (value.checkpointDigest !== undefined &&
      (typeof value.checkpointDigest !== "string" || !SHA.test(value.checkpointDigest))) ||
    (value.executionTopology === undefined &&
      (value.servingProtocol !== undefined ||
        value.licensePolicyRef !== undefined ||
        value.dataEgress !== undefined ||
        value.checkpointDigest !== undefined)) ||
    (value.executionTopology === "provider_api" &&
      (value.servingProtocol !== undefined ||
        value.licensePolicyRef !== undefined ||
        value.checkpointDigest !== undefined ||
        (egress != null && egress.mode !== "vendor"))) ||
    (value.executionTopology === "self_hosted" &&
      (value.servingProtocol === undefined ||
        !license ||
        egress?.mode !== "none" ||
        typeof value.checkpointDigest !== "string")) ||
    (value.executionTopology === "hybrid" &&
      (value.servingProtocol === undefined ||
        !license ||
        egress?.mode !== "hybrid" ||
        typeof value.checkpointDigest !== "string")) ||
    !exact(runtime, ["runtimeId", "lastSeenAt"]) ||
    !token(runtime.runtimeId) ||
    typeof runtime.lastSeenAt !== "string" ||
    Number.isNaN(Date.parse(runtime.lastSeenAt)) ||
    !token(value.previewId) ||
    !token(value.presetId) ||
    !token(value.adapterRevision) ||
    !["text2video", "image2video"].includes(String(value.mode)) ||
    typeof value.generationIntentDigest !== "string" ||
    !INTENT_SHA.test(value.generationIntentDigest) ||
    value.generationIntentDigest !== intentDigest(intent) ||
    value.generationScenario !== intent.generationScenario ||
    value.outputAudioPolicy !== intent.outputAudioPolicy ||
    value.mode !== intent.legacyMode ||
    typeof value.inputFingerprint !== "string" ||
    !HEX.test(value.inputFingerprint) ||
    typeof value.intentFingerprint !== "string" ||
    !HEX.test(value.intentFingerprint) ||
    mappings.some((row) => row.required && row.support === "unsupported") ||
    !mappings.some((row) => row.intentPath === "generationScenario" && row.support === "native") ||
    !mappings.some((row) => row.intentPath === "outputAudioPolicy" && row.support === "native") ||
    !mappings.some((row) => row.intentPath === "compiledPrompt" && row.support === "prompt") ||
    intent.references.some(
      (ref) =>
        !ref.sourceDigest ||
        !intent.identity.sourceDigests.includes(ref.sourceDigest) ||
        !mappings.some(
          (row) =>
            row.intentPath === `references.${ref.role}.${ref.ordinal}` && row.support === "native",
        ),
    )
  )
    return null;
  return raw as MediaGenRuntimeFrozenPlanV2;
}
