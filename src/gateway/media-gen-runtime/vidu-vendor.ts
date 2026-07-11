// CP3-d — Vidu runtime vendor (生数科技 Shengshu), the FIRST runtime vendor that
// consumes a multi-slot `input.sources[]` and maps it onto Vidu's top-level
// `images[]` (reference-to-video subject consistency, 1–7 images). Active only
// when a Vidu API key is configured (fail-closed behind credentials).
//
// Vidu enterprise contract (mirrors the verified control-plane adapter, 2026-06):
//   • Auth:   Authorization: Token <key>   (custom scheme, NOT Bearer)
//   • Create: POST {base}/text2video | {base}/img2video
//       body {model, prompt, images?:[<dataUri>], duration, resolution,
//             aspect_ratio} → {task_id, state}
//   • Poll:   GET  {base}/tasks/{task_id}/creations
//       → {state: created|queueing|processing|success|failed, err_code,
//          creations:[{url}]}
//
// Honesty (CP3 §8): this vendor declares `supportsMultiReference: true` ONLY
// because it truly maps every resolved subject slot onto `images[]` — it NEVER
// silently keeps just the first slot. A non-subject role (Vidu only declares the
// `subject` role in the CP3 catalogue) is rejected fail-closed rather than
// mis-placed as a subject image.
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorInput,
  MediaGenRuntimeVendorJob,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.vidu.com/ent/v2";
const DEFAULT_MODEL = "viduq1";
// CP3 §6.2 — Vidu's officially-verified subject image ceiling (reference-to-video).
const MAX_SUBJECT_IMAGES = 7;

export type ViduRuntimeVendorOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
};

function dataUri(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType || "image/png"};base64,${bytes.toString("base64")}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  // Vidu uses the custom `Token` scheme, not `Bearer`.
  return {
    authorization: `Token ${apiKey}`,
    "content-type": "application/json",
  };
}

function endpointFor(mode: MediaGenRuntimeVendorInput["mode"]): string {
  return mode === "image2video" ? "img2video" : "text2video";
}

function looksLikeQuota(message: string): boolean {
  return /quota|credit|balance|余额|配额|欠费/i.test(message);
}

function looksLikeContentBlock(message: string): boolean {
  return /sensitive|moderation|policy|violat|审核|敏感|违规/i.test(message);
}

/**
 * Collect the data URIs Vidu's `images[]` expects. Prefers the multi-slot
 * `sources[]` (CP3) and falls back to the singular `source`. Every multi-slot
 * entry MUST be a `subject` (the only role Vidu declares); any other role is
 * rejected so a mis-tagged source is never silently treated as a subject image.
 */
function collectImages(
  input: MediaGenRuntimeVendorInput,
): { ok: true; images: string[] } | { ok: false; message: string } {
  if (input.sources && input.sources.length > 0) {
    const images: string[] = [];
    for (const slot of input.sources as MediaGenRuntimeSourceSlot[]) {
      if (slot.role !== "subject") {
        return {
          ok: false,
          message: `vidu only maps the "subject" reference role; got "${slot.role}"`,
        };
      }
      images.push(dataUri(slot.source.bytes, slot.source.mimeType));
    }
    if (images.length > MAX_SUBJECT_IMAGES) {
      return {
        ok: false,
        message: `vidu accepts at most ${MAX_SUBJECT_IMAGES} subject images (got ${images.length})`,
      };
    }
    return { ok: true, images };
  }
  if (input.source) {
    return { ok: true, images: [dataUri(input.source.bytes, input.source.mimeType)] };
  }
  return { ok: true, images: [] };
}

export function createViduRuntimeVendor(
  options: ViduRuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    presetId: "vidu",
    supportsMultiReference: true,
    isConfigured() {
      return options.apiKey.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const collected = collectImages(input);
      if (!collected.ok) {
        return { state: "failed", reason: "vendor_rejected", message: collected.message };
      }
      if (input.mode === "image2video" && collected.images.length === 0) {
        return {
          state: "failed",
          reason: "content_blocked",
          message: "vidu image2video requires source bytes on the runtime face",
        };
      }
      const endpoint = endpointFor(input.mode);
      const body: Record<string, unknown> = {
        model: (input.params?.model as string | undefined) ?? DEFAULT_MODEL,
        prompt: input.prompt ?? "",
        duration: input.durationSec ?? 5,
        resolution: input.resolution ?? "720p",
        aspect_ratio: (input.params?.aspect_ratio as string | undefined) ?? "16:9",
      };
      // Reference-to-video subject consistency: every resolved subject source is
      // a top-level `images[]` entry (1–7). Absent for plain text2video.
      if (collected.images.length > 0) {
        body.images = collected.images;
      }

      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/${endpoint}`, {
          method: "POST",
          headers: authHeaders(options.apiKey),
          body: JSON.stringify(body),
        });
      } catch (error) {
        return {
          state: "failed",
          reason: "internal",
          message: `vidu create network error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (res.status === 401 || res.status === 403) {
        return { state: "failed", reason: "auth", message: `vidu auth rejected (${res.status})` };
      }
      if (res.status === 429) {
        return { state: "failed", reason: "quota", message: "vidu quota/rate limit" };
      }
      const json = (await res.json().catch(() => ({}))) as ViduCreateResponse;
      if (!res.ok) {
        const message = json.message ?? `vidu create http ${res.status}`;
        return {
          state: "failed",
          reason: looksLikeQuota(message)
            ? "quota"
            : looksLikeContentBlock(message)
              ? "content_blocked"
              : "vendor_rejected",
          message: `vidu create failed: ${message}`,
        };
      }
      const taskId = json.task_id;
      if (!taskId) {
        return { state: "failed", reason: "vendor_rejected", message: "vidu create returned no task_id" };
      }
      return { state: "processing", vendorJobId: taskId };
    },
    async poll(vendorJobId): Promise<MediaGenRuntimeVendorJob> {
      let res: Response;
      try {
        res = await fetchImpl(
          `${baseUrl}/tasks/${encodeURIComponent(vendorJobId)}/creations`,
          { method: "GET", headers: authHeaders(options.apiKey) },
        );
      } catch {
        return { state: "processing", vendorJobId };
      }
      if (res.status === 401 || res.status === 403) {
        return { state: "failed", vendorJobId, reason: "auth", message: "vidu auth rejected" };
      }
      const json = (await res.json().catch(() => ({}))) as ViduCreationsResponse;
      const state = json.state;
      if (state === "success") {
        const url = json.creations?.[0]?.url;
        if (!url) {
          return {
            state: "failed",
            vendorJobId,
            reason: "download_failed",
            message: "vidu success without creation url",
          };
        }
        return { state: "succeeded", vendorJobId, output: { mediaRef: url, mimeType: "video/mp4" } };
      }
      if (state === "failed") {
        const message = json.err_code || "vidu render failed";
        return {
          state: "failed",
          vendorJobId,
          reason: looksLikeContentBlock(message) ? "content_blocked" : "vendor_failed",
          message,
        };
      }
      return { state: "processing", vendorJobId };
    },
  };
}

interface ViduCreateResponse {
  task_id?: string;
  state?: string;
  message?: string;
}

interface ViduCreationsResponse {
  state?: string;
  err_code?: string;
  creations?: Array<{ url?: string }>;
}
