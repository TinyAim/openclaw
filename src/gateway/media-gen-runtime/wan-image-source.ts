import { createHash } from "node:crypto";
import type { MediaGenerationIntentReference } from "./frozen-plan.js";
import type { MediaGenRuntimeSource } from "./types.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_IMAGE_EDGE = 240;
const MAX_IMAGE_EDGE = 8_000;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export const WAN_ASPECT_RATIO_PARTS = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
  "4:3": [4, 3],
  "3:4": [3, 4],
} as const;

export type WanAspectRatio = keyof typeof WAN_ASPECT_RATIO_PARTS;
type WanFrameRole = "first_frame" | "last_frame";
type ImageDimensions = { width: number; height: number };

function normalizedSha256(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/u.test(hex) ? hex : null;
}

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, signature.length).equals(signature) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) {
    return null;
  }

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    if (chunkLength > bytes.length - offset - 12) {
      return null;
    }
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    if (chunkType === "tRNS") {
      return null;
    }
    offset += chunkLength + 12;
    if (chunkType === "IEND") {
      break;
    }
  }
  return { width, height };
}

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      return null;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) {
      return null;
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) {
        return null;
      }
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function imageDimensions(bytes: Buffer, mimeType: string): ImageDimensions | null {
  return mimeType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
}

function matchesRatio(dimensions: ImageDimensions, ratio: WanAspectRatio): boolean {
  const [widthPart, heightPart] = WAN_ASPECT_RATIO_PARTS[ratio];
  return dimensions.width * heightPart === dimensions.height * widthPart;
}

/** Materialize one authority-checked Artifact frame as a provider-local data URI. */
export function wanImageDataUri(input: {
  reference: MediaGenerationIntentReference;
  source: MediaGenRuntimeSource;
  role: WanFrameRole;
  expectedRatio?: WanAspectRatio;
}): string | null {
  const { reference, source } = input;
  if (
    reference.role !== input.role ||
    reference.ordinal !== 0 ||
    reference.mediaClass !== "image" ||
    reference.source.kind !== "artifact" ||
    !reference.assetRefId ||
    !reference.authorityRef ||
    !reference.authorityVerified ||
    !source.bytes ||
    source.bytes.length === 0 ||
    source.bytes.length > MAX_IMAGE_BYTES ||
    source.providerRef
  ) {
    return null;
  }
  const mimeType = source.mimeType.trim().toLowerCase();
  if (!IMAGE_MIME_TYPES.has(mimeType) || reference.mimeType?.trim().toLowerCase() !== mimeType) {
    return null;
  }
  const expectedSha256 = normalizedSha256(reference.sourceDigest);
  const resolvedSha256 = normalizedSha256(source.sha256);
  const actualSha256 = createHash("sha256").update(source.bytes).digest("hex");
  const dimensions = imageDimensions(source.bytes, mimeType);
  if (
    !expectedSha256 ||
    resolvedSha256 !== expectedSha256 ||
    actualSha256 !== expectedSha256 ||
    !dimensions ||
    dimensions.width < MIN_IMAGE_EDGE ||
    dimensions.width > MAX_IMAGE_EDGE ||
    dimensions.height < MIN_IMAGE_EDGE ||
    dimensions.height > MAX_IMAGE_EDGE ||
    (input.expectedRatio !== undefined && !matchesRatio(dimensions, input.expectedRatio))
  ) {
    return null;
  }
  return `data:${mimeType};base64,${source.bytes.toString("base64")}`;
}
