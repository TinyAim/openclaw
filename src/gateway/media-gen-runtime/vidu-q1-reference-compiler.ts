import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type {
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

export const VIDU_Q1_MODEL_ID = "viduq1";
export const VIDU_Q1_REFERENCE_ADAPTER_REVISION = "openclaw-vidu-q1-reference-runtime/v2";
export const VIDU_Q1_REFERENCE_ROUTE_ID = "vidu.enterprise.v2.viduq1.reference2video";
export const VIDU_Q1_REFERENCE_ENDPOINT_ID = "vidu.ent.v2.reference2video";
export const VIDU_Q1_REFERENCE_PROFILE_ID = "vidu.openclaw-runtime.viduq1.subject_reference.v1";
export const VIDU_Q1_REFERENCE_PROFILE_DIGEST =
  "sha256:b7cd6b7fe7adca80fd91a13f9f0c971b43d9a289cb696157596dbcf1e997ffa3";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const RATIOS = new Set<ViduQ1ReferenceCreateBody["aspect_ratio"]>(["16:9", "9:16", "1:1"]);
const MAX_IMAGE_BYTES = 10_000_000;
const MAX_BODY_BYTES = 20_000_000;

export type ViduQ1ReferenceCreateBody = {
  model: typeof VIDU_Q1_MODEL_ID;
  images: string[];
  prompt: string;
  duration: 5;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  resolution: "1080p";
  bgm: false;
  movement_amplitude: "auto";
  off_peak: false;
};

export type ViduQ1ReferenceCompileResult =
  | {
      ok: true;
      body: ViduQ1ReferenceCreateBody;
      providerRequestDigest: string;
    }
  | { ok: false; message: string };

function fail(message: string): ViduQ1ReferenceCompileResult {
  return { ok: false, message };
}

function normalizedSha256(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const token = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/u.test(token) ? token : null;
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function validateFrozenIdentity(input: MediaGenRuntimeVendorInput): string | null {
  const plan = input.frozenPlan;
  if (
    !plan ||
    input.presetId !== "vidu" ||
    input.mode !== "image2video" ||
    plan.presetId !== input.presetId ||
    plan.mode !== input.mode ||
    plan.generationIntent.legacyMode !== input.mode ||
    plan.generationScenario !== "subject_reference_to_video" ||
    plan.outputAudioPolicy !== "silent" ||
    plan.adapterRevision !== VIDU_Q1_REFERENCE_ADAPTER_REVISION ||
    plan.providerRouteRef.routeId !== VIDU_Q1_REFERENCE_ROUTE_ID ||
    plan.providerRouteRef.providerId !== "vidu_enterprise" ||
    plan.providerRouteRef.modelId !== VIDU_Q1_MODEL_ID ||
    plan.providerRouteRef.endpointId !== VIDU_Q1_REFERENCE_ENDPOINT_ID ||
    plan.providerRouteRef.region !== "unknown" ||
    plan.providerRouteRef.accountTier !== "api_key" ||
    plan.capabilityProfileRef.profileId !== VIDU_Q1_REFERENCE_PROFILE_ID ||
    plan.capabilityProfileRef.revision !== 1 ||
    plan.capabilityProfileRef.digest !== VIDU_Q1_REFERENCE_PROFILE_DIGEST
  ) {
    return "The frozen Vidu route/profile does not match Q1 Reference-to-Video.";
  }
  return input.prompt === plan.generationIntent.compiledPrompt
    ? null
    : "The runtime prompt does not match the frozen Vidu compiled prompt.";
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
    "output.fps",
  ]);
  if (
    plan.constraintPlan.some(
      (row) =>
        (row.providerField !== undefined && !fields.has(row.providerField)) ||
        (row.providerSlot !== undefined && row.providerSlot !== "references.subject"),
    )
  ) {
    return "The frozen Vidu plan contains an unimplemented provider mapping.";
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
      return `Vidu ${path} was not frozen as an exact native mapping.`;
    }
  }
  const prompt = plan.constraintPlan.find((row) => row.intentPath === "compiledPrompt");
  if (prompt?.support !== "prompt" || prompt.providerField !== "prompt") {
    return "The Vidu prompt was not frozen as the compiled provider prompt.";
  }
  for (const ref of plan.generationIntent.references) {
    const mapping = plan.constraintPlan.find(
      (row) => row.intentPath === `references.${ref.role}.${ref.ordinal}`,
    );
    if (mapping?.support !== "native" || mapping.providerSlot !== "references.subject") {
      return "A Vidu subject reference was not frozen as an exact native slot.";
    }
  }
  return Object.keys(input.params ?? {}).length === 0
    ? null
    : "Unplanned provider parameters are not accepted by the Vidu Q1 adapter.";
}

