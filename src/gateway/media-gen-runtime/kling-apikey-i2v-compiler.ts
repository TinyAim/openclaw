import { createHash } from "node:crypto";
import { parseMediaGenRuntimeFrozenPlan } from "./frozen-plan.js";
import type { MediaGenRuntimeVendorInput } from "./types.js";

export const KLING_APIKEY_2_6_I2V_ROUTE_ID = "kling-apikey-2.6-i2v-sg/v1";
export const KLING_APIKEY_2_6_I2V_ADAPTER_REVISION = "openclaw-kling-apikey-2.6-i2v-runtime/v1";
export const KLING_APIKEY_2_6_I2V_MODEL_ID = "kling-2.6";
export const KLING_APIKEY_2_6_I2V_ENDPOINT_ID = "kling.api.v2.image-to-video";
export const KLING_APIKEY_2_6_I2V_PROFILE_DIGEST =
  "sha256:d702afccc2be914930c2330d33ab6ca042c838083551f43a6b457e60a8a31b2e";

export type KlingApiKeyI2VContentItem =
  | { type: "prompt"; text: string }
  | { type: "first_frame" | "last_frame"; url: string };
export type KlingApiKeyI2VSettings = {
  duration: 5 | 10;
  resolution: "720p" | "1080p";
  audio: "off" | "native";
};
export type KlingApiKeyI2VOptions = { external_task_id: string };
export type KlingApiKeyI2VCreateBody = {
  contents: KlingApiKeyI2VContentItem[];
  settings: KlingApiKeyI2VSettings;
  options: KlingApiKeyI2VOptions;
};

/** Private preparation-owner receipt. The producer must persist the attempt correlation before POST. */
export type KlingApiKeyPreparedSubmission = {
  externalTaskId: string;
  frames: readonly {
    role: "first_frame" | "last_frame";
    ordinal: number;
    artifactId: string;
    sourceDigest: string;
    mimeType: string;
    width: number;
    height: number;
    byteLength: number;
    url: string;
  }[];
};
export type KlingApiKeyI2VCompileResult =
  | {
      ok: true;
      body: KlingApiKeyI2VCreateBody;
      providerRequestDigest: string;
      externalTaskId: string;
    }
  | { ok: false; message: string };

