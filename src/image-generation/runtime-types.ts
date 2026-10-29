import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type {
  ImageGenerationIgnoredOverride,
  ImageGenerationNormalization,
  ImageGenerationRequest,
  ImageGenerationResolution,
  ImageGenerationResult,
} from "./types.js";

export type GenerateImageParams = Omit<ImageGenerationRequest, "provider" | "model"> & {
  modelOverride?: string;
  /** Resolution inferred from reference images; omitted for incompatible fallback models. */
  inferredResolution?: ImageGenerationResolution;
  autoProviderFallback?: boolean;
  /** Frozen product plans reject normalized or ignored output options before Provider I/O. */
  requireExactOutput?: boolean;
};

export type GenerateImageRuntimeResult = Omit<ImageGenerationResult, "model"> & {
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  appliedResolution?: ImageGenerationResolution;
  normalization?: ImageGenerationNormalization;
  ignoredOverrides: ImageGenerationIgnoredOverride[];
};