function correlateSources(
  references: readonly MediaGenerationIntentReference[],
  sources: readonly MediaGenRuntimeSourceSlot[],
): Map<string, MediaGenRuntimeSourceSlot> | null {
  if (references.length !== sources.length) {
    return null;
  }
  const mapped = new Map<string, MediaGenRuntimeSourceSlot>();
  for (const source of sources) {
    const key = `${source.role}:${source.ordinal}`;
    if (mapped.has(key)) {
      return null;
    }
    mapped.set(key, source);
  }
  return references.every((ref) => mapped.has(`${ref.role}:${ref.ordinal}`)) ? mapped : null;
}

function providerImage(
  reference: MediaGenerationIntentReference,
  source: MediaGenRuntimeSource,
): string | null {
  if (
    reference.role !== "subject" ||
    reference.mediaClass !== "image" ||
    !reference.required ||
    !reference.authorityVerified
  ) {
    return null;
  }
  const mimeType = source.mimeType.trim().toLowerCase();
  if (!IMAGE_MIME_TYPES.has(mimeType) || reference.mimeType?.trim().toLowerCase() !== mimeType) {
    return null;
  }
  const expectedSha = normalizedSha256(reference.sourceDigest);
  const resolvedSha = normalizedSha256(source.sha256);
  if (!expectedSha || resolvedSha !== expectedSha) {
    return null;
  }

  if (source.providerRef) {
    return reference.source.kind === "runtime_local" ? httpsUrl(source.providerRef) : null;
  }
  const bytes = source.bytes;
  if (
    reference.source.kind !== "artifact" ||
    !bytes ||
    bytes.length === 0 ||
    bytes.length >= MAX_IMAGE_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha
  ) {
    return null;
  }
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

/** Compile one exact Vidu Q1 reference2video request without passthrough. */
export function compileViduQ1ReferenceRequest(
  input: MediaGenRuntimeVendorInput,
): ViduQ1ReferenceCompileResult {
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
  const ratio = output.aspectRatio;
  const fpsMapping =
    output.fps === undefined
      ? undefined
      : input.frozenPlan!.constraintPlan.find((row) => row.intentPath === "output.fps");
  if (
    intent.generationScenario !== "subject_reference_to_video" ||
    intent.outputAudioPolicy !== "silent" ||
    intent.compiledPrompt.trim().length === 0 ||
    intent.compiledPrompt.length > 5_000 ||
    intent.narrative.negativePrompt !== undefined ||
    output.shotCount !== 1 ||
    output.durationSec !== 5 ||
    input.durationSec !== 5 ||
    output.resolution !== "1080p" ||
    input.resolution !== "1080p" ||
    typeof ratio !== "string" ||
    !RATIOS.has(ratio as ViduQ1ReferenceCreateBody["aspect_ratio"]) ||
    (output.fps !== undefined &&
      (output.fps !== 24 ||
        fpsMapping?.support !== "native" ||
        fpsMapping.providerField !== "output.fps"))
  ) {
    return fail("The frozen Vidu output constraints are incomplete or unsupported.");
  }

  const references = intent.references;
  const sources = input.sources ?? [];
  if (
    input.source ||
    references.length < 1 ||
    references.length > 7 ||
    references.some(
      (ref, index) => ref.role !== "subject" || ref.ordinal !== index || ref.mediaClass !== "image",
    )
  ) {
    return fail("Vidu Q1 requires one to seven ordered subject image references.");
  }
  const mapped = correlateSources(references, sources);
  if (!mapped) {
    return fail("Resolved Vidu reference slots do not match the frozen plan.");
  }
  const images: string[] = [];
  for (const reference of references) {
    const image = providerImage(
      reference,
      mapped.get(`${reference.role}:${reference.ordinal}`)!.source,
    );
    if (!image) {
      return fail("A frozen Vidu subject image failed MIME, digest, or source verification.");
    }
    images.push(image);
  }

  const body: ViduQ1ReferenceCreateBody = {
    model: VIDU_Q1_MODEL_ID,
    images,
    prompt: intent.compiledPrompt,
    duration: 5,
    aspect_ratio: ratio as ViduQ1ReferenceCreateBody["aspect_ratio"],
    resolution: "1080p",
    bgm: false,
    movement_amplitude: "auto",
    off_peak: false,
  };
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") >= MAX_BODY_BYTES) {
    return fail("The Vidu request body exceeds the documented 20 MB limit.");
  }
  return {
    ok: true,
    body,
    providerRequestDigest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}