function fail(message: string): KlingApiKeyI2VCompileResult {
  return { ok: false, message };
}
function digest(value: string | undefined): string | null {
  if (!value) return null;
  const raw = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/u.test(raw) ? `sha256:${raw}` : null;
}
function controlledHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Validate the frozen identity and redeemed artifact bytes before any preparation side effect. */
export function validateKlingApiKeyPreparationInput(
  input: MediaGenRuntimeVendorInput,
): string | undefined {
  const plan = parseMediaGenRuntimeFrozenPlan(input.frozenPlan);
  const route = plan?.providerRouteRef;
  const profile = plan?.capabilityProfileRef;
  if (
    !plan ||
    input.presetId !== "kling" ||
    plan.presetId !== input.presetId ||
    input.mode !== "image2video" ||
    plan.mode !== input.mode ||
    plan.adapterRevision !== KLING_APIKEY_2_6_I2V_ADAPTER_REVISION ||
    route?.routeId !== KLING_APIKEY_2_6_I2V_ROUTE_ID ||
    route.providerId !== "kling_open_platform" ||
    route.modelId !== KLING_APIKEY_2_6_I2V_MODEL_ID ||
    route.endpointId !== KLING_APIKEY_2_6_I2V_ENDPOINT_ID ||
    route.region !== "global" ||
    route.accountTier !== "api_key" ||
    profile?.profileId !== "kling.openclaw-runtime.kling_2_6.image2video.sg.v1" ||
    profile.revision !== 1 ||
    profile.digest !== KLING_APIKEY_2_6_I2V_PROFILE_DIGEST
  )
    return "The frozen Kling route and profile do not match this adapter.";
  const intent = plan.generationIntent;
  const expectedCount =
    intent.generationScenario === "first_frame_to_video"
      ? 1
      : intent.generationScenario === "first_last_frame_to_video"
        ? 2
        : 0;
  const duration = intent.output.durationSec;
  const resolution = intent.output.resolution;
  if (
    !expectedCount ||
    input.source ||
    (input.params && Object.keys(input.params).length !== 0) ||
    input.prompt !== intent.compiledPrompt ||
    !intent.compiledPrompt.trim() ||
    intent.compiledPrompt.length > 2500 ||
    !["silent", "native_generate"].includes(intent.outputAudioPolicy) ||
    (duration !== 5 && duration !== 10) ||
    (resolution !== "720p" && resolution !== "1080p") ||
    (input.durationSec !== undefined && input.durationSec !== duration) ||
    (input.resolution !== undefined && input.resolution !== resolution) ||
    ((expectedCount === 2 || intent.outputAudioPolicy === "native_generate") &&
      resolution !== "1080p") ||
    intent.references.length !== expectedCount ||
    input.sources?.length !== expectedCount
  ) {
    return "The frozen Kling intent or input is unsupported.";
  }
  for (const role of ["first_frame", "last_frame"] as const) {
    const refs = intent.references.filter((ref) => ref.role === role);
    if (refs.length !== (role === "first_frame" || expectedCount === 2 ? 1 : 0))
      return "The frozen Kling frame roles are invalid.";
    if (!refs.length) continue;
    const ref = refs[0]!;
    const slots = input.sources.filter(
      (slot) => slot.role === role && slot.ordinal === ref.ordinal,
    );
    if (
      ref.ordinal !== 0 ||
      ref.source.kind !== "artifact" ||
      ref.mediaClass !== "image" ||
      !ref.authorityVerified ||
      slots.length !== 1
    ) {
      return "The Kling frame binding is invalid.";
    }
    const slot = slots[0]!;
    const expected = digest(ref.sourceDigest);
    const bytes = slot.source.bytes;
    if (
      !expected ||
      slot.artifactId !== ref.source.artifactId ||
      digest(slot.source.sha256) !== expected ||
      !bytes ||
      bytes.length === 0 ||
      bytes.length > 50_000_000 ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected ||
      !["image/jpeg", "image/png"].includes(slot.source.mimeType.toLowerCase()) ||
      (ref.mimeType && ref.mimeType.toLowerCase() !== slot.source.mimeType.toLowerCase())
    ) {
      return "The Kling artifact bytes do not match their frozen source.";
    }
  }
  return undefined;
}

