import { createHash } from "node:crypto";

export const DEPTH_MESH_CONTRACT_VERSION = "spatial_environment_depth_mesh/manual_v1" as const;
export const DEPTH_ADAPTER_CONTRACT_VERSION = "spatial_depth_adapter/output_v1" as const;
export const DEPTH_MESH_ALGORITHM_ID = "wisclaw.deterministic_layered_depth_mesh/v1" as const;
export const DEPTH_MESH_NOTICE_REF = "NOTICE.wisclaw-spatial-environment-depth-mesh" as const;
export const DEPTH_MESH_COMPONENT_MANIFEST_CANONICAL =
  '{"schemaVersion":"wisclaw.spatial_component_manifest/v1","components":[{"componentId":"wisclaw.deterministic_layered_depth_mesh","version":"1","kind":"first_party_algorithm","sourceOrigin":"wisclaw_first_party","licenseId":"Wisclaw-Commercial-First-Party","commercialUseAllowed":true,"allowedTerritories":["*"],"checkpointDigest":null,"noticeRef":"NOTICE.wisclaw-spatial-environment-depth-mesh"}]}' as const;
export const DEPTH_MESH_COMPONENT_MANIFEST_DIGEST = `sha256:${createHash("sha256")
  .update(DEPTH_MESH_COMPONENT_MANIFEST_CANONICAL, "utf8")
  .digest("hex")}` as const;
export const DEPTH_MESH_RUNTIME_BUILD_DIGEST = `sha256:${createHash("sha256")
  .update(
    [
      DEPTH_MESH_CONTRACT_VERSION,
      DEPTH_MESH_ALGORITHM_ID,
      DEPTH_MESH_COMPONENT_MANIFEST_DIGEST,
      // v3: mask covers the actual generated mesh surface; walkability stays
      // in the separate collision proof instead of being conflated with it.
      "renderDeterministicDepthMesh:v3",
    ].join("\n"),
    "utf8",
  )
  .digest("hex")}` as const;

export type NormalizedPoint = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type DepthMeshManualCalibration = {
  sourceWidthPx: number;
  sourceHeightPx: number;
  orientationNormalized: true;
  horizonYNormalized: number;
  vanishingPointNormalized: NormalizedPoint;
  walkableRegionNormalized: readonly NormalizedPoint[];
  focalLengthMm: number;
  sensorWidthMm: number;
  relativeDepthRange: { near: number; far: number };
  gridResolution: number;
  confidence: number;
};

export type DepthAdapterRaster = {
  contractVersion: typeof DEPTH_ADAPTER_CONTRACT_VERSION;
  encoding: "normalized_depth_u16le" | "normalized_inverse_depth_u16le";
  width: number;
  height: number;
  confidence: number;
  componentManifestDigest: string;
  checkpointDigests: readonly string[];
  commercialUseAllowed: true;
  allowedTerritories: readonly string[];
  noticeRefs: readonly string[];
  samples: Uint16Array;
};

export type DepthMeshScaleAnchor = {
  kind: "known_distance" | "known_height";
  meters: number;
  confidence: number;
  evidenceRef: string;
  fromNormalized: NormalizedPoint;
  toNormalized: NormalizedPoint;
};

export type DeterministicDepthMeshRequest = {
  sourceImage: Buffer;
  sourceMimeType: "image/png" | "image/jpeg";
  calibration: DepthMeshManualCalibration;
  depthAdapter?: DepthAdapterRaster;
  scaleAnchor?: DepthMeshScaleAnchor;
};

export type DepthMeshNavigationBounds = {
  kind: "aabb";
  minimum: Vec3;
  maximum: Vec3;
};

export type DepthMeshCollisionArtifact = {
  contractVersion: "spatial_depth_collision/v1";
  geometryTruth: "generated_approximate";
  navigationMode: "bounded_six_dof";
  bounds: DepthMeshNavigationBounds;
  surfaceBounds: DepthMeshNavigationBounds;
  collisionConfidence: number;
  holesDetected: false;
  cameraRadius: number;
  walkableRegionNormalized: readonly NormalizedPoint[];
};

export type DepthMeshQualityReport = {
  contractVersion: typeof DEPTH_MESH_CONTRACT_VERSION;
  algorithmId: typeof DEPTH_MESH_ALGORITHM_ID;
  geometryTruth: "generated_approximate";
  navigationMode: "bounded_six_dof";
  usesTrainedWeights: boolean;
  modelDependencies: readonly [];
  checkpointDigests: readonly string[];
  dependencyComponentManifestDigests: readonly string[];
  componentManifestCanonical: typeof DEPTH_MESH_COMPONENT_MANIFEST_CANONICAL;
  componentManifestDigest: typeof DEPTH_MESH_COMPONENT_MANIFEST_DIGEST;
  runtimeBuildDigest: typeof DEPTH_MESH_RUNTIME_BUILD_DIGEST;
  noticeRefs: readonly string[];
  commercialUseAllowed: true;
  allowedTerritories: readonly string[];
  deterministic: true;
  source: { width: number; height: number; mimeType: string };
  mesh: { vertexCount: number; triangleCount: number; textured: true };
  depthSource: "manual_plane" | "depth_adapter";
  scaleBasis: "relative_scene_units" | "measured_anchor";
  qualityConfidence: number;
  qualityGate: { passed: true; holesDetected: false };
  warnings: readonly string[];
};

export type DeterministicDepthMeshResult = {
  depthMeshGlb: Buffer;
  generatedRegionMaskPng: Buffer;
  collisionJson: Buffer;
  collision: DepthMeshCollisionArtifact;
  qualityReport: DepthMeshQualityReport;
  navigationBounds: DepthMeshNavigationBounds;
};

export class DepthMeshRenderError extends Error {
  constructor(
    public readonly code:
      | "invalid_source"
      | "invalid_calibration"
      | "invalid_depth_adapter"
      | "invalid_scale_anchor"
      | "quality_gate_failed"
      | "mesh_generation_failed",
    message: string,
  ) {
    super(message);
    this.name = "DepthMeshRenderError";
  }
}
