import { createHash } from "node:crypto";
import type { MediaGenRuntimeSourceSlot, MediaGenRuntimeVendorInput } from "./types.js";

export const KLING_APIKEY_2_6_I2V_ROUTE_ID = "kling-apikey-2.6-i2v-sg/v1";
export const KLING_APIKEY_2_6_I2V_ADAPTER_REVISION = "openclaw-kling-apikey-2.6-i2v-runtime/v1";
export const KLING_APIKEY_2_6_I2V_MODEL_ID = "kling-2.6";
export const KLING_APIKEY_2_6_I2V_ENDPOINT_ID = "kling.api.v2.image-to-video";

export type KlingApiKeyI2VContentItem =
  | { type: "prompt"; text: string }
  | { type: "first_frame"; url: string }
  | { type: "last_frame"; url: string };

export type KlingApiKeyI2VSettings = {
  duration: 5 | 10;
  resolution: "720p" | "1080p";
  audio: "off" | "native";
};

export type KlingApiKeyI2VOptions = {
  external_task_id?: string;
};

export type KlingApiKeyI2VCreateBody = {
  contents: KlingApiKeyI2VContentItem[];
  settings: KlingApiKeyI2VSettings;
  options?: KlingApiKeyI2VOptions;
};

export type KlingApiKeyI2VCompileResult =
  | {
      ok: true;
      body: KlingApiKeyI2VCreateBody;
      providerRequestDigest: string;
      externalTaskId?: string;
    }
  | { ok: false; message: string };

function fail(message: string): KlingApiKeyI2VCompileResult {
  return { ok: false, message };
}

export function compileKlingApiKeyI2VRequest(
  input: MediaGenRuntimeVendorInput,
): KlingApiKeyI2VCompileResult {
  if (input.mode !== "image2video") {
    return fail("Kling API Key 2.6 I2V compiler requires mode image2video.");
  }

  const prompt = (input.frozenPlan?.generationIntent.compiledPrompt ?? input.prompt ?? "").trim();

  if (!prompt) {
    return fail("Prompt must not be empty for Kling API Key 2.6 I2V.");
  }
  if (prompt.length > 2500) {
    return fail("Prompt exceeds 2500 characters limit for Kling API Key 2.6 I2V.");
  }

  const sources = input.sources ?? [];
  let firstFrameSlot: MediaGenRuntimeSourceSlot | undefined;
  let lastFrameSlot: MediaGenRuntimeSourceSlot | undefined;

  for (const src of sources) {
    if (src.role === "first_frame") {
      if (firstFrameSlot) {
        return fail("Only 1 first_frame reference is allowed for Kling API Key 2.6 I2V.");
      }
      firstFrameSlot = src;
    } else if (src.role === "last_frame") {
      if (lastFrameSlot) {
        return fail("Only 1 last_frame reference is allowed for Kling API Key 2.6 I2V.");
      }
      lastFrameSlot = src;
    } else {
      return fail(`Unsupported reference role '${src.role}' for Kling API Key 2.6 I2V.`);
    }
  }

  if (!firstFrameSlot) {
    return fail("first_frame reference is required for Kling API Key 2.6 I2V.");
  }

  const firstFrameUrl = firstFrameSlot.sourceUrl;
  if (!firstFrameUrl) {
    return fail("first_frame reference must have a sourceUrl.");
  }

  let duration: 5 | 10 = 5;
  const rawDuration = input.durationSec ?? input.frozenPlan?.generationIntent.output.durationSec;
  if (rawDuration === 10) {
    duration = 10;
  } else if (rawDuration && rawDuration !== 5) {
    return fail("Duration must be 5 or 10 seconds for Kling API Key 2.6 I2V.");
  }

  let resolution: "720p" | "1080p" = "720p";
  const rawResolution = input.resolution ?? input.frozenPlan?.generationIntent.output.resolution;
  if (rawResolution === "1080p" || rawResolution === "1080") {
    resolution = "1080p";
  }

  if (lastFrameSlot && resolution !== "1080p") {
    resolution = "1080p";
  }

  let audio: "off" | "native" = "off";
  const rawAudio = input.outputAudioPolicy ?? input.frozenPlan?.generationIntent.output.audioPolicy;
  if (rawAudio === "native" || rawAudio === "native_generate") {
    audio = "native";
    resolution = "1080p";
  }

  const contents: KlingApiKeyI2VContentItem[] = [
    { type: "prompt", text: prompt },
    { type: "first_frame", url: firstFrameUrl },
  ];

  if (lastFrameSlot) {
    const lastFrameUrl = lastFrameSlot.sourceUrl;
    if (!lastFrameUrl) {
      return fail("last_frame reference must have a sourceUrl.");
    }
    contents.push({ type: "last_frame", url: lastFrameUrl });
  }

  const externalTaskId =
    (input as any).options?.externalTaskId ??
    (input as any).options?.external_task_id ??
    (input.frozenPlan?.studioSubmitSource?.studioPreviewId
      ? `ext_${input.frozenPlan.studioSubmitSource.studioPreviewId}`
      : input.taskId);

  const body: KlingApiKeyI2VCreateBody = {
    contents,
    settings: {
      duration,
      resolution,
      audio,
    },
    ...(externalTaskId ? { options: { external_task_id: externalTaskId } } : {}),
  };

  const providerRequestDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex")}`;

  return {
    ok: true,
    body,
    providerRequestDigest,
    externalTaskId,
  };
}
