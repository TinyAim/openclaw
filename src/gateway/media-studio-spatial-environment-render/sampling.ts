import { PhotonImage } from "@silvia-odwyer/photon-node";
import { createRastermill } from "rastermill";
import { ModelFreePanoramaError } from "./types.js";

export interface RawRgbaLevel {
  pixels: Buffer;
  width: number;
  height: number;
}

const MAX_SOURCE_EDGE = 8192;
const MAX_SOURCE_PIXELS = 33_554_432;
const MAX_ENCODED_BYTES = 64 * 1024 * 1024;

export async function decodeNormalizedSource(encoded: Buffer): Promise<RawRgbaLevel> {
  if (!Buffer.isBuffer(encoded) || encoded.length < 1 || encoded.length > MAX_ENCODED_BYTES) {
    throw new ModelFreePanoramaError(
      "invalid_source",
      "sourceImage must contain at most 64 MiB of encoded image bytes",
    );
  }
  try {
    // Restrict Rastermill to its in-process Photon backend. This keeps the
    // commercial/runtime attestation exact: no undeclared ImageMagick, ffmpeg,
    // or host codec may be selected as an implicit fallback.
    const normalized = await createRastermill({
      execution: "internal",
      limits: {
        inputPixels: MAX_SOURCE_PIXELS,
        outputPixels: MAX_SOURCE_PIXELS,
      },
    }).encode(encoded, {
      format: "png",
      autoOrient: true,
      metadata: "strip",
      limits: {
        maxWidth: MAX_SOURCE_EDGE,
        maxHeight: MAX_SOURCE_EDGE,
        maxPixels: MAX_SOURCE_PIXELS,
      },
    });
    const photonImage = PhotonImage.new_from_byteslice(normalized.data);
    const width = photonImage.get_width();
    const height = photonImage.get_height();
    const pixels = Buffer.from(photonImage.get_raw_pixels());
    photonImage.free();
    if (
      width < 2 ||
      height < 2 ||
      width > MAX_SOURCE_EDGE ||
      height > MAX_SOURCE_EDGE ||
      width * height > MAX_SOURCE_PIXELS ||
      pixels.length !== width * height * 4
    ) {
      throw new ModelFreePanoramaError(
        "invalid_source",
        "decoded source dimensions are outside the supported range",
      );
    }
    return { pixels, width, height };
  } catch (error) {
    if (error instanceof ModelFreePanoramaError) {
      throw error;
    }
    throw new ModelFreePanoramaError(
      "source_decode_failed",
      `source image decode failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function buildMipPyramid(base: RawRgbaLevel): Promise<readonly RawRgbaLevel[]> {
  const levels: RawRgbaLevel[] = [base];
  for (const divisor of [2, 4]) {
    const width = Math.max(1, Math.floor(base.width / divisor));
    const height = Math.max(1, Math.floor(base.height / divisor));
    if (width === levels.at(-1)?.width && height === levels.at(-1)?.height) {
      continue;
    }
    // The pyramid is deliberately first-party and deterministic. Decoding is
    // the only third-party pixel operation; all generated pixels and scales
    // are reproducible from this fixed bilinear sampler.
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const v = height === 1 ? 0.5 : y / (height - 1);
      for (let x = 0; x < width; x += 1) {
        const u = width === 1 ? 0.5 : x / (width - 1);
        sampleBilinearRgba(base, u, v, pixels, (y * width + x) * 4);
      }
    }
    levels.push({ pixels, width, height });
  }
  return levels;
}

function channelAt(level: RawRgbaLevel, x: number, y: number, channel: number): number {
  return level.pixels[(y * level.width + x) * 4 + channel] ?? 0;
}

export function sampleBilinearRgba(
  level: RawRgbaLevel,
  u: number,
  v: number,
  target: Buffer,
  targetOffset: number,
): void {
  const px = Math.max(0, Math.min(level.width - 1, u * (level.width - 1)));
  const py = Math.max(0, Math.min(level.height - 1, v * (level.height - 1)));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(level.width - 1, x0 + 1);
  const y1 = Math.min(level.height - 1, y0 + 1);
  const tx = px - x0;
  const ty = py - y0;
  for (let channel = 0; channel < 4; channel += 1) {
    const top =
      channelAt(level, x0, y0, channel) * (1 - tx) + channelAt(level, x1, y0, channel) * tx;
    const bottom =
      channelAt(level, x0, y1, channel) * (1 - tx) + channelAt(level, x1, y1, channel) * tx;
    target[targetOffset + channel] = Math.round(top * (1 - ty) + bottom * ty);
  }
}

/**
 * Bilinear sampling with a continuous mip level. Blending adjacent levels
 * avoids visible rings where generated pixels move from one scale to another.
 */
export function sampleTrilinearRgba(
  levels: readonly RawRgbaLevel[],
  u: number,
  v: number,
  lod: number,
  target: Buffer,
  targetOffset: number,
): void {
  const maximumLevel = Math.max(0, levels.length - 1);
  const normalizedLod = Math.max(0, Math.min(maximumLevel, lod));
  const lowerIndex = Math.floor(normalizedLod);
  const upperIndex = Math.min(maximumLevel, lowerIndex + 1);
  const fraction = normalizedLod - lowerIndex;
  const lower = levels[lowerIndex];
  if (upperIndex === lowerIndex || fraction <= 0) {
    sampleBilinearRgba(lower, u, v, target, targetOffset);
    return;
  }
  const upper = levels[upperIndex];
  const lowerPx = Math.max(0, Math.min(lower.width - 1, u * (lower.width - 1)));
  const lowerPy = Math.max(0, Math.min(lower.height - 1, v * (lower.height - 1)));
  const lowerX0 = Math.floor(lowerPx);
  const lowerY0 = Math.floor(lowerPy);
  const lowerX1 = Math.min(lower.width - 1, lowerX0 + 1);
  const lowerY1 = Math.min(lower.height - 1, lowerY0 + 1);
  const lowerTx = lowerPx - lowerX0;
  const lowerTy = lowerPy - lowerY0;
  const upperPx = Math.max(0, Math.min(upper.width - 1, u * (upper.width - 1)));
  const upperPy = Math.max(0, Math.min(upper.height - 1, v * (upper.height - 1)));
  const upperX0 = Math.floor(upperPx);
  const upperY0 = Math.floor(upperPy);
  const upperX1 = Math.min(upper.width - 1, upperX0 + 1);
  const upperY1 = Math.min(upper.height - 1, upperY0 + 1);
  const upperTx = upperPx - upperX0;
  const upperTy = upperPy - upperY0;
  for (let channel = 0; channel < 4; channel += 1) {
    const lowerTop =
      channelAt(lower, lowerX0, lowerY0, channel) * (1 - lowerTx) +
      channelAt(lower, lowerX1, lowerY0, channel) * lowerTx;
    const lowerBottom =
      channelAt(lower, lowerX0, lowerY1, channel) * (1 - lowerTx) +
      channelAt(lower, lowerX1, lowerY1, channel) * lowerTx;
    const lowerValue = lowerTop * (1 - lowerTy) + lowerBottom * lowerTy;
    const upperTop =
      channelAt(upper, upperX0, upperY0, channel) * (1 - upperTx) +
      channelAt(upper, upperX1, upperY0, channel) * upperTx;
    const upperBottom =
      channelAt(upper, upperX0, upperY1, channel) * (1 - upperTx) +
      channelAt(upper, upperX1, upperY1, channel) * upperTx;
    const upperValue = upperTop * (1 - upperTy) + upperBottom * upperTy;
    target[targetOffset + channel] = Math.round(
      lowerValue * (1 - fraction) + upperValue * fraction,
    );
  }
}

export function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Mirror-repeat a scalar into a closed interval without introducing jumps. */
export function reflectIntoRange(value: number, minimum: number, maximum: number): number {
  const width = maximum - minimum;
  if (!(width > 0)) {
    return minimum;
  }
  const phase = positiveModulo(value - minimum, width * 2);
  return minimum + (phase <= width ? phase : width * 2 - phase);
}

export function reflectUnit(value: number): number {
  return reflectIntoRange(value, 0, 1);
}
