/** Deterministic first-party calibrated plate -> bounded textured GLB. */
import { deflateSync } from "node:zlib";
import { buildTexturedGridGlb } from "./glb.js";
import {
  DEPTH_ADAPTER_CONTRACT_VERSION,
  DEPTH_MESH_ALGORITHM_ID,
  DEPTH_MESH_COMPONENT_MANIFEST_CANONICAL,
  DEPTH_MESH_COMPONENT_MANIFEST_DIGEST,
  DEPTH_MESH_CONTRACT_VERSION,
  DEPTH_MESH_NOTICE_REF,
  DEPTH_MESH_RUNTIME_BUILD_DIGEST,
  DepthMeshRenderError,
  type DepthMeshNavigationBounds,
  type DeterministicDepthMeshRequest,
  type DeterministicDepthMeshResult,
  type NormalizedPoint,
  type Vec3,
} from "./types.js";

export * from "./types.js";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(kind: string, data: Buffer): Buffer {
  const type = Buffer.from(kind, "ascii");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

/**
 * Greyscale PNG mask for quality evidence:
 * - white (255) = generated-approximate mesh surface exists for this source
 *
 * Walkability is intentionally not encoded here. It is a separate, stricter
 * collision/navigation claim and already has its own polygon in the collision
 * Artifact. The GLB spans the full calibrated plate, so a walkable-only mask
 * would incorrectly claim that the remaining generated mesh does not exist.
 *
 * The previous solid-white 64×36 stub looked blank on light Artifact Center
 * canvases and carried no geometric signal.
 */
function maskDimensions(
  sourceWidth: number,
  sourceHeight: number,
): {
  width: number;
  height: number;
} {
  const maxEdge = 256;
  const long = Math.max(sourceWidth, sourceHeight, 1);
  const scale = long > maxEdge ? maxEdge / long : 1;
  return {
    width: Math.max(8, Math.round(sourceWidth * scale)),
    height: Math.max(8, Math.round(sourceHeight * scale)),
  };
}

function generatedRegionMaskForSurface(sourceWidth: number, sourceHeight: number): Buffer {
  const { width, height } = maskDimensions(sourceWidth, sourceHeight);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const scanlines = Buffer.alloc(height * (width + 1), 0xff);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    scanlines[row] = 0; // PNG filter None
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validPoint(value: NormalizedPoint): boolean {
  return unit(value?.x) && unit(value?.y);
}

function validate(input: DeterministicDepthMeshRequest): void {
  const c = input.calibration;
  if (
    !Buffer.isBuffer(input.sourceImage) ||
    input.sourceImage.length === 0 ||
    input.sourceImage.length > 32 * 1024 * 1024 ||
    (input.sourceMimeType !== "image/png" && input.sourceMimeType !== "image/jpeg")
  )
    throw new DepthMeshRenderError("invalid_source", "encoded PNG/JPEG source is required");
  if (
    !Number.isInteger(c.sourceWidthPx) ||
    !Number.isInteger(c.sourceHeightPx) ||
    c.sourceWidthPx < 1 ||
    c.sourceHeightPx < 1 ||
    c.orientationNormalized !== true ||
    !unit(c.horizonYNormalized) ||
    !validPoint(c.vanishingPointNormalized) ||
    c.walkableRegionNormalized.length < 3 ||
    c.walkableRegionNormalized.length > 32 ||
    c.walkableRegionNormalized.some((point) => !validPoint(point)) ||
    !(c.focalLengthMm >= 8 && c.focalLengthMm <= 300) ||
    !(c.sensorWidthMm >= 4 && c.sensorWidthMm <= 100) ||
    !(c.relativeDepthRange.near > 0) ||
    !(c.relativeDepthRange.far > c.relativeDepthRange.near) ||
    c.relativeDepthRange.far > 100 ||
    !Number.isInteger(c.gridResolution) ||
    c.gridResolution < 8 ||
    c.gridResolution > 64 ||
    !unit(c.confidence)
  )
    throw new DepthMeshRenderError(
      "invalid_calibration",
      "manual camera/plane calibration is invalid",
    );
  const adapter = input.depthAdapter;
  if (
    adapter &&
    (adapter.contractVersion !== DEPTH_ADAPTER_CONTRACT_VERSION ||
      (adapter.encoding !== "normalized_depth_u16le" &&
        adapter.encoding !== "normalized_inverse_depth_u16le") ||
      !Number.isInteger(adapter.width) ||
      !Number.isInteger(adapter.height) ||
      adapter.width < 2 ||
      adapter.height < 2 ||
      adapter.samples.length !== adapter.width * adapter.height ||
      !unit(adapter.confidence) ||
      !/^sha256:[0-9a-f]{64}$/.test(adapter.componentManifestDigest) ||
      adapter.commercialUseAllowed !== true ||
      !adapter.allowedTerritories.length ||
      adapter.allowedTerritories.some((territory) => !territory.trim()) ||
      !adapter.noticeRefs.length)
  )
    throw new DepthMeshRenderError(
      "invalid_depth_adapter",
      "depth adapter raster/provenance is invalid",
    );
  const anchor = input.scaleAnchor;
  if (
    anchor &&
    ((anchor.kind !== "known_distance" && anchor.kind !== "known_height") ||
      !(anchor.meters > 0) ||
      !unit(anchor.confidence) ||
      anchor.confidence < 0.5 ||
      !anchor.evidenceRef.trim() ||
      !validPoint(anchor.fromNormalized) ||
      !validPoint(anchor.toNormalized) ||
      Math.hypot(
        anchor.fromNormalized.x - anchor.toNormalized.x,
        anchor.fromNormalized.y - anchor.toNormalized.y,
      ) < 0.01)
  )
    throw new DepthMeshRenderError("invalid_scale_anchor", "scale anchor is invalid");
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sampleAdapter(
  input: DeterministicDepthMeshRequest,
  u: number,
  v: number,
): number | undefined {
  const adapter = input.depthAdapter;
  if (!adapter) return undefined;
  const x = clampUnit(u) * (adapter.width - 1);
  const y = clampUnit(v) * (adapter.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(adapter.width - 1, x0 + 1);
  const y1 = Math.min(adapter.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (sx: number, sy: number) => (adapter.samples[sy * adapter.width + sx] ?? 0) / 65535;
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  let normalized = top * (1 - ty) + bottom * ty;
  if (adapter.encoding === "normalized_inverse_depth_u16le") normalized = 1 - normalized;
  return clampUnit(normalized);
}

function relativeDepth(input: DeterministicDepthMeshRequest, u: number, v: number): number {
  const { near, far } = input.calibration.relativeDepthRange;
  const adapter = sampleAdapter(input, u, v);
  if (adapter !== undefined) return near + (far - near) * adapter;
  const horizon = input.calibration.horizonYNormalized;
  if (v <= horizon) {
    const sky = horizon > 0 ? v / horizon : 0;
    return far * (0.9 + sky * 0.1);
  }
  const floor = (v - horizon) / Math.max(1e-6, 1 - horizon);
  const centerBias = 1 - 0.08 * Math.cos((u - 0.5) * Math.PI * 2);
  return (far - (far - near) * Math.pow(floor, 0.72)) * centerBias;
}

function project(input: DeterministicDepthMeshRequest, u: number, v: number): Vec3 {
  const c = input.calibration;
  const depth = relativeDepth(input, u, v);
  const tanHalfHorizontalFov = c.sensorWidthMm / (2 * c.focalLengthMm);
  const tanHalfVerticalFov = tanHalfHorizontalFov * (c.sourceHeightPx / c.sourceWidthPx);
  return {
    x: (u - c.vanishingPointNormalized.x) * 2 * tanHalfHorizontalFov * depth,
    y: (c.horizonYNormalized - v) * 2 * tanHalfVerticalFov * depth,
    z: -depth,
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function scaledGeometry(input: DeterministicDepthMeshRequest): {
  positions: Vec3[];
  uvs: Array<{ x: number; y: number }>;
  indices: Uint16Array;
  scale: number;
} {
  const columns = input.calibration.gridResolution + 1;
  const rows =
    Math.max(
      8,
      Math.round(
        input.calibration.gridResolution *
          (input.calibration.sourceHeightPx / input.calibration.sourceWidthPx),
      ),
    ) + 1;
  const positions: Vec3[] = [];
  const uvs: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < rows; y += 1) {
    const v = y / (rows - 1);
    for (let x = 0; x < columns; x += 1) {
      const u = x / (columns - 1);
      positions.push(project(input, u, v));
      uvs.push({ x: u, y: 1 - v });
    }
  }
  let scale = 1;
  if (input.scaleAnchor) {
    const unscaled = distance(
      project(input, input.scaleAnchor.fromNormalized.x, input.scaleAnchor.fromNormalized.y),
      project(input, input.scaleAnchor.toNormalized.x, input.scaleAnchor.toNormalized.y),
    );
    if (!(unscaled > 1e-6)) {
      throw new DepthMeshRenderError("invalid_scale_anchor", "scale anchor projects to zero span");
    }
    scale = input.scaleAnchor.meters / unscaled;
  }
  const floorY = Math.min(...positions.map((point) => point.y));
  for (const position of positions) {
    position.x *= scale;
    position.y = (position.y - floorY) * scale;
    position.z *= scale;
  }
  const indices = new Uint16Array((columns - 1) * (rows - 1) * 6);
  let cursor = 0;
  for (let y = 0; y < rows - 1; y += 1) {
    for (let x = 0; x < columns - 1; x += 1) {
      const a = y * columns + x;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }
  return { positions, uvs, indices, scale };
}

function boundsOf(positions: readonly Vec3[]): DepthMeshNavigationBounds {
  const minimum = { x: Infinity, y: Infinity, z: Infinity };
  const maximum = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const point of positions) {
    minimum.x = Math.min(minimum.x, point.x);
    minimum.y = Math.min(minimum.y, point.y);
    minimum.z = Math.min(minimum.z, point.z);
    maximum.x = Math.max(maximum.x, point.x);
    maximum.y = Math.max(maximum.y, point.y);
    maximum.z = Math.max(maximum.z, point.z);
  }
  return { kind: "aabb", minimum, maximum };
}

function navigationBounds(
  surface: DepthMeshNavigationBounds,
  nearDepth: number,
): DepthMeshNavigationBounds {
  const width = Math.max(0.5, surface.maximum.x - surface.minimum.x);
  const height = Math.max(0.5, surface.maximum.y - surface.minimum.y);
  const lateral = Math.max(0.25, width * 0.18);
  const cameraHeight = Math.max(0.35, Math.min(height * 0.8, height - 0.05));
  return {
    kind: "aabb",
    minimum: { x: -lateral, y: 0.08, z: -Math.max(0.2, nearDepth * 0.32) },
    maximum: { x: lateral, y: cameraHeight, z: Math.max(0.12, nearDepth * 0.18) },
  };
}

export async function renderDeterministicDepthMesh(
  input: DeterministicDepthMeshRequest,
): Promise<DeterministicDepthMeshResult> {
  validate(input);
  const geometry = scaledGeometry(input);
  const surfaceBounds = boundsOf(geometry.positions);
  const bounds = navigationBounds(
    surfaceBounds,
    input.calibration.relativeDepthRange.near * geometry.scale,
  );
  const confidence = Math.max(
    0,
    Math.min(0.92, input.calibration.confidence * (input.depthAdapter?.confidence ?? 0.72)),
  );
  if (confidence < 0.5) {
    throw new DepthMeshRenderError(
      "quality_gate_failed",
      "combined calibration/depth confidence is below the bounded-navigation threshold",
    );
  }
  const collision = {
    contractVersion: "spatial_depth_collision/v1" as const,
    geometryTruth: "generated_approximate" as const,
    navigationMode: "bounded_six_dof" as const,
    bounds,
    surfaceBounds,
    collisionConfidence: confidence,
    holesDetected: false as const,
    cameraRadius: Math.max(0.03, Math.min(0.18, (bounds.maximum.x - bounds.minimum.x) * 0.08)),
    walkableRegionNormalized: input.calibration.walkableRegionNormalized,
  };
  const depthMeshGlb = buildTexturedGridGlb({
    positions: geometry.positions,
    uvs: geometry.uvs,
    indices: geometry.indices,
    sourceImage: input.sourceImage,
    sourceMimeType: input.sourceMimeType,
  });
  const generatedRegionMaskPng = generatedRegionMaskForSurface(
    input.calibration.sourceWidthPx,
    input.calibration.sourceHeightPx,
  );
  const adapterCheckpointDigests = input.depthAdapter?.checkpointDigests ?? [];
  const allowedTerritories = input.depthAdapter?.allowedTerritories ?? ["*"];
  const noticeRefs = [
    ...new Set([DEPTH_MESH_NOTICE_REF, ...(input.depthAdapter?.noticeRefs ?? [])]),
  ];
  const qualityReport = {
    contractVersion: DEPTH_MESH_CONTRACT_VERSION,
    algorithmId: DEPTH_MESH_ALGORITHM_ID,
    geometryTruth: "generated_approximate" as const,
    navigationMode: "bounded_six_dof" as const,
    usesTrainedWeights: adapterCheckpointDigests.length > 0,
    modelDependencies: [] as const,
    checkpointDigests: adapterCheckpointDigests,
    dependencyComponentManifestDigests: input.depthAdapter
      ? [input.depthAdapter.componentManifestDigest]
      : [],
    componentManifestCanonical: DEPTH_MESH_COMPONENT_MANIFEST_CANONICAL,
    componentManifestDigest: DEPTH_MESH_COMPONENT_MANIFEST_DIGEST,
    runtimeBuildDigest: DEPTH_MESH_RUNTIME_BUILD_DIGEST,
    noticeRefs,
    commercialUseAllowed: true as const,
    allowedTerritories,
    deterministic: true as const,
    source: {
      width: input.calibration.sourceWidthPx,
      height: input.calibration.sourceHeightPx,
      mimeType: input.sourceMimeType,
    },
    mesh: {
      vertexCount: geometry.positions.length,
      triangleCount: geometry.indices.length / 3,
      textured: true as const,
    },
    depthSource: input.depthAdapter ? ("depth_adapter" as const) : ("manual_plane" as const),
    scaleBasis: input.scaleAnchor
      ? ("measured_anchor" as const)
      : ("relative_scene_units" as const),
    qualityConfidence: confidence,
    qualityGate: { passed: true as const, holesDetected: false as const },
    warnings: [
      "single_image_depth_is_not_hidden_scene_truth",
      input.scaleAnchor
        ? "measured_anchor_scales_approximate_geometry_only"
        : "relative_scale_only_metric_measurement_disabled",
      "navigation_is_clamped_to_verified_collision_aabb",
    ],
  };
  return {
    depthMeshGlb,
    generatedRegionMaskPng,
    collisionJson: Buffer.from(`${JSON.stringify(collision)}\n`, "utf8"),
    collision,
    qualityReport,
    navigationBounds: bounds,
  };
}
