import { createHash } from "node:crypto";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendorOutput,
} from "./types.js";

// Vendor-output MEDIA download + validation helpers, split out of executor.ts to
// keep that file under the 500-line cap. Pure/self-contained (host allow-list,
// MIME normalization, bounded streaming read, HTTPS + size-capped fetch); the
// executor calls `downloadMedia` in its succeeded-finalize path. No consent /
// orchestration logic lives here.

export function hostAllowed(url: URL, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export function normalizeMime(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function mediaMimeAllowed(value: string): boolean {
  return value.startsWith("video/") || value.startsWith("image/");
}

export async function readBoundedBody(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) {
    throw new Error("media output response has no readable body");
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("media output exceeds max bytes");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadMedia(
  output: MediaGenRuntimeVendorOutput,
  options: {
    fetchImpl: MediaGenRuntimeFetch;
    timeoutMs: number;
    maxBytes: number;
    allowedHosts: string[];
    allowInsecure: boolean;
  },
): Promise<{ bytes: Buffer; sha256: string; mimeType: string }> {
  const url = new URL(output.mediaRef);
  if (url.protocol !== "https:" && !(options.allowInsecure && url.protocol === "http:")) {
    throw new Error("media output URL must be HTTPS");
  }
  if (!hostAllowed(url, options.allowedHosts)) {
    throw new Error(`media output host is not allowlisted: ${url.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await options.fetchImpl(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`media output fetch failed with status ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new Error("media output exceeds max bytes");
    }
    const responseMime = normalizeMime(res.headers.get("content-type"));
    const vendorMime = normalizeMime(output.mimeType);
    const mimeType = responseMime || vendorMime;
    if (!mimeType || !mediaMimeAllowed(mimeType)) {
      throw new Error(`media output content-type not allowed: ${mimeType || "missing"}`);
    }
    const bytes = await readBoundedBody(res, options.maxBytes);
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType,
    };
  } finally {
    clearTimeout(timer);
  }
}
