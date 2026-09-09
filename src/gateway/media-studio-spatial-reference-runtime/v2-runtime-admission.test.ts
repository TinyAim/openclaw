import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSpatialReferenceJournal } from "./reference-journal.js";
import type { SpatialReferenceJournalOwner } from "./reference-journal.js";
import { resolveSpatialReferenceV2RuntimeToolchain } from "./v2-runtime-admission.js";

const bundleDir = path.resolve(process.cwd(), "../../../apps/control_surface/spatial_babylon/dist");

const fakeToolchain = {
  chromiumVersion: "test-chromium",
  ffmpegVersion: "test-ffmpeg",
  ffprobeVersion: "test-ffprobe",
  ffmpegSha256: "a".repeat(64),
  ffprobeSha256: "b".repeat(64),
  ffmpegBuildConfiguration: "test-ffmpeg-build",
  ffprobeBuildConfiguration: "test-ffprobe-build",
};

const fakeRender = {
  compositionPng: Buffer.from([137, 80, 78, 71]),
  compositionPixelDigest: "sha256:test",
  width: 1280,
  height: 720,
  motionMp4: Buffer.from("motion"),
  fps: 12 as const,
  frameCount: 1,
  durationMs: 83,
  evaluatorVersion: "spatial_frame_eval/v4",
  referencePngs: [],
};

const owner: SpatialReferenceJournalOwner = {
  epoch: "epoch-admission",
  pid: 10,
  pidStartTimeMs: 20,
  ownerInstanceId: "instance-admission",
};

describe("Spatial v2 runtime qualification admission", () => {
  it.each(["throw", "quarantine"])("does not swallow an admission release %s", async (failure) => {
    const journal = createSpatialReferenceJournal();
    journal.releaseExclusiveAdmission = async () => {
      if (failure === "throw") throw Error("injected SQLite release failure");
      return { released: false, quarantined: true, reason: "scope_stop_unconfirmed" };
    };
    const result = await resolveSpatialReferenceV2RuntimeToolchain({
      bundleDir,
      chromiumExecutablePath: process.execPath,
      journal,
      runtimeId: "runtime-admission",
      executionMode: "packaged",
      readHostAvailableBytes: () => 1,
    });
    expect(result).toMatchObject({
      reason:
        failure === "throw"
          ? "spatial_v2_qualification_admission_release_failed"
          : "spatial_v2_qualification_scope_unconfirmed",
    });
    await expect(journal.getRuntimeAdmission()).resolves.toMatchObject({ state: "owned" });
  });
  it("rejects low host memory with zero probe and zero worker", async () => {
    const journal = createSpatialReferenceJournal();
    let probeCount = 0;
    let workerCount = 0;
    const result = await resolveSpatialReferenceV2RuntimeToolchain({
      bundleDir,
      chromiumExecutablePath: process.execPath,
      journal,
      runtimeId: "runtime-admission",
      executionMode: "packaged",
      readHostAvailableBytes: () => 1,
      testProbeToolchain: async () => {
        probeCount += 1;
        return fakeToolchain;
      },
      testRenderQualification: async () => {
        workerCount += 1;
        return fakeRender;
      },
    });
    expect(result).toMatchObject({
      reason: expect.stringContaining("spatial_v2_host_memory_unavailable"),
    });
    expect(probeCount).toBe(0);
    expect(workerCount).toBe(0);
    await expect(journal.getRuntimeAdmission()).resolves.toMatchObject({ state: "released" });
  });

  it("rejects a quarantined journal with zero probe and zero worker", async () => {
    const journal = createSpatialReferenceJournal();
    const claimed = await journal.claimExclusiveAdmission({
      owner,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "qual-scope",
      runId: "qual-run",
      runtimeId: "runtime-admission",
    });
    expect(claimed.claimed).toBe(true);
    await journal.releaseExclusiveAdmission({
      owner,
      nowMs: 3,
      scopeEvidence: "never_spawned",
      spawned: true,
    });
    await expect(journal.getRuntimeAdmission()).resolves.toMatchObject({ state: "quarantined" });

    let probeCount = 0;
    let workerCount = 0;
    const result = await resolveSpatialReferenceV2RuntimeToolchain({
      bundleDir,
      chromiumExecutablePath: process.execPath,
      journal,
      runtimeId: "runtime-admission",
      executionMode: "packaged",
      readHostAvailableBytes: () => 4 * 1024 * 1024 * 1024,
      testProbeToolchain: async () => {
        probeCount += 1;
        return fakeToolchain;
      },
      testRenderQualification: async () => {
        workerCount += 1;
        return fakeRender;
      },
    });
    expect(result).toMatchObject({
      reason: expect.stringContaining(
        "v2 resource qualification is blocked by durable Runtime admission",
      ),
    });
    expect(probeCount).toBe(0);
    expect(workerCount).toBe(0);
  });

  it("admits only one of two concurrent qualifications and uses a synthetic proof at most once", async () => {
    const journal = createSpatialReferenceJournal();
    let probeCount = 0;
    let workerCount = 0;
    let releaseFirstProbe: (() => void) | undefined;
    const firstProbeGate = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const params = {
      bundleDir,
      chromiumExecutablePath: process.execPath,
      journal,
      runtimeId: "runtime-admission",
      executionMode: "packaged" as const,
      readHostAvailableBytes: () => 4 * 1024 * 1024 * 1024,
      testProbeToolchain: async () => {
        probeCount += 1;
        if (probeCount === 1) await firstProbeGate;
        return fakeToolchain;
      },
      testRenderQualification: async () => {
        workerCount += 1;
        return fakeRender;
      },
    };
    const first = resolveSpatialReferenceV2RuntimeToolchain(params);
    const second = resolveSpatialReferenceV2RuntimeToolchain(params);
    await vi.waitFor(() => expect(probeCount).toBe(1));
    releaseFirstProbe?.();
    const results = await Promise.all([first, second]);
    const blocked = results.filter(
      (result) => "reason" in result && String(result.reason).includes("active_owner"),
    );
    expect(blocked).toHaveLength(1);
    expect(probeCount).toBe(1);
    expect(workerCount).toBeLessThanOrEqual(1);
  });

  it("builds the advertised identity from a renderer lifecycle proof", async () => {
    const journal = createSpatialReferenceJournal();
    const result = await resolveSpatialReferenceV2RuntimeToolchain({
      bundleDir,
      chromiumExecutablePath: process.execPath,
      journal,
      runtimeId: "runtime-admission",
      executionMode: "packaged",
      readHostAvailableBytes: () => 4 * 1024 * 1024 * 1024,
      testRenderQualification: async (_dispatch, _signal, lifecycle) => {
        await lifecycle?.onToolchainProof?.(fakeToolchain);
        return fakeRender;
      },
    });
    expect(result).toMatchObject({
      chromiumExecutablePath: process.execPath,
      buildIdentity: {
        manifestInput: {
          toolchain: {
            chromiumVersion: fakeToolchain.chromiumVersion,
            ffmpegVersion: fakeToolchain.ffmpegVersion,
            ffprobeVersion: fakeToolchain.ffprobeVersion,
          },
        },
      },
    });
    expect("reason" in result).toBe(false);
    await expect(journal.getRuntimeAdmission()).resolves.toMatchObject({ state: "released" });
  });
});
