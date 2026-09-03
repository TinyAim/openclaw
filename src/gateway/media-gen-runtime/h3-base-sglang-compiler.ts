import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type {
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

export const H3_BASE_SGLANG_MODEL_ID = "MiniMaxAI/MiniMax-H3";
export const H3_BASE_ROUTE_MODEL_ID = "MiniMax-H3-Base";
export const H3_BASE_PROVIDER_ID = "minimax_open_weights";
export const H3_BASE_ENDPOINT_ID = "sglang.video.v1";
export const H3_BASE_REGION = "runtime_local";
export const H3_BASE_ACCOUNT_TIER = "local_weights";

export type H3BaseSglangVariant = "fl2va" | "ref2va";

export type H3BaseSglangCondition = {
  type: "image" | "video" | "video_audio" | "audio";
  uri: string;
  role: "keyframe" | "reference";
  frame_index?: 0 | -1;
};

export type H3BaseSglangCreateBody = {
  model: typeof H3_BASE_SGLANG_MODEL_ID;
  prompt: string;
  seconds: number;
  /** Exact adapter constants; never inherit mutable SGLang defaults. */
  seed: 42;
  quality: "lossless";
  task: "t2va" | "fl2va" | "ref2va";
  conditions: H3BaseSglangCondition[];
  target: {
    short_edge: 768;
    aspect_ratio: "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
    duration_seconds: number;
  };
  num_outputs_per_prompt: 1;
  num_inference_steps: 50;
  flow_shift: 12;
  audio_flow_shift: 3;
};

export type H3BaseSglangProfilePin = {
  profileId: string;
  revision: number;
  digest: string;
};

export type H3BaseSglangCompileOptions = {
  variant: H3BaseSglangVariant;
  routeId: string;
  adapterRevision: string;
  profilesByScenario: Readonly<Partial<Record<string, H3BaseSglangProfilePin>>>;
  checkpointDigest: string;
  materialize(input: {
    ref: MediaGenerationIntentReference;
    source: MediaGenRuntimeSource;
    index: number;
  }): Promise<string>;
};

export type H3BaseSglangCompileResult =
  | { ok: true; body: H3BaseSglangCreateBody; providerRequestDigest: string }
  | { ok: false; message: string };

const SHA = /^sha256:[a-f0-9]{64}$/u;
const RATIOS = new Set<H3BaseSglangCreateBody["target"]["aspect_ratio"]>([
  "auto",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);
const MIME = {
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/quicktime"]),
  audio: new Set(["audio/wav", "audio/x-wav", "audio/mpeg"]),
} as const;
const MAX_BYTES = { image: 64_000_000, video: 512_000_000, audio: 64_000_000 } as const;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function correlateSources(input: MediaGenRuntimeVendorInput):
  | {
      ok: true;
      ordered: Array<{ ref: MediaGenerationIntentReference; slot: MediaGenRuntimeSourceSlot }>;
    }
  | {
      ok: false;
      message: string;
    } {
  const refs = input.frozenPlan?.generationIntent.references ?? [];
  if (input.source) return { ok: false, message: "H3 Base requires typed reference slots." };
  const sources = input.sources ?? [];
  if (sources.length !== refs.length) {
    return { ok: false, message: "Resolved reference count does not match the frozen plan." };
  }
  const byKey = new Map<string, MediaGenRuntimeSourceSlot>();
  for (const slot of sources) {
    const key = `${slot.role}:${slot.ordinal}`;
    if (byKey.has(key)) return { ok: false, message: "Resolved reference slots are not unique." };
    byKey.set(key, slot);
  }
  const ordered = refs.map((ref) => ({ ref, slot: byKey.get(`${ref.role}:${ref.ordinal}`) }));
  if (ordered.some((item) => !item.slot)) {
    return { ok: false, message: "A frozen reference slot was not resolved." };
  }
  return {
    ok: true,
    ordered: ordered as Array<{
      ref: MediaGenerationIntentReference;
      slot: MediaGenRuntimeSourceSlot;
    }>,
  };
}

function validateSource(
  ref: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): string | null {
  if (source.providerRef || !source.bytes?.length) {
    return "Private H3 references must resolve to local bytes, never provider URLs.";
  }
  const mime = source.mimeType.toLowerCase();
  if (!MIME[ref.mediaClass].has(mime as never) || source.bytes.length > MAX_BYTES[ref.mediaClass]) {
    return `The ${ref.mediaClass} reference MIME or size is not accepted by the private H3 adapter.`;
  }
  if (!ref.sourceDigest || !SHA.test(ref.sourceDigest)) {
    return "Every private H3 reference requires a frozen sha256 source digest.";
  }
  const actual = `sha256:${createHash("sha256").update(source.bytes).digest("hex")}`;
  const resolvedDigest = source.sha256
    ? source.sha256.startsWith("sha256:")
      ? source.sha256
      : `sha256:${source.sha256}`
    : undefined;
  if (actual !== ref.sourceDigest || (resolvedDigest && resolvedDigest !== actual)) {
    return "A redeemed private H3 reference did not match its frozen digest.";
  }
  return null;
}

function validateIdentity(
  input: MediaGenRuntimeVendorInput,
  options: H3BaseSglangCompileOptions,
): string | null {
  const plan = input.frozenPlan;
  const profile = plan ? options.profilesByScenario[plan.generationScenario] : undefined;
  if (
    !plan ||
    !profile ||
    input.presetId !== "hailuo" ||
    plan.presetId !== input.presetId ||
    input.mode !== plan.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationIntent.generationScenario !== plan.generationScenario ||
    input.prompt !== plan.generationIntent.compiledPrompt ||
    plan.providerRouteRef.routeId !== options.routeId ||
    plan.providerRouteRef.providerId !== H3_BASE_PROVIDER_ID ||
    plan.providerRouteRef.modelId !== H3_BASE_ROUTE_MODEL_ID ||
    plan.providerRouteRef.endpointId !== H3_BASE_ENDPOINT_ID ||
    plan.providerRouteRef.region !== H3_BASE_REGION ||
    plan.providerRouteRef.accountTier !== H3_BASE_ACCOUNT_TIER ||
    plan.adapterRevision !== options.adapterRevision ||
    plan.capabilityProfileRef.profileId !== profile.profileId ||
    plan.capabilityProfileRef.revision !== profile.revision ||
    plan.capabilityProfileRef.digest !== profile.digest
  ) {
    return `The frozen route/profile does not match the private H3 Base ${options.variant} adapter.`;
  }
  const selfHosted = plan as typeof plan & {
    executionTopology?: unknown;
    servingProtocol?: unknown;
    checkpointDigest?: unknown;
    dataEgress?: { mode?: unknown };
  };
  if (
    selfHosted.executionTopology !== "self_hosted" ||
    selfHosted.servingProtocol !== "sglang_video_v1" ||
    selfHosted.dataEgress?.mode !== "none" ||
    selfHosted.checkpointDigest !== options.checkpointDigest
  ) {
    return "The frozen private route does not match the local serving topology or checkpoint.";
  }
  return null;
}

function taskFor(input: MediaGenRuntimeVendorInput, variant: H3BaseSglangVariant) {
  const scenario = input.frozenPlan!.generationScenario;
  if (variant === "ref2va") return scenario === "multimodal_reference_to_video" ? "ref2va" : null;
  if (scenario === "text_to_video") return "t2va";
  return ["first_frame_to_video", "last_frame_to_video", "first_last_frame_to_video"].includes(
    scenario,
  )
    ? "fl2va"
    : null;
}

function conditionShape(
  variant: H3BaseSglangVariant,
  ref: MediaGenerationIntentReference,
  uri: string,
): H3BaseSglangCondition | null {
  if (variant === "fl2va") {
    if (ref.mediaClass !== "image") return null;
    if (ref.role === "first_frame") {
      return { type: "image", uri, role: "keyframe", frame_index: 0 };
    }
    return ref.role === "last_frame"
      ? { type: "image", uri, role: "keyframe", frame_index: -1 }
      : null;
  }
  if (ref.role === "first_frame" || ref.role === "last_frame") return null;
  return { type: ref.mediaClass, uri, role: "reference" };
}

export async function compileH3BaseSglangRequest(
  input: MediaGenRuntimeVendorInput,
  options: H3BaseSglangCompileOptions,
): Promise<H3BaseSglangCompileResult> {
  const identityError = validateIdentity(input, options);
  if (identityError) return { ok: false, message: identityError };
  const plan = input.frozenPlan!;
  const task = taskFor(input, options.variant);
  const duration = plan.generationIntent.output.durationSec;
  const aspectRatio = plan.generationIntent.output.aspectRatio;
  if (
    !task ||
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < 4 ||
    duration > 15 ||
    input.durationSec !== duration ||
    !RATIOS.has(aspectRatio as H3BaseSglangCreateBody["target"]["aspect_ratio"]) ||
    plan.generationIntent.output.fps !== 24 ||
    plan.generationIntent.output.resolution !== "768-short-edge" ||
    input.resolution !== "768-short-edge" ||
    plan.generationIntent.output.shotCount !== 1 ||
    plan.generationIntent.narrative.negativePrompt !== undefined ||
    Object.keys(input.params ?? {}).length !== 0 ||
    !["native_generate", "reference_conditioned"].includes(plan.outputAudioPolicy) ||
    (options.variant === "fl2va" && plan.outputAudioPolicy !== "native_generate")
  ) {
    return {
      ok: false,
      message:
        "The private H3 output shape is not the frozen 768-short-edge/24fps/4-15s video-and-audio contract.",
    };
  }
  const correlated = correlateSources(input);
  if (!correlated.ok) return correlated;
  if ((task === "t2va") !== (correlated.ordered.length === 0)) {
    return { ok: false, message: "The private H3 task and reference set do not match." };
  }
  const conditions: H3BaseSglangCondition[] = [];
  for (let index = 0; index < correlated.ordered.length; index += 1) {
    const item = correlated.ordered[index]!;
    const sourceError = validateSource(item.ref, item.slot.source);
    if (sourceError) return { ok: false, message: sourceError };
    let uri: string;
    try {
      uri = await options.materialize({ ref: item.ref, source: item.slot.source, index });
    } catch {
      return {
        ok: false,
        message: "The private H3 reference could not be staged for local serving.",
      };
    }
    if (!uri.startsWith("file:///")) {
      return { ok: false, message: "The private H3 materializer did not return a local file URI." };
    }
    const condition = conditionShape(options.variant, item.ref, uri);
    if (!condition) {
      return {
        ok: false,
        message: "A frozen reference role cannot be represented by this H3 Base partition.",
      };
    }
    conditions.push(condition);
  }
  const signature = conditions.map((item) => item.frame_index);
  if (
    task === "fl2va" &&
    !(
      (signature.length === 1 && (signature[0] === 0 || signature[0] === -1)) ||
      (signature.length === 2 && signature[0] === 0 && signature[1] === -1)
    )
  ) {
    return { ok: false, message: "FL2VA requires ordered first, last, or first+last keyframes." };
  }
  if (task === "ref2va" && (conditions.length === 0 || conditions.length > 4)) {
    return {
      ok: false,
      message: "Ref2VA requires between one and four ordered reference conditions.",
    };
  }
  if (task === "ref2va" && conditions.every((condition) => condition.type === "audio")) {
    return {
      ok: false,
      message: "Ref2VA audio references require at least one image or video reference.",
    };
  }
  if (task === "ref2va") {
    for (const mediaClass of ["video", "audio"] as const) {
      const references = correlated.ordered
        .map((item) => item.ref)
        .filter((ref) => ref.mediaClass === mediaClass);
      if (
        references.some(
          (ref) =>
            typeof ref.durationSec !== "number" ||
            !Number.isFinite(ref.durationSec) ||
            ref.durationSec < 2 ||
            ref.durationSec > 15,
        ) ||
        references.reduce((sum, ref) => sum + (ref.durationSec ?? 0), 0) > 15
      ) {
        return {
          ok: false,
          message: `Ref2VA ${mediaClass} references require exact 2-15 second durations and a 15 second aggregate maximum.`,
        };
      }
    }
  }
  const body: H3BaseSglangCreateBody = {
    model: H3_BASE_SGLANG_MODEL_ID,
    prompt: plan.generationIntent.compiledPrompt,
    seconds: duration,
    seed: 42,
    quality: "lossless",
    task,
    conditions,
    target: {
      short_edge: 768,
      aspect_ratio: aspectRatio as H3BaseSglangCreateBody["target"]["aspect_ratio"],
      duration_seconds: duration,
    },
    num_outputs_per_prompt: 1,
    num_inference_steps: 50,
    flow_shift: 12,
    audio_flow_shift: 3,
  };
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256").update(stableJson(body)).digest("hex")}`,
  };
}
