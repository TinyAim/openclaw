import { createHash } from "node:crypto";
import { encodePngRgba } from "../../media/png-encode.js";
import {
  buildMipPyramid,
  decodeNormalizedSource,
  reflectIntoRange,
  reflectUnit,
  sampleBilinearRgba,
  sampleTrilinearRgba,
} from "./sampling.js";
import {
  MODEL_FREE_PANORAMA_ALGORITHM_ID,
  MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_CANONICAL,
  MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST,
  MODEL_FREE_PANORAMA_CONTRACT_VERSION,
  MODEL_FREE_PANORAMA_NOTICE_REF,
  MODEL_FREE_PANORAMA_QUALITY_LIMITS,
  MODEL_FREE_PANORAMA_RUNTIME_BUILD_DIGEST,
  ModelFreePanoramaError,
  type ModelFreePanoramaQualityReport,
  type ModelFreePanoramaRequest,
  type ModelFreePanoramaResult,
} from "./types.js";

const MIN_OUTPUT_WIDTH = 256;
const MAX_OUTPUT_WIDTH = 4096;
const MIN_HORIZONTAL_FOV_DEGREES = 20;
const MAX_HORIZONTAL_FOV_DEGREES = 160;
const DEG_TO_RAD = Math.PI / 180;
const SOURCE_BOUNDARY_FEATHER_WIDTH_UV = 0.12;
const POLE_STABILIZATION_START_RADIANS = 70 * DEG_TO_RAD;

function checksum(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function validateRequest(request: ModelFreePanoramaRequest): void {
  if (
    !Number.isFinite(request.horizontalFovDegrees) ||
    request.horizontalFovDegrees < MIN_HORIZONTAL_FOV_DEGREES ||
    request.horizontalFovDegrees > MAX_HORIZONTAL_FOV_DEGREES
  ) {
    throw new ModelFreePanoramaError(
      "invalid_horizontal_fov",
      `horizontalFovDegrees must be in [${MIN_HORIZONTAL_FOV_DEGREES},${MAX_HORIZONTAL_FOV_DEGREES}]`,
    );
  }
  if (
    !Number.isInteger(request.outputWidth) ||
    request.outputWidth < MIN_OUTPUT_WIDTH ||
    request.outputWidth > MAX_OUTPUT_WIDTH ||
    request.outputWidth % 2 !== 0
  ) {
    throw new ModelFreePanoramaError(
      "invalid_output_dimensions",
      `outputWidth must be an even integer in [${MIN_OUTPUT_WIDTH},${MAX_OUTPUT_WIDTH}]`,
    );
  }
  if (
    request.centerYawDegrees !== undefined &&
    (!Number.isFinite(request.centerYawDegrees) ||
      request.centerYawDegrees < -180 ||
      request.centerYawDegrees > 180)
  ) {
    throw new ModelFreePanoramaError(
      "invalid_horizontal_fov",
      "centerYawDegrees must be in [-180,180]",
    );
  }
}

function wrapRadians(value: number): number {
  return ((((value + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  const normalized = clampUnit((value - minimum) / (maximum - minimum));
  return normalized * normalized * (3 - 2 * normalized);
}

function generatedMipLevel(angularDistance: number, maximumLevel: number): number {
  if (maximumLevel <= 0 || angularDistance <= 0) {
    return 0;
  }
  const firstTransition = Math.PI * 0.1;
  if (angularDistance <= firstTransition) {
    return Math.min(maximumLevel, angularDistance / firstTransition);
  }
  const secondTransition = Math.PI * 0.2;
  return Math.min(maximumLevel, 1 + (angularDistance - firstTransition) / secondTransition);
}

function sampledBandMeanRgba(
  source: Awaited<ReturnType<typeof decodeNormalizedSource>>,
  fromY: number,
  toY: number,
): readonly [number, number, number, number] {
  const columns = Math.min(128, source.width);
  const rows = Math.min(32, Math.max(1, toY - fromY));
  const sums = [0, 0, 0, 0];
  let count = 0;
  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(
      source.height - 1,
      fromY + Math.floor(((row + 0.5) / rows) * Math.max(1, toY - fromY)),
    );
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(source.width - 1, Math.floor(((column + 0.5) / columns) * source.width));
      const offset = (y * source.width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        sums[channel] = (sums[channel] ?? 0) + (source.pixels[offset + channel] ?? 0);
      }
      count += 1;
    }
  }
  return [
    Math.round((sums[0] ?? 0) / count),
    Math.round((sums[1] ?? 0) / count),
    Math.round((sums[2] ?? 0) / count),
    Math.round((sums[3] ?? 0) / count),
  ];
}

function blendPixel(
  target: Buffer,
  targetOffset: number,
  sample: ArrayLike<number>,
  strength: number,
): void {
  if (!(strength > 0)) {
    return;
  }
  const normalizedStrength = clampUnit(strength);
  for (let channel = 0; channel < 4; channel += 1) {
    const current = target[targetOffset + channel] ?? 0;
    const next = sample[channel] ?? 0;
    target[targetOffset + channel] = Math.round(
      current * (1 - normalizedStrength) + next * normalizedStrength,
    );
  }
}

function optimizeGeneratedSeam(input: {
  pixels: Buffer;
  mask: Buffer;
  width: number;
  height: number;
}): number {
  const seamWidth = Math.min(24, Math.max(4, Math.round(input.width / 128)));
  let optimizedPairs = 0;
  for (let y = 0; y < input.height; y += 1) {
    for (let inset = 0; inset < seamWidth; inset += 1) {
      const leftPixel = y * input.width + inset;
      const rightPixel = y * input.width + (input.width - 1 - inset);
      if (input.mask[leftPixel] !== 255 || input.mask[rightPixel] !== 255) {
        continue;
      }
      const strength = 1 - inset / seamWidth;
      const leftOffset = leftPixel * 4;
      const rightOffset = rightPixel * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const left = input.pixels[leftOffset + channel] ?? 0;
        const right = input.pixels[rightOffset + channel] ?? 0;
        const average = (left + right) / 2;
        input.pixels[leftOffset + channel] = Math.round(left * (1 - strength) + average * strength);
        input.pixels[rightOffset + channel] = Math.round(
          right * (1 - strength) + average * strength,
        );
      }
      optimizedPairs += 1;
    }
  }
  return optimizedPairs;
}

function seamMeanAbsoluteError(pixels: Buffer, width: number, height: number): number {
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    const left = y * width * 4;
    const right = (y * width + width - 1) * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      total += Math.abs((pixels[left + channel] ?? 0) - (pixels[right + channel] ?? 0));
    }
  }
  return total / (height * 3);
}

