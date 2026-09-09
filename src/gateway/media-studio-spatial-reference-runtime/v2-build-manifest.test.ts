import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpatialReferenceV2Manifest,
  createSpatialReferenceV2ResourceProfile,
  spatialReferenceV2BuildDigest,
} from "./v2-build-manifest.js";
import { SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL } from "./v2-renderer.js";

const referenceRenderHtmlPath = path.resolve(
  process.cwd(),
  "../../../apps/control_surface/spatial_babylon/dist/reference_render.html",
);

const toolchain = {
  chromiumVersion: "test-chromium",
  ffmpegVersion: "test-ffmpeg",
  ffprobeVersion: "test-ffprobe",
  ffmpegBuildConfiguration: "test-ffmpeg-build",
  ffprobeBuildConfiguration: "test-ffprobe-build",
};

describe("Spatial v2 actual build manifest", () => {
  it("binds resolved parent/worker, trusted entry binaries, host files, and the resource profile", async () => {
    const manifest = await buildSpatialReferenceV2Manifest({
      rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      referenceRenderHtmlPath,
      // Manifest construction verifies an executable entry identity.  This
      // source-only test deliberately does not launch it as Chromium.
      chromiumExecutablePath: process.execPath,
      toolchain,
    });
    expect(manifest.artifacts.rendererParent.url).toContain("v2-renderer");
    expect(manifest.artifacts.rendererWorker.url).toContain("v2-renderer.worker");
    expect(manifest.artifacts.referenceRenderHtml.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.referenceRenderHost.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.nodeExecutable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.ffmpegExecutable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.ffprobeExecutable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.resourceProfile).toMatchObject({
      profileId: "spatial_tree_rss_2gib/v1",
      maxTreeRssBytes: 2_147_483_648,
      minHostAvailableBytes: 2_684_354_560,
      persistentContextPages: 1,
      oneRuntimeJob: true,
    });
  });

  it("changes the frozen digest when the private resource policy changes", async () => {
    const profile = createSpatialReferenceV2ResourceProfile();
    const base = await buildSpatialReferenceV2Manifest({
      rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      referenceRenderHtmlPath,
      chromiumExecutablePath: process.execPath,
      toolchain,
      resourceProfile: profile,
    });
    const changed = await buildSpatialReferenceV2Manifest({
      rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      referenceRenderHtmlPath,
      chromiumExecutablePath: process.execPath,
      toolchain,
      resourceProfile: { ...profile, minHostAvailableBytes: profile.minHostAvailableBytes + 1 },
    });
    expect(spatialReferenceV2BuildDigest(changed)).not.toBe(spatialReferenceV2BuildDigest(base));
  });
});
