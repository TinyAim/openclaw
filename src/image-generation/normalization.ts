/** Normalizes image generation request overrides against provider/model capabilities. */
import { resolveMediaGeometryOverrides } from "../media-generation/geometry-normalization.js";
import { hasMediaNormalizationEntry } from "../media-generation/runtime-shared.js";
import type {
  ImageGenerationBackground,
  ImageGenerationIgnoredOverride,
  ImageGenerationNormalization,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationQuality,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "./types.js";

type ResolvedImageGenerationOverrides = {
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  ignoredOverrides: ImageGenerationIgnoredOverride[];
  normalization?: ImageGenerationNormalization;
};

/** This rejection is known to precede all Provider effects. */
export class ImageGenerationExactOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationExactOutputError";
  }
}

/** Frozen output contracts cannot use the conversational nearest-size policy. */
export function assertExactImageGenerationOverrides(
  requested: {
    size?: string;
    aspectRatio?: string;
    resolution?: ImageGenerationResolution;
    quality?: ImageGenerationQuality;
    outputFormat?: ImageGenerationOutputFormat;
    background?: ImageGenerationBackground;
  },
  resolved: ResolvedImageGenerationOverrides,
): void {
  const keys = [
    "size",
    "aspectRatio",
    "resolution",
    "quality",
    "outputFormat",
    "background",
  ] as const;
  if (
    resolved.ignoredOverrides.length > 0 ||
    resolved.normalization !== undefined ||
    keys.some((key) => requested[key] !== undefined && requested[key] !== resolved[key])
  ) {
    throw new ImageGenerationExactOutputError(
      "Frozen image output is not supported exactly; no Provider request was sent.",
    );
  }
}

/** Returns supported image overrides plus ignored/normalized override metadata for replies. */
export function resolveImageGenerationOverrides(params: {
  provider: ImageGenerationProvider;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  inputImages?: ImageGenerationSourceImage[];
}): ResolvedImageGenerationOverrides {
  // Edit and generate modes can expose different knobs for the same provider.
  const modeCaps = params.inputImages?.length
    ? params.provider.capabilities.edit
    : params.provider.capabilities.generate;
  const geometry = params.provider.capabilities.geometry;
  const sanitized = resolveMediaGeometryOverrides({
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    capabilities: {
      ...modeCaps,
      sizes: params.model
        ? (geometry?.sizesByModel?.[params.model] ?? geometry?.sizes)
        : geometry?.sizes,
      aspectRatios: params.model
        ? (geometry?.aspectRatiosByModel?.[params.model] ?? geometry?.aspectRatios)
        : geometry?.aspectRatios,
      resolutions: params.model
        ? (geometry?.resolutionsByModel?.[params.model] ?? geometry?.resolutions)
        : geometry?.resolutions,
    },
    fallbackSizes: geometry?.sizes,
  });
  const ignoredOverrides: ImageGenerationIgnoredOverride[] = sanitized.ignoredOverrides;
  let { quality, outputFormat, background } = params;

  if (quality && !(params.provider.capabilities.output?.qualities ?? []).includes(quality)) {
    ignoredOverrides.push({ key: "quality", value: quality });
    quality = undefined;
  }
  if (
    outputFormat &&
    !(params.provider.capabilities.output?.formats ?? []).includes(outputFormat)
  ) {
    ignoredOverrides.push({ key: "outputFormat", value: outputFormat });
    outputFormat = undefined;
  }
  if (
    background &&
    !(params.provider.capabilities.output?.backgrounds ?? []).includes(background)
  ) {
    ignoredOverrides.push({ key: "background", value: background });
    background = undefined;
  }

  const { normalization } = sanitized;
  return {
    size: sanitized.size,
    aspectRatio: sanitized.aspectRatio,
    resolution: sanitized.resolution,
    quality,
    outputFormat,
    background,
    ignoredOverrides,
    normalization:
      hasMediaNormalizationEntry(normalization.size) ||
      hasMediaNormalizationEntry(normalization.aspectRatio) ||
      hasMediaNormalizationEntry(normalization.resolution)
        ? normalization
        : undefined,
  };
}