function rowMeanAdjacentAbsoluteError(pixels: Buffer, width: number, row: number): number {
  let total = 0;
  for (let x = 0; x < width; x += 1) {
    const nextX = (x + 1) % width;
    const currentOffset = (row * width + x) * 4;
    const nextOffset = (row * width + nextX) * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      total += Math.abs(
        (pixels[currentOffset + channel] ?? 0) - (pixels[nextOffset + channel] ?? 0),
      );
    }
  }
  return total / (width * 3);
}

/**
 * Deterministic, model-free perspective-to-equirectangular completion.
 *
 * Source-visible pixels are sampled only from the calibrated perspective
 * projection. Unknown directions use mirror-periodic texture quilting at
 * coarser mip levels as angular distance grows. This creates a usable 3DoF
 * backdrop, not hidden-scene recovery or metric geometry.
 */
export async function renderModelFreePanorama(
  request: ModelFreePanoramaRequest,
): Promise<ModelFreePanoramaResult> {
  validateRequest(request);
  const source = await decodeNormalizedSource(request.sourceImage);
  const pyramid = await buildMipPyramid(source);
  const width = request.outputWidth;
  const height = width / 2;
  const horizontalFov = request.horizontalFovDegrees * DEG_TO_RAD;
  const halfHorizontalFov = horizontalFov / 2;
  const tanHalfHorizontalFov = Math.tan(halfHorizontalFov);
  const verticalFov = 2 * Math.atan(tanHalfHorizontalFov * (source.height / source.width));
  const halfVerticalFov = verticalFov / 2;
  const tanHalfVerticalFov = Math.tan(halfVerticalFov);
  const centerYaw = (request.centerYawDegrees ?? 0) * DEG_TO_RAD;
  const output = Buffer.alloc(width * height * 4);
  const generatedMask = Buffer.alloc(width * height);
  const boundarySample = Buffer.allocUnsafe(4);
  const sourceBandHeight = Math.max(1, Math.round(source.height * 0.12));
  const northPoleColor = sampledBandMeanRgba(source, 0, sourceBandHeight);
  const southPoleColor = sampledBandMeanRgba(
    source,
    source.height - sourceBandHeight,
    source.height,
  );
  const relativeYaws = new Float64Array(width);
  const yawCosines = new Float64Array(width);
  const yawSines = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    const worldYaw = ((x + 0.5) / width - 0.5) * Math.PI * 2;
    const relativeYaw = wrapRadians(worldYaw - centerYaw);
    relativeYaws[x] = relativeYaw;
    yawCosines[x] = Math.cos(relativeYaw);
    yawSines[x] = Math.sin(relativeYaw);
  }

  let sourceLockedPixelCount = 0;
  let sourceBoundaryFeatheredPixelCount = 0;
  let continuousMipBlendPixelCount = 0;
  let poleStabilizedPixelCount = 0;
  for (let y = 0; y < height; y += 1) {
    const pitch = (0.5 - (y + 0.5) / height) * Math.PI;
    const tanPitch = Math.tan(pitch);
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const outputOffset = pixelIndex * 4;
      const relativeYaw = relativeYaws[x] ?? 0;
      const cosineYaw = yawCosines[x] ?? 1;
      const sourceU = 0.5 + Math.tan(relativeYaw) / (2 * tanHalfHorizontalFov);
      const sourceV = 0.5 - tanPitch / (Math.max(1e-9, cosineYaw) * 2 * tanHalfVerticalFov);
      const visible = cosineYaw > 0 && sourceU >= 0 && sourceU <= 1 && sourceV >= 0 && sourceV <= 1;
      if (visible) {
        sampleBilinearRgba(pyramid[0], sourceU, sourceV, output, outputOffset);
        sourceLockedPixelCount += 1;
        continue;
      }

      generatedMask[pixelIndex] = 255;
      const yawShear = Math.sin(pitch * 2) * halfHorizontalFov * 0.18;
      const pitchShear = (yawSines[x] ?? 0) * halfVerticalFov * 0.12;
      const foldedYaw = reflectIntoRange(
        relativeYaw + yawShear,
        -halfHorizontalFov,
        halfHorizontalFov,
      );
      const foldedPitch = reflectIntoRange(pitch + pitchShear, -halfVerticalFov, halfVerticalFov);
      const quiltU = reflectUnit(0.5 + Math.tan(foldedYaw) / (2 * tanHalfHorizontalFov));
      const quiltV = reflectUnit(
        0.5 - Math.tan(foldedPitch) / (Math.cos(foldedYaw) * 2 * tanHalfVerticalFov),
      );
      const angularDistance = Math.hypot(
        Math.max(0, Math.abs(relativeYaw) - halfHorizontalFov),
        Math.max(0, Math.abs(pitch) - halfVerticalFov),
      );
      const mipLevel = generatedMipLevel(angularDistance, pyramid.length - 1);
      if (mipLevel > 0 && Math.abs(mipLevel - Math.round(mipLevel)) > 1e-6) {
        continuousMipBlendPixelCount += 1;
      }
      sampleTrilinearRgba(pyramid, quiltU, quiltV, mipLevel, output, outputOffset);

      // The source side of the boundary remains byte-for-byte untouched. Only
      // generated pixels feather toward the nearest calibrated source edge.
      const outsideU = sourceU < 0 ? -sourceU : sourceU > 1 ? sourceU - 1 : 0;
      const outsideV = sourceV < 0 ? -sourceV : sourceV > 1 ? sourceV - 1 : 0;
      const boundaryDistance = Math.hypot(outsideU, outsideV);
      const boundaryWeight =
        cosineYaw > 0 ? 1 - smoothstep(0, SOURCE_BOUNDARY_FEATHER_WIDTH_UV, boundaryDistance) : 0;
      if (boundaryWeight > 0) {
        sampleBilinearRgba(pyramid[0], clampUnit(sourceU), clampUnit(sourceV), boundarySample, 0);
        blendPixel(output, outputOffset, boundarySample, boundaryWeight);
        sourceBoundaryFeatheredPixelCount += 1;
      }

      // Every longitude converges at an equirectangular pole. Gradually
      // converge generated texels to a sampled source-band color to prevent
      // radial pinching while retaining texture below the polar cap.
      const poleWeight = smoothstep(POLE_STABILIZATION_START_RADIANS, Math.PI / 2, Math.abs(pitch));
      if (poleWeight > 0) {
        blendPixel(output, outputOffset, pitch >= 0 ? northPoleColor : southPoleColor, poleWeight);
        poleStabilizedPixelCount += 1;
      }
    }
  }

  const seamOptimizedPairCount = optimizeGeneratedSeam({
    pixels: output,
    mask: generatedMask,
    width,
    height,
  });
  const seamError = seamMeanAbsoluteError(output, width, height);
  const northPoleMeanAdjacentError = rowMeanAdjacentAbsoluteError(output, width, 0);
  const southPoleMeanAdjacentError = rowMeanAdjacentAbsoluteError(output, width, height - 1);
  let transparentPixelCount = 0;
  for (let offset = 3; offset < output.length; offset += 4) {
    if ((output[offset] ?? 0) < 255) transparentPixelCount += 1;
  }
  const failedChecks: string[] = [];
  if (sourceLockedPixelCount < MODEL_FREE_PANORAMA_QUALITY_LIMITS.minSourceLockedPixelCount) {
    failedChecks.push("source_lock_missing");
  }
  if (seamError > MODEL_FREE_PANORAMA_QUALITY_LIMITS.maxSeamMeanAbsoluteError) {
    failedChecks.push("cyclic_seam_error");
  }
  if (
    northPoleMeanAdjacentError > MODEL_FREE_PANORAMA_QUALITY_LIMITS.maxPoleMeanAdjacentError ||
    southPoleMeanAdjacentError > MODEL_FREE_PANORAMA_QUALITY_LIMITS.maxPoleMeanAdjacentError
  ) {
    failedChecks.push("pole_discontinuity");
  }
  if (transparentPixelCount > MODEL_FREE_PANORAMA_QUALITY_LIMITS.maxTransparentPixelCount) {
    failedChecks.push("transparent_holes");
  }
  const panoramaPng = encodePngRgba(output, width, height);
  const generatedMaskRgba = Buffer.alloc(width * height * 4);
  for (let pixelIndex = 0; pixelIndex < generatedMask.length; pixelIndex += 1) {
    const value = generatedMask[pixelIndex] ?? 0;
    const offset = pixelIndex * 4;
    generatedMaskRgba[offset] = value;
    generatedMaskRgba[offset + 1] = value;
    generatedMaskRgba[offset + 2] = value;
    generatedMaskRgba[offset + 3] = 255;
  }
  const generatedRegionMaskPng = encodePngRgba(generatedMaskRgba, width, height);
  const generatedPixelCount = width * height - sourceLockedPixelCount;
  const generatedRatio = generatedPixelCount / (width * height);
  const qualityConfidence = clampUnit(
    1 -
      generatedRatio * 0.35 -
      (seamError / 255) * 0.25 -
      (Math.max(northPoleMeanAdjacentError, southPoleMeanAdjacentError) / 255) * 0.15,
  );
  const qualityReport: ModelFreePanoramaQualityReport = {
    contractVersion: MODEL_FREE_PANORAMA_CONTRACT_VERSION,
    algorithmId: MODEL_FREE_PANORAMA_ALGORITHM_ID,
    geometryTruth: "generated_approximate",
    navigationMode: "three_dof",
    projection: "equirectangular_360",
    usesTrainedWeights: false,
    modelDependencies: [],
    checkpointDigests: [],
    componentManifestCanonical: MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_CANONICAL,
    componentManifestDigest: MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST,
    runtimeBuildDigest: MODEL_FREE_PANORAMA_RUNTIME_BUILD_DIGEST,
    noticeRef: MODEL_FREE_PANORAMA_NOTICE_REF,
    commercialUseAllowed: true,
    allowedTerritories: ["*"],
    deterministic: true,
    source: {
      width: source.width,
      height: source.height,
      horizontalFovDegrees: request.horizontalFovDegrees,
      verticalFovDegrees: verticalFov / DEG_TO_RAD,
      orientationNormalized: true,
    },
    output: { width, height },
    sourceLockedPixelCount,
    generatedPixelCount,
    generatedRatio,
    sourceBoundaryFeatheredPixelCount,
    continuousMipBlendPixelCount,
    poleStabilizedPixelCount,
    seamOptimizedPairCount,
    seamMeanAbsoluteError: seamError,
    northPoleMeanAdjacentError,
    southPoleMeanAdjacentError,
    transparentPixelCount,
    qualityConfidence,
    qualityGate: {
      passed: failedChecks.length === 0,
      thresholds: MODEL_FREE_PANORAMA_QUALITY_LIMITS,
      failedChecks,
    },
    panoramaChecksum: checksum(panoramaPng),
    generatedMaskChecksum: checksum(generatedRegionMaskPng),
    warnings: [
      "generated_regions_are_not_scene_truth",
      "rotation_only_no_translation_or_metric_depth",
    ],
  };
  return { panoramaPng, generatedRegionMaskPng, qualityReport };
}
