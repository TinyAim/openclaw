import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

const observerRoot = mkdtempSync(path.join(os.tmpdir(), "spatial-observer-fixture-"));
const resourceObserverExecutablePath = path.join(observerRoot, "fixture-observer");
writeFileSync(resourceObserverExecutablePath, "#!/bin/sh\necho darwin_spatial_tree_rss_span/v1\n", {
  mode: 0o700,
});
afterAll(() => rmSync(observerRoot, { recursive: true, force: true }));

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
      resourceObserverExecutablePath,
      toolchain,
    });
    expect(manifest.artifacts.rendererParent.url).toContain("v2-renderer");
    expect(manifest.artifacts.rendererWorker.url).toContain("v2-renderer.worker");
    expect(manifest.artifacts.guardianProcessSource?.url).toContain("spatial-guardian-process.ts");
    expect(manifest.artifacts.guardianProcessSource?.sha256).toMatch(/^[a-f0-9]{64}$/);
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

  it("source observer bytes and missing dependency identity reject the previous frozen digest", async () => {
    const current = await buildSpatialReferenceV2Manifest({
      rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      referenceRenderHtmlPath,
      chromiumExecutablePath: process.execPath,
      resourceObserverExecutablePath,
      toolchain,
    });
    const prior = structuredClone(current);
    delete prior.artifacts.guardianProcessSource;
    expect(spatialReferenceV2BuildDigest(prior)).not.toBe(spatialReferenceV2BuildDigest(current));
    const changed = structuredClone(current);
    changed.artifacts.guardianProcessSource!.sha256 = "0".repeat(64);
    expect(spatialReferenceV2BuildDigest(changed)).not.toBe(spatialReferenceV2BuildDigest(current));
  });

  it("changes the frozen digest when the private resource policy changes", async () => {
    const profile = createSpatialReferenceV2ResourceProfile();
    const base = await buildSpatialReferenceV2Manifest({
      rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      referenceRenderHtmlPath,
      chromiumExecutablePath: process.execPath,
      resourceObserverExecutablePath,
      toolchain,
      resourceProfile: profile,
    });
    const changed = await buildSpatialReferenceV2Manifest({
      rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      referenceRenderHtmlPath,
      chromiumExecutablePath: process.execPath,
      resourceObserverExecutablePath,
      toolchain,
      resourceProfile: { ...profile, minHostAvailableBytes: profile.minHostAvailableBytes + 1 },
    });
    expect(spatialReferenceV2BuildDigest(changed)).not.toBe(spatialReferenceV2BuildDigest(base));
  });
  it.skipIf(process.platform !== "darwin")(
    "rejects missing helper, stale protocol, and the previous ps metric",
    async () => {
      const input = {
        rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
        referenceRenderHtmlPath,
        chromiumExecutablePath: process.execPath,
        toolchain,
      };
      await expect(buildSpatialReferenceV2Manifest(input)).rejects.toThrow(
        "spatial_v2_resource_observer_unavailable",
      );
      const stalePath = path.join(observerRoot, "stale-observer");
      writeFileSync(stalePath, "#!/bin/sh\necho stale/v0\n", { mode: 0o700 });
      await expect(
        buildSpatialReferenceV2Manifest({ ...input, resourceObserverExecutablePath: stalePath }),
      ).rejects.toThrow("spatial_v2_resource_observer_unavailable");
      await expect(
        buildSpatialReferenceV2Manifest({
          ...input,
          resourceObserverExecutablePath,
          resourceProfile: {
            ...createSpatialReferenceV2ResourceProfile(),
            metric: "darwin_ps_tree_rss_sum_v1" as never,
          },
        }),
      ).rejects.toThrow("spatial_v2_resource_observer_unavailable");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "freezes protocol, helper bytes, and the unchanged observation budgets into digest",
    async () => {
      const path2 = path.join(observerRoot, "mutable-observer");
      writeFileSync(path2, "#!/bin/sh\necho darwin_spatial_tree_rss_span/v1\n", { mode: 0o700 });
      const input = {
        rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
        referenceRenderHtmlPath,
        chromiumExecutablePath: process.execPath,
        toolchain,
        resourceObserverExecutablePath: path2,
      };
      const before = await buildSpatialReferenceV2Manifest(input);
      expect(before.artifacts.resourceObserverExecutable).toMatchObject({
        protocol: "darwin_spatial_tree_rss_span/v1",
        timeoutMs: 3000,
        maxCaptureBytes: 4194304,
        maxFreshCensusAttempts: 128,
        invalidSpanPolicy: "discard_whole_then_fresh_if_lifecycle_proven",
      });
      writeFileSync(
        path2,
        "#!/bin/sh\n# changed qualified binary bytes\necho darwin_spatial_tree_rss_span/v1\n",
        { mode: 0o700 },
      );
      const after = await buildSpatialReferenceV2Manifest(input);
      expect(after.artifacts.resourceObserverExecutable?.sha256).not.toBe(
        before.artifacts.resourceObserverExecutable?.sha256,
      );
      expect(spatialReferenceV2BuildDigest(after)).not.toBe(spatialReferenceV2BuildDigest(before));
    },
  );
});
