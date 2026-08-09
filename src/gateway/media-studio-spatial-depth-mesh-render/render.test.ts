import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderDeterministicDepthMesh } from "./index.js";

function input() {
  return {
    sourceImage: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    sourceMimeType: "image/jpeg" as const,
    calibration: {
      sourceWidthPx: 1600,
      sourceHeightPx: 900,
      orientationNormalized: true as const,
      horizonYNormalized: 0.44,
      vanishingPointNormalized: { x: 0.5, y: 0.44 },
      walkableRegionNormalized: [
        { x: 0.1, y: 0.95 },
        { x: 0.9, y: 0.95 },
        { x: 0.6, y: 0.52 },
        { x: 0.4, y: 0.52 },
      ],
      focalLengthMm: 35,
      sensorWidthMm: 36,
      relativeDepthRange: { near: 0.75, far: 8 },
      gridResolution: 16,
      confidence: 0.78,
    },
  };
}

describe("deterministic layered depth mesh", () => {
  it("emits a textured GLB, generated mask and hole-free bounded collision proof", async () => {
    const rendered = await renderDeterministicDepthMesh(input());
    expect(rendered.depthMeshGlb.readUInt32LE(0)).toBe(0x46546c67);
    expect(rendered.depthMeshGlb.readUInt32LE(4)).toBe(2);
    expect(rendered.generatedRegionMaskPng.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(rendered.collision).toMatchObject({
      contractVersion: "spatial_depth_collision/v1",
      geometryTruth: "generated_approximate",
      navigationMode: "bounded_six_dof",
      holesDetected: false,
    });
    expect(rendered.navigationBounds.minimum.x).toBeLessThan(rendered.navigationBounds.maximum.x);
    expect(rendered.qualityReport.scaleBasis).toBe("relative_scene_units");
    expect(rendered.qualityReport.warnings).toContain(
      "relative_scale_only_metric_measurement_disabled",
    );
  });

  it("is byte deterministic and uses a measured anchor without upgrading geometry truth", async () => {
    const withAnchor = {
      ...input(),
      scaleAnchor: {
        kind: "known_distance" as const,
        meters: 2.4,
        confidence: 0.9,
        evidenceRef: "measurement_1",
        fromNormalized: { x: 0.35, y: 0.8 },
        toNormalized: { x: 0.65, y: 0.8 },
      },
    };
    const a = await renderDeterministicDepthMesh(withAnchor);
    const b = await renderDeterministicDepthMesh(withAnchor);
    expect(createHash("sha256").update(a.depthMeshGlb).digest("hex")).toBe(
      createHash("sha256").update(b.depthMeshGlb).digest("hex"),
    );
    expect(a.qualityReport.scaleBasis).toBe("measured_anchor");
    expect(a.qualityReport.geometryTruth).toBe("generated_approximate");
  });

  it("consumes optional relative depth samples but rejects incomplete rasters", async () => {
    const adapter = {
      contractVersion: "spatial_depth_adapter/output_v1" as const,
      encoding: "normalized_depth_u16le" as const,
      width: 2,
      height: 2,
      confidence: 0.8,
      componentManifestDigest: `sha256:${"a".repeat(64)}`,
      checkpointDigests: [`sha256:${"b".repeat(64)}`],
      noticeRefs: ["NOTICE.adapter"],
      samples: new Uint16Array([0, 16384, 32768, 65535]),
    };
    const result = await renderDeterministicDepthMesh({ ...input(), depthAdapter: adapter });
    expect(result.qualityReport.depthSource).toBe("depth_adapter");
    await expect(
      renderDeterministicDepthMesh({
        ...input(),
        depthAdapter: { ...adapter, samples: new Uint16Array([0]) },
      }),
    ).rejects.toMatchObject({ code: "invalid_depth_adapter" });
  });
});
