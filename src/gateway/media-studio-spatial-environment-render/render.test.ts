import { createHash } from "node:crypto";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { describe, expect, it } from "vitest";
import { encodePngRgba } from "../../media/png-encode.js";
import {
  MODEL_FREE_PANORAMA_ALGORITHM_ID,
  ModelFreePanoramaError,
  renderModelFreePanorama,
} from "./index.js";

async function sourceGradient(width = 320, height = 180): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round((x / (width - 1)) * 255);
      pixels[offset + 1] = Math.round((y / (height - 1)) * 255);
      pixels[offset + 2] = (x + y) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return encodePngRgba(pixels, width, height);
}

async function rawRgba(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const image = PhotonImage.new_from_byteslice(png);
  const result = {
    data: Buffer.from(image.get_raw_pixels()),
    width: image.get_width(),
    height: image.get_height(),
  };
  image.free();
  return result;
}

function rgbAt(data: Buffer, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
}

describe("model-free spatial environment panorama", () => {
  it("renders a deterministic exact 2:1 panorama and generated-region mask", async () => {
    const sourceImage = await sourceGradient();
    const request = {
      sourceImage,
      horizontalFovDegrees: 90,
      outputWidth: 512,
    };
    const first = await renderModelFreePanorama(request);
    const second = await renderModelFreePanorama(request);
    const panoramaMeta = await rawRgba(first.panoramaPng);
    const maskMeta = await rawRgba(first.generatedRegionMaskPng);

    expect({ width: panoramaMeta.width, height: panoramaMeta.height }).toEqual({
      width: 512,
      height: 256,
    });
    expect({ width: maskMeta.width, height: maskMeta.height }).toEqual({
      width: 512,
      height: 256,
    });
    expect(first.panoramaPng.equals(second.panoramaPng)).toBe(true);
    expect(first.generatedRegionMaskPng.equals(second.generatedRegionMaskPng)).toBe(true);
    expect(first.qualityReport.panoramaChecksum).toBe(
      `sha256:${createHash("sha256").update(first.panoramaPng).digest("hex")}`,
    );
  });

  it("locks the calibrated source center while marking hidden directions generated", async () => {
    const sourceImage = await sourceGradient();
    const result = await renderModelFreePanorama({
      sourceImage,
      horizontalFovDegrees: 90,
      outputWidth: 512,
    });
    const source = await rawRgba(sourceImage);
    const panorama = await rawRgba(result.panoramaPng);
    const mask = await rawRgba(result.generatedRegionMaskPng);
    const sourceCenter = rgbAt(
      source.data,
      source.width,
      Math.floor(source.width / 2),
      Math.floor(source.height / 2),
    );
    const panoramaCenter = rgbAt(
      panorama.data,
      panorama.width,
      Math.floor(panorama.width / 2),
      Math.floor(panorama.height / 2),
    );

    for (let channel = 0; channel < 3; channel += 1) {
      expect(
        Math.abs((sourceCenter[channel] ?? 0) - (panoramaCenter[channel] ?? 0)),
      ).toBeLessThanOrEqual(2);
    }
    const maskCenter =
      (Math.floor(panorama.height / 2) * panorama.width + Math.floor(panorama.width / 2)) * 4;
    const maskBack = Math.floor(panorama.height / 2) * panorama.width * 4;
    expect(mask.data[maskCenter]).toBe(0);
    expect(mask.data[maskBack]).toBe(255);
    expect(result.qualityReport.sourceLockedPixelCount).toBeGreaterThan(0);
    expect(result.qualityReport.generatedRatio).toBeGreaterThan(0.5);
  });

  it("optimizes only the generated back seam to zero edge error", async () => {
    const result = await renderModelFreePanorama({
      sourceImage: await sourceGradient(),
      horizontalFovDegrees: 100,
      outputWidth: 512,
    });
    expect(result.qualityReport.seamOptimizedPairCount).toBeGreaterThan(0);
    expect(result.qualityReport.seamMeanAbsoluteError).toBe(0);
  });

  it("feathers generated boundaries, blends mip levels, and stabilizes both poles", async () => {
    const result = await renderModelFreePanorama({
      sourceImage: await sourceGradient(),
      horizontalFovDegrees: 90,
      outputWidth: 512,
    });

    expect(result.qualityReport.sourceBoundaryFeatheredPixelCount).toBeGreaterThan(0);
    expect(result.qualityReport.continuousMipBlendPixelCount).toBeGreaterThan(0);
    expect(result.qualityReport.poleStabilizedPixelCount).toBeGreaterThan(0);
    expect(result.qualityReport.northPoleMeanAdjacentError).toBeLessThanOrEqual(1);
    expect(result.qualityReport.southPoleMeanAdjacentError).toBeLessThanOrEqual(1);
    expect(result.qualityReport.transparentPixelCount).toBe(0);
    expect(result.qualityReport.qualityConfidence).toBeGreaterThan(0);
    expect(result.qualityReport.qualityGate).toMatchObject({
      passed: true,
      failedChecks: [],
    });
  });

  it("declares approximate 3DoF output and no trained model dependency", async () => {
    const result = await renderModelFreePanorama({
      sourceImage: await sourceGradient(),
      horizontalFovDegrees: 75,
      outputWidth: 256,
    });
    expect(result.qualityReport).toMatchObject({
      algorithmId: MODEL_FREE_PANORAMA_ALGORITHM_ID,
      geometryTruth: "generated_approximate",
      navigationMode: "three_dof",
      projection: "equirectangular_360",
      usesTrainedWeights: false,
      modelDependencies: [],
      checkpointDigests: [],
      commercialUseAllowed: true,
      allowedTerritories: ["*"],
      deterministic: true,
    });
    expect(result.qualityReport.warnings).toContain("rotation_only_no_translation_or_metric_depth");
  });

  it("fails closed on uncalibrated FOV and invalid output sizes", async () => {
    const sourceImage = await sourceGradient();
    await expect(
      renderModelFreePanorama({
        sourceImage,
        horizontalFovDegrees: 180,
        outputWidth: 512,
      }),
    ).rejects.toMatchObject<ModelFreePanoramaError>({ code: "invalid_horizontal_fov" });
    await expect(
      renderModelFreePanorama({
        sourceImage,
        horizontalFovDegrees: 90,
        outputWidth: 511,
      }),
    ).rejects.toMatchObject<ModelFreePanoramaError>({ code: "invalid_output_dimensions" });
  });
});
