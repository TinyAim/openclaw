import { createHash } from "node:crypto";

export const MODEL_FREE_PANORAMA_CONTRACT_VERSION =
  "spatial_environment_panorama/model_free_v1" as const;

export const MODEL_FREE_PANORAMA_ALGORITHM_ID =
  "wisclaw.model_free_panorama_reflection_quilt/v1" as const;

export const MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_CANONICAL =
  '{"schemaVersion":"wisclaw.spatial_component_manifest/v1","components":[{"componentId":"wisclaw.model_free_panorama_reflection_quilt","version":"1","kind":"first_party_algorithm","sourceOrigin":"wisclaw_first_party","licenseId":"Wisclaw-Commercial-First-Party","commercialUseAllowed":true,"allowedTerritories":["*"],"checkpointDigest":null,"noticeRef":"NOTICE.wisclaw-spatial-environment-panorama"},{"componentId":"rastermill","version":"0.3.1","kind":"third_party_library","sourceOrigin":"npm","licenseId":"MIT","commercialUseAllowed":true,"allowedTerritories":["*"],"checkpointDigest":null,"noticeRef":"NOTICE.wisclaw-spatial-environment-panorama"},{"componentId":"@silvia-odwyer/photon-node","version":"0.3.4","kind":"third_party_library","sourceOrigin":"npm","licenseId":"Apache-2.0","commercialUseAllowed":true,"allowedTerritories":["*"],"checkpointDigest":null,"noticeRef":"NOTICE.wisclaw-spatial-environment-panorama"}]}' as const;

export const MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST = `sha256:${createHash("sha256")
  .update(MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_CANONICAL, "utf8")
  .digest("hex")}` as const;

export const MODEL_FREE_PANORAMA_RUNTIME_BUILD_DIGEST = `sha256:${createHash("sha256")
  .update(
    [
      MODEL_FREE_PANORAMA_CONTRACT_VERSION,
      MODEL_FREE_PANORAMA_ALGORITHM_ID,
      MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST,
      "renderModelFreePanorama:v1",
    ].join("\n"),
    "utf8",
  )
  .digest("hex")}` as const;

export const MODEL_FREE_PANORAMA_NOTICE_REF =
  "NOTICE.wisclaw-spatial-environment-panorama" as const;

export const MODEL_FREE_PANORAMA_QUALITY_LIMITS = {
  maxSeamMeanAbsoluteError: 8,
  maxPoleMeanAdjacentError: 48,
  maxTransparentPixelCount: 0,
  minSourceLockedPixelCount: 1,
} as const;

export interface ModelFreePanoramaRequest {
  /** Encoded user-authorized perspective source image. */
  sourceImage: Buffer;
  /** Calibrated horizontal field of view for the source camera. */
  horizontalFovDegrees: number;
  /** Even panorama width; output height is always width / 2. */
  outputWidth: number;
  /** Placement of the source optical axis in the panorama. */
  centerYawDegrees?: number;
}

export interface ModelFreePanoramaQualityReport {
  contractVersion: typeof MODEL_FREE_PANORAMA_CONTRACT_VERSION;
  algorithmId: typeof MODEL_FREE_PANORAMA_ALGORITHM_ID;
  geometryTruth: "generated_approximate";
  navigationMode: "three_dof";
  projection: "equirectangular_360";
  usesTrainedWeights: false;
  modelDependencies: readonly [];
  checkpointDigests: readonly [];
  componentManifestCanonical: typeof MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_CANONICAL;
  componentManifestDigest: typeof MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST;
  runtimeBuildDigest: typeof MODEL_FREE_PANORAMA_RUNTIME_BUILD_DIGEST;
  noticeRef: typeof MODEL_FREE_PANORAMA_NOTICE_REF;
  commercialUseAllowed: true;
  allowedTerritories: readonly ["*"];
  deterministic: true;
  source: {
    width: number;
    height: number;
    horizontalFovDegrees: number;
    verticalFovDegrees: number;
    orientationNormalized: true;
  };
  output: {
    width: number;
    height: number;
  };
  sourceLockedPixelCount: number;
  generatedPixelCount: number;
  generatedRatio: number;
  /** Generated pixels blended toward the nearest calibrated source edge. */
  sourceBoundaryFeatheredPixelCount: number;
  /** Generated pixels sampled between adjacent mip levels. */
  continuousMipBlendPixelCount: number;
  /** Generated polar pixels converged toward a coherent source-band color. */
  poleStabilizedPixelCount: number;
  seamOptimizedPairCount: number;
  seamMeanAbsoluteError: number;
  northPoleMeanAdjacentError: number;
  southPoleMeanAdjacentError: number;
  transparentPixelCount: number;
  qualityConfidence: number;
  qualityGate: {
    passed: boolean;
    thresholds: typeof MODEL_FREE_PANORAMA_QUALITY_LIMITS;
    failedChecks: readonly string[];
  };
  panoramaChecksum: string;
  generatedMaskChecksum: string;
  warnings: readonly [
    "generated_regions_are_not_scene_truth",
    "rotation_only_no_translation_or_metric_depth",
  ];
}

export interface ModelFreePanoramaResult {
  panoramaPng: Buffer;
  generatedRegionMaskPng: Buffer;
  qualityReport: ModelFreePanoramaQualityReport;
}

export type ModelFreePanoramaFailureCode =
  | "invalid_source"
  | "invalid_horizontal_fov"
  | "invalid_output_dimensions"
  | "source_decode_failed";

export class ModelFreePanoramaError extends Error {
  constructor(
    public readonly code: ModelFreePanoramaFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelFreePanoramaError";
  }
}
