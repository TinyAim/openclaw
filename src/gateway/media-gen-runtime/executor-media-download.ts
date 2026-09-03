import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { MediaGenRuntimeFetch, MediaGenRuntimeVendorOutput } from "./types.js";

// Vendor-output MEDIA download + validation helpers, split out of executor.ts to
// keep that file under the 500-line cap. Pure/self-contained (host allow-list,
// MIME normalization, bounded streaming read, HTTPS + size-capped fetch); the
// executor calls `downloadMedia` in its succeeded-finalize path. No consent /
// orchestration logic lives here.

export function hostAllowed(url: URL, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) {
    return true;
  }
  return allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export function normalizeMime(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function mediaMimeAllowed(value: string): boolean {
  return value.startsWith("video/") || value.startsWith("image/");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  return host.split(".").map(Number)[0] === 127;
}

const CANONICAL_BASE64 = /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/u;

function readInlineDataUrl(
  output: MediaGenRuntimeVendorOutput,
  maxBytes: number,
): { bytes: Buffer; sha256: string; mimeType: string } | null {
  if (!output.mediaRef.startsWith("data:")) {
    return null;
  }
  const separator = output.mediaRef.indexOf(",");
  const header = separator >= 0 ? output.mediaRef.slice(5, separator) : "";
  const encoded = separator >= 0 ? output.mediaRef.slice(separator + 1) : "";
  if (!header.endsWith(";base64") || encoded.length === 0 || !CANONICAL_BASE64.test(encoded)) {
    throw new Error("inline media output is not canonical base64");
  }
  const inlineMime = normalizeMime(header.slice(0, -";base64".length));
  const vendorMime = normalizeMime(output.mimeType);
  if (!inlineMime || !mediaMimeAllowed(inlineMime) || !vendorMime || inlineMime !== vendorMime) {
    throw new Error("inline media output content-type is invalid or inconsistent");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (!Number.isInteger(decodedLength) || decodedLength <= 0 || decodedLength > maxBytes) {
    throw new Error("inline media output exceeds max bytes");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== decodedLength) {
    throw new Error("inline media output could not be decoded exactly");
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType: inlineMime,
  };
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
      if (done) {
        break;
      }
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
  // Some async providers (currently Veo) return the generated video directly
  // as base64 when no external bucket is configured. Keep those bytes bounded
  // inside the user runtime and feed them through the same quality/Artifact path.
  const inline = readInlineDataUrl(output, options.maxBytes);
  if (inline) {
    return inline;
  }
  const url = new URL(output.mediaRef);
  const privateLoopbackHttp =
    output.allowInsecureLoopback === true &&
    url.protocol === "http:" &&
    isLoopbackHost(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(options.allowInsecure && url.protocol === "http:") &&
    !privateLoopbackHttp
  ) {
    throw new Error("media output URL must be HTTPS");
  }
  if (!hostAllowed(url, options.allowedHosts)) {
    throw new Error(`media output host is not allowlisted: ${url.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await options.fetchImpl(url.toString(), {
      signal: controller.signal,
      ...(output.contentHeaders ? { headers: output.contentHeaders } : {}),
    });
    if (!res.ok) {
      throw new Error(`media output fetch failed with status ${res.status}`);
    }
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