/** Pure compiler: caller supplies preparation and correlation from the runtime owner, never client URLs. */
export function compileKlingApiKeyI2VRequest(
  input: MediaGenRuntimeVendorInput,
  prepared?: KlingApiKeyPreparedSubmission,
): KlingApiKeyI2VCompileResult {
  const preflightError = validateKlingApiKeyPreparationInput(input);
  if (preflightError) return fail(preflightError);
  const plan = parseMediaGenRuntimeFrozenPlan(input.frozenPlan);
  const route = plan?.providerRouteRef;
  const profile = plan?.capabilityProfileRef;
  if (
    !plan ||
    input.presetId !== "kling" ||
    plan.presetId !== input.presetId ||
    input.mode !== "image2video" ||
    plan.mode !== input.mode ||
    plan.adapterRevision !== KLING_APIKEY_2_6_I2V_ADAPTER_REVISION ||
    route?.routeId !== KLING_APIKEY_2_6_I2V_ROUTE_ID ||
    route.providerId !== "kling_open_platform" ||
    route.modelId !== KLING_APIKEY_2_6_I2V_MODEL_ID ||
    route.endpointId !== KLING_APIKEY_2_6_I2V_ENDPOINT_ID ||
    route.region !== "global" ||
    route.accountTier !== "api_key" ||
    profile?.profileId !== "kling.openclaw-runtime.kling_2_6.image2video.sg.v1" ||
    profile.revision !== 1 ||
    profile.digest !== KLING_APIKEY_2_6_I2V_PROFILE_DIGEST
  ) {
    return fail("The frozen Kling route and profile do not match this adapter.");
  }
  const intent = plan.generationIntent;
  if (!prepared || !/^[A-Za-z0-9_-]{1,128}$/u.test(prepared.externalTaskId)) {
    return fail("Kling requires a durable attempt correlation and prepared inputs.");
  }
  if (
    input.source ||
    (input.params && Object.keys(input.params).length !== 0) ||
    input.prompt !== intent.compiledPrompt ||
    !intent.compiledPrompt.trim() ||
    intent.compiledPrompt.length > 2500 ||
    !["first_frame_to_video", "first_last_frame_to_video"].includes(intent.generationScenario) ||
    !["silent", "native_generate"].includes(intent.outputAudioPolicy)
  ) {
    return fail("The frozen Kling intent or input is unsupported.");
  }
  const duration = intent.output.durationSec;
  const resolution = intent.output.resolution;
  if (
    (duration !== 5 && duration !== 10) ||
    (resolution !== "720p" && resolution !== "1080p") ||
    (input.durationSec !== undefined && input.durationSec !== duration) ||
    (input.resolution !== undefined && input.resolution !== resolution) ||
    ((intent.generationScenario === "first_last_frame_to_video" ||
      intent.outputAudioPolicy === "native_generate") &&
      resolution !== "1080p")
  ) {
    return fail("The frozen Kling output settings are invalid.");
  }
  const refs = intent.references;
  const slots = input.sources ?? [];
  const expectedCount = intent.generationScenario === "first_last_frame_to_video" ? 2 : 1;
  if (
    refs.length !== expectedCount ||
    slots.length !== refs.length ||
    prepared.frames.length !== refs.length
  ) {
    return fail("The prepared Kling frames do not match the frozen references.");
  }
  const contents: KlingApiKeyI2VContentItem[] = [{ type: "prompt", text: intent.compiledPrompt }];
  for (const role of ["first_frame", "last_frame"] as const) {
    const matchingRefs = refs.filter((ref) => ref.role === role);
    if (matchingRefs.length !== (role === "first_frame" || expectedCount === 2 ? 1 : 0)) {
      return fail("The frozen Kling frame roles are invalid.");
    }
    if (!matchingRefs.length) continue;
    const ref = matchingRefs[0]!;
    const matchingSlots = slots.filter(
      (slot) => slot.role === role && slot.ordinal === ref.ordinal,
    );
    const matchingPrepared = prepared.frames.filter(
      (frame) => frame.role === role && frame.ordinal === ref.ordinal,
    );
    if (
      ref.ordinal !== 0 ||
      ref.source.kind !== "artifact" ||
      ref.mediaClass !== "image" ||
      !ref.authorityVerified ||
      matchingSlots.length !== 1 ||
      matchingPrepared.length !== 1
    )
      return fail("The Kling frame binding is invalid.");
    const slot = matchingSlots[0]!;
    const frame = matchingPrepared[0]!;
    const expected = digest(ref.sourceDigest);
    const bytes = slot.source.bytes;
    if (
      !expected ||
      slot.artifactId !== ref.source.artifactId ||
      frame.artifactId !== ref.source.artifactId ||
      digest(slot.source.sha256) !== expected ||
      digest(frame.sourceDigest) !== expected ||
      !bytes ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected ||
      !["image/jpeg", "image/png"].includes(slot.source.mimeType.toLowerCase()) ||
      slot.source.mimeType.toLowerCase() !== frame.mimeType.toLowerCase() ||
      (ref.mimeType && ref.mimeType.toLowerCase() !== frame.mimeType.toLowerCase()) ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width < 300 ||
      frame.height < 300 ||
      frame.width / frame.height < 0.4 ||
      frame.width / frame.height > 2.5 ||
      frame.byteLength !== bytes.length ||
      frame.byteLength > 50_000_000 ||
      !controlledHttps(frame.url)
    ) {
      return fail("The prepared Kling frame is invalid or does not match its authorized source.");
    }
    contents.push({ type: role, url: frame.url });
  }
  const body: KlingApiKeyI2VCreateBody = {
    contents,
    settings: {
      duration,
      resolution,
      audio: intent.outputAudioPolicy === "native_generate" ? "native" : "off",
    },
    options: { external_task_id: prepared.externalTaskId },
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
    externalTaskId: prepared.externalTaskId,
  };
}
