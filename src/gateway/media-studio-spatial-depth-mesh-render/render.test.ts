import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
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

/** Decode greyscale PNG (8-bit, color type 0) for mask assertions. */
function decodeGreyscalePng(png: Buffer): {
  width: number;
  height: number;
  pixels: Buffer;
} {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9] ?? -1;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  expect(colorType).toBe(0);
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width + 1);
    expect(raw[rowStart]).toBe(0);
    raw.copy(pixels, y * width, rowStart + 1, rowStart + 1 + width);
  }
  return { width, height, pixels };
}

describe("deterministic layered depth mesh", () => {
  it("emits a textured GLB, generated mask and hole-free bounded collision proof", async () => {
    const rendered = await renderDeterministicDepthMesh(input());
    expect(rendered.depthMeshGlb.readUInt32LE(0)).toBe(0x46546c67);
    expect(rendered.depthMeshGlb.readUInt32LE(4)).toBe(2);
    expect(rendered.generatedRegionMaskPng.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    // Must not be the old solid-white 91-byte stub (invisible on light canvas).
    expect(rendered.generatedRegionMaskPng.byteLength).toBeGreaterThan(91);
    const mask = decodeGreyscalePng(rendered.generatedRegionMaskPng);
    // 1600×900 → long-edge 256 → 256×144
    expect(mask).toMatchObject({ width: 256, height: 144 });
    let white = 0;
    let black = 0;
    for (const value of mask.pixels) {
      if (value === 255) white += 1;
      else if (value === 0) black += 1;
    }
    // Walkable trapezoid is a minority of the plate; both sides must be present
    // so Artifact Center preview shows a real silhouette, not a blank pane.
    expect(white).toBeGreaterThan(100);
    expect(black).toBeGreaterThan(white);
    // Sample corners (outside) vs lower-center (inside walkable).
    expect(mask.pixels[0]).toBe(0);
    expect(mask.pixels[mask.width - 1]).toBe(0);
    const insideX = Math.floor(mask.width * 0.5);
    const insideY = Math.floor(mask.height * 0.85);
    expect(mask.pixels[insideY * mask.width + insideX]).toBe(255);
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
    expect(createHash("sha256").update(a.generatedRegionMaskPng).digest("hex")).toBe(
      createHash("sha256").update(b.generatedRegionMaskPng).digest("hex"),
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
