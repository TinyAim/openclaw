import { createHmac } from "node:crypto";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorInput,
  MediaGenRuntimeVendorJob,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.klingai.com";
const DEFAULT_MODEL = "kling-v1";

export type KlingRuntimeVendorOptions = {
  accessKey: string;
  secret: string;
  baseUrl?: string;
  fetchImpl?: MediaGenRuntimeFetch;
};

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(accessKey: string, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }));
  const signature = base64Url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function dataUri(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType || "image/png"};base64,${bytes.toString("base64")}`;
}

function splitVendorJobId(vendorJobId: string): [string, string] {
  const idx = vendorJobId.indexOf(":");
  if (idx <= 0) return ["text2video", vendorJobId];
  return [vendorJobId.slice(0, idx), vendorJobId.slice(idx + 1)];
}

function authHeaders(accessKey: string, secret: string): Record<string, string> {
  return {
    authorization: `Bearer ${signJwt(accessKey, secret)}`,
    "content-type": "application/json",
  };
}

function endpointFor(mode: MediaGenRuntimeVendorInput["mode"]): string {
  return mode === "image2video" ? "image2video" : "text2video";
}

export function createKlingRuntimeVendor(
  options: KlingRuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    presetId: "kling",
    isConfigured() {
      return options.accessKey.trim().length > 0 && options.secret.trim().length > 0;
    },
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      const endpoint = endpointFor(input.mode);
      const body: Record<string, unknown> = {
        model_name: (input.params?.model_name as string | undefined) ?? DEFAULT_MODEL,
        prompt: input.prompt ?? "",
        duration: String(input.durationSec ?? 5),
        aspect_ratio: (input.params?.aspect_ratio as string | undefined) ?? "16:9",
        cfg_scale: (input.params?.cfg_scale as number | undefined) ?? 0.5,
      };
      if (input.mode === "image2video") {
        if (!input.source) {
          return {
            state: "failed",
            reason: "content_blocked",
            message: "kling image2video requires source bytes on the runtime face",
          };
        }
        body.image = dataUri(input.source.bytes, input.source.mimeType);
      }
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/v1/videos/${endpoint}`, {
          method: "POST",
          headers: authHeaders(options.accessKey, options.secret),
          body: JSON.stringify(body),
        });
      } catch (error) {
        return {
          state: "failed",
          reason: "internal",
          message: `kling create network error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (res.status === 401 || res.status === 403) {
        return { state: "failed", reason: "auth", message: `kling auth rejected (${res.status})` };
      }
      if (res.status === 429) {
        return { state: "failed", reason: "quota", message: "kling quota/rate limit" };
      }
      const json = (await res.json().catch(() => ({}))) as KlingResponse;
      if (!res.ok || json.code !== 0) {
        return {
          state: "failed",
          reason: /quota|credit|balance|余额|配额|欠费/i.test(json.message ?? "")
            ? "quota"
            : /sensitive|moderation|policy|violat|审核|敏感|违规/i.test(json.message ?? "")
              ? "content_blocked"
              : "vendor_rejected",
          message: `kling create failed code=${json.code ?? res.status} ${json.message ?? ""}`.trim(),
        };
      }
      const taskId = json.data?.task_id;
      if (!taskId) {
        return { state: "failed", reason: "vendor_rejected", message: "kling returned no task_id" };
      }
      return { state: "processing", vendorJobId: `${endpoint}:${taskId}` };
    },
    async poll(vendorJobId): Promise<MediaGenRuntimeVendorJob> {
      const [endpoint, taskId] = splitVendorJobId(vendorJobId);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/v1/videos/${endpoint}/${taskId}`, {
          method: "GET",
          headers: authHeaders(options.accessKey, options.secret),
        });
      } catch {
        return { state: "processing", vendorJobId };
      }
      if (res.status === 401 || res.status === 403) {
        return { state: "failed", vendorJobId, reason: "auth", message: "kling auth rejected" };
      }
      const json = (await res.json().catch(() => ({}))) as KlingResponse;
      const status = json.data?.task_status;
      if (status === "succeed") {
        const url = json.data?.task_result?.videos?.[0]?.url;
        if (!url) {
          return {
            state: "failed",
            vendorJobId,
            reason: "download_failed",
            message: "kling succeeded without video url",
          };
        }
        return {
          state: "succeeded",
          vendorJobId,
          output: { mediaRef: url, mimeType: "video/mp4" },
        };
      }
      if (status === "failed") {
        return {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: json.data?.task_status_msg ?? "kling render failed",
        };
      }
      return { state: "processing", vendorJobId };
    },
  };
}

interface KlingResponse {
  code?: number;
  message?: string;
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: { videos?: Array<{ url?: string }> };
  };
}
