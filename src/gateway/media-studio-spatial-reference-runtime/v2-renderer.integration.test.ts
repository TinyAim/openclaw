import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import type {
  SpatialReferenceRelayDispatch,
  SpatialReferenceRelayDispatchAck,
} from "../media-studio-spatial-reference-render-http.js";
import { referenceIdentity } from "./reference-execution.js";
import {
  createSpatialReferenceJournal,
  type SpatialReferenceJournalOwner,
  type SpatialReferenceJournalScopeGuardian,
  type SpatialReferenceJournalWorker,
} from "./reference-journal.js";
import {
  createSpatialReferenceV2Renderer,
  type SpatialReferenceV2GuardianIdentity,
  type SpatialReferenceV2RenderLifecycle,
  type SpatialReferenceV2ScopeObservation,
  type SpatialReferenceV2WorkerIdentity,
} from "./v2-renderer.js";

// Opt-in isolated real tools: never opens the user's browser or installs binaries.
const executable = process.env.SPATIAL_TEST_CHROMIUM;
const html = process.env.SPATIAL_TEST_REFERENCE_HTML;
const config = { chromiumExecutablePath: executable ?? "", referenceRenderHtmlPath: html ?? "" };
const execFileAsync = promisify(execFile);
const temporaryStateDirectories: string[] = [];

afterEach(async () => {
  closePluginStateDatabase();
  await Promise.all(
    temporaryStateDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function input(
  duration: number,
  motionMode: "both" | "subject" | "camera" = "both",
): Extract<SpatialReferenceRelayDispatch, { contractVersion: "spatial_reference_render/v2" }> {
  const camera = {
    position: { x: 0, y: 2, z: 5 },
    targetPoint: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
  };
  const nodes = [
    {
      nodeId: "wall",
      kind: "prop_placeholder",
      position: { x: 0, y: 1, z: -2 },
      scale: { x: 4, y: 2, z: 0.2 },
    },
    { nodeId: "actor-left", kind: "character_placeholder", position: { x: -0.8, y: 0, z: 0 } },
    { nodeId: "actor-right", kind: "character_placeholder", position: { x: 0.8, y: 0, z: -1 } },
  ];
  const count = Math.ceil((duration * 12) / 1000);
  const motionSnapshot = (index: number) => {
    const progress = count <= 1 ? 0 : index / (count - 1);
    return {
      camera: {
        ...camera,
        position: {
          ...camera.position,
          x: motionMode === "subject" ? camera.position.x : progress * 0.8,
        },
        targetPoint: {
          ...camera.targetPoint,
          x: motionMode === "subject" ? camera.targetPoint.x : progress * 0.3,
        },
      },
      nodes: nodes.map((node) =>
        node.nodeId === "actor-right"
          ? {
              ...node,
              position: {
                ...node.position,
                x: motionMode === "camera" ? node.position.x : 0.8 + progress * 0.9,
              },
            }
          : node,
      ),
    };
  };
  return {
    kind: "media_studio.spatial_reference_render",
    contractVersion: "spatial_reference_render/v2",
    workspaceId: "test-workspace",
    runtimeId: "test-runtime",
    projectId: "test-project",
    shotId: "test-shot",
    taskId: "test-task",
    materializationId: "test-materialization",
    runtimeIdempotencyKey: "test-key",
    requestId: "test-request",
    attempt: 1,
    dispatchAttemptId: "test-attempt",
    sequence: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    intentFingerprint: "test-intent",
    executionFingerprint: "test-execution",
    blueprint: {
      blueprintId: "test-blueprint",
      version: 1,
      blueprintDigest: "test-digest",
      frameAspectRatio: 16 / 9,
      camera,
      nodes,
    },
    renderIntent: {
      profile: "proxy_previs",
      width: 160,
      height: 90,
      backgroundPolicy: "neutral_studio",
      rendererContractVersion: "spatial_reference_render/v2",
      rendererBuildDigest: "sha256:test",
      renderSpecDigest: "test-spec",
    },
    sourceGrants: [],
    outputUploadGrant: {
      purpose: "output_upload",
      grantToken: "unused-test",
      artifactId: "test-frame",
    },
    motionReferenceUploadGrant: {
      purpose: "output_upload",
      grantToken: "unused-test",
      artifactId: "test-motion",
    },
    expectedOutputs: [
      {
        slot: "composition_frame",
        ordinal: 0,
        artifactId: "test-frame",
        mimeType: "image/png",
      },
      {
        slot: "motion_reference_video",
        ordinal: 0,
        artifactId: "test-motion",
        mimeType: "video/mp4",
      },
      {
        slot: "start_frame",
        ordinal: 0,
        artifactId: "test-start",
        mimeType: "image/png",
        sourceTimeMs: 0,
      },
      {
        slot: "end_frame",
        ordinal: 0,
        artifactId: "test-end",
        mimeType: "image/png",
        sourceTimeMs: duration,
      },
      { slot: "topdown_frame", ordinal: 0, artifactId: "test-top", mimeType: "image/png" },
    ],
    outputUploadGrants: [
      {
        purpose: "output_upload",
        grantToken: "unused-test",
        artifactId: "test-start",
        slot: "start_frame",
        ordinal: 0,
      },
      {
        purpose: "output_upload",
        grantToken: "unused-test",
        artifactId: "test-end",
        slot: "end_frame",
        ordinal: 0,
      },
      {
        purpose: "output_upload",
        grantToken: "unused-test",
        artifactId: "test-top",
        slot: "topdown_frame",
        ordinal: 0,
      },
    ],
    callback: {
      path: "/v1/control/media-gen/runtime/spatial-reference/callback",
      controlApiBaseUrl: "https://unused.invalid",
    },
    motionReference: {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs: duration,
      encodedDurationMs: Math.round((count * 1000) / 12),
      evaluatorVersion: "spatial_frame_eval/v4",
      frames: Array.from({ length: count }, (_, i) => ({
        timeMs: i === count - 1 ? duration : Math.round((i * 1000) / 12),
        snapshotDigest: `frame-${i}`,
        ...motionSnapshot(i),
      })),
      referenceFrames: [
        {
          slot: "start_frame",
          ordinal: 0,
          sourceTimeMs: 0,
          snapshotDigest: "start",
          camera,
          nodes,
        },
        {
          slot: "end_frame",
          ordinal: 0,
          sourceTimeMs: duration,
          snapshotDigest: "end",
          camera,
          nodes,
        },
        { slot: "topdown_frame", ordinal: 0, snapshotDigest: "top", camera, nodes },
      ],
    },
  };
}

function executionAck(
  scene: Extract<SpatialReferenceRelayDispatch, { contractVersion: "spatial_reference_render/v2" }>,
): SpatialReferenceRelayDispatchAck {
  return {
    ok: true,
    accepted: true,
    deferredSettlement: true,
    runtimeId: scene.runtimeId,
    executionId: `spatial-test-execution-${randomUUID()}`,
    taskId: scene.taskId,
    materializationId: scene.materializationId,
    attempt: scene.attempt,
    dispatchAttemptId: scene.dispatchAttemptId,
    sequence: scene.sequence,
    leaseExpiresAt: scene.leaseExpiresAt,
    intentFingerprint: scene.intentFingerprint,
    executionFingerprint: scene.executionFingerprint,
    blueprintDigest: scene.blueprint.blueprintDigest,
  };
}

async function renderWithDurableGuardian(
  scene: Extract<SpatialReferenceRelayDispatch, { contractVersion: "spatial_reference_render/v2" }>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spatial-render-integration-"));
  temporaryStateDirectories.push(directory);
  const namespace = `spatial-render-integration-${randomUUID()}`;
  const journal = createSpatialReferenceJournal({
    env: { OPENCLAW_STATE_DIR: directory },
    namespace,
  });
  const ack = executionAck(scene);
  const { identity, expectedOutputs } = referenceIdentity(scene, ack);
  const parentStartTime = getFileLockProcessStartTime(process.pid);
  if (parentStartTime === null) throw new Error("spatial_render_parent_identity_unavailable");
  const owner: SpatialReferenceJournalOwner = {
    epoch: randomUUID(),
    pid: process.pid,
    pidStartTimeMs: parentStartTime,
    ownerInstanceId: randomUUID(),
  };
  const scopeKey = `spatial-render-integration-scope-${randomUUID()}`;
  const runId = `spatial-render-integration-run-${randomUUID()}`;
  await journal.accept({
    identity,
    ack,
    requestDigest: randomUUID(),
    expectedOutputs,
  });
  const claimed = await journal.claim({
    identity,
    owner,
    expectedOutputs,
    nowMs: Date.now(),
    leaseExpiresAtMs: Date.now() + 120_000,
    scopeKey,
    runId,
  });
  if (!claimed.claimed) throw new Error(`spatial_render_journal_claim_failed:${claimed.reason}`);

  let guardian: SpatialReferenceJournalScopeGuardian | undefined;
  let worker: SpatialReferenceJournalWorker | undefined;
  const lifecycle: SpatialReferenceV2RenderLifecycle = {
    executionScope: { scopeKey, runId },
    guardianJournal: {
      stateDir: directory,
      namespace,
      identity,
      owner,
      guardianBuildDigest: identity.rendererBuildDigest,
      reserveGuardianLaunch: ({ generation, nowMs }) =>
        journal.reserveScopeGuardianLaunch({
          identity,
          owner,
          generation,
          guardianBuildDigest: identity.rendererBuildDigest,
          nowMs,
        }),
      guardianFor: (receipt: SpatialReferenceV2GuardianIdentity) =>
        guardian &&
        guardian.pid === receipt.pid &&
        guardian.pidStartTimeMs === receipt.startTime &&
        guardian.generation === receipt.generation
          ? guardian
          : undefined,
    },
    onGuardianLaunched: async (receipt: SpatialReferenceV2GuardianIdentity) => {
      guardian = {
        protocol: "spatial_guardian/v1",
        guardianId: `spatial-guardian:${owner.epoch}:${receipt.pid}`,
        generation: receipt.generation,
        pid: receipt.pid,
        pidStartTimeMs: receipt.startTime,
        guardianBuildDigest: identity.rendererBuildDigest,
        armedAtMs: Date.now(),
      };
      await journal.armScopeGuardian({ identity, owner, nowMs: Date.now(), guardian });
    },
    onSpawnIntent: async () => {
      if (!guardian) throw new Error("spatial_render_guardian_identity_missing");
    },
    onLaunched: async (receipt: SpatialReferenceV2WorkerIdentity) => {
      worker = {
        pid: receipt.pid,
        startTime: receipt.startTime,
        scopeId: receipt.scopeKey,
        runId: receipt.runId,
        workerTokenDigest: createHash("sha256").update(receipt.runId).digest("hex"),
      };
      await journal.checkpoint({
        identity,
        owner,
        nowMs: Date.now(),
        phase: "worker_started",
        worker,
      });
    },
    onStartAuthorized: async (_receiptGuardian, receipt) => {
      if (!worker || receipt.pid !== worker.pid || receipt.startTime !== worker.startTime) {
        throw new Error("spatial_render_worker_authorization_invalid");
      }
    },
    onScopeObservation: async (observation: SpatialReferenceV2ScopeObservation) => {
      if (
        !guardian ||
        !worker ||
        observation.guardian.pid !== guardian.pid ||
        observation.guardian.startTime !== guardian.pidStartTimeMs ||
        observation.guardian.generation !== guardian.generation ||
        observation.worker.pid !== worker.pid ||
        observation.worker.startTime !== worker.startTime
      ) {
        throw new Error("spatial_render_scope_observation_invalid");
      }
    },
    onExited: async (receipt) => {
      if (!worker || receipt.pid !== worker.pid || receipt.startTime !== worker.startTime) {
        throw new Error("spatial_render_worker_exit_invalid");
      }
      worker = {
        ...worker,
        exited: { atMs: Date.now(), reason: "completed" },
      };
      await journal.checkpoint({
        identity,
        owner,
        nowMs: Date.now(),
        phase: "worker_exited",
        worker,
      });
    },
  };
  const result = await createSpatialReferenceV2Renderer(config).render(
    scene,
    new AbortController().signal,
    lifecycle,
  );
  await expect(journal.get(identity.key)).resolves.toMatchObject({
    launchState: "start_authorized",
    worker: { scopeId: scopeKey, runId, exited: { reason: "completed" } },
    scopeRecovery: {
      state: "extinct",
      proof: {
        protocol: "posix_group_observation_v1",
        processGroupId: expect.any(Number),
        rootState: "dead",
      },
    },
  });
  return result;
}

async function decodePngRgb(png: Buffer, label: string): Promise<Buffer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spatial-png-decode-"));
  temporaryStateDirectories.push(directory);
  const file = path.join(directory, `${label}.png`);
  await writeFile(file, png);
  const decoded = await execFileAsync(
    process.env.SPATIAL_TEST_FFMPEG ?? "ffmpeg",
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", "1", "-"],
    { encoding: "buffer", maxBuffer: 160 * 90 * 3 + 1024 },
  );
  const rgb = Buffer.isBuffer(decoded.stdout)
    ? decoded.stdout
    : Buffer.from(decoded.stdout, "binary");
  expect(rgb).toHaveLength(160 * 90 * 3);
  return rgb;
}

function countDifferentRgbPixels(left: Buffer, right: Buffer): number {
  let count = 0;
  for (let offset = 0; offset < left.length; offset += 3) {
    if (
      left[offset] !== right[offset] ||
      left[offset + 1] !== right[offset + 1] ||
      left[offset + 2] !== right[offset + 2]
    ) {
      count += 1;
    }
  }
  return count;
}

function meanAbsoluteRgbDifference(left: Buffer, right: Buffer): number {
  let total = 0;
  for (let offset = 0; offset < left.length; offset += 1) {
    total += Math.abs(left[offset] - right[offset]);
  }
  return total / left.length;
}

function foregroundBounds(rgb: Buffer, width = 160, height = 90) {
  const background = rgb.subarray(0, 3);
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const distance =
        Math.abs(rgb[offset] - background[0]) +
        Math.abs(rgb[offset + 1] - background[1]) +
        Math.abs(rgb[offset + 2] - background[2]);
      if (distance > 36) points.push({ x, y });
    }
  }
  expect(points.length).toBeGreaterThan(8);
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
    centroidX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  };
}

async function decodeSelectedMotionFrames(video: Buffer, frameCount: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spatial-motion-roi-"));
  temporaryStateDirectories.push(directory);
  const file = path.join(directory, "motion.mp4");
  await writeFile(file, video);
  const middle = Math.floor((frameCount - 1) / 2);
  const last = frameCount - 1;
  const decoded = await execFileAsync(
    process.env.SPATIAL_TEST_FFMPEG ?? "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `select='eq(n\\,0)+eq(n\\,${middle})+eq(n\\,${last})'`,
      "-vsync",
      "0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 160 * 90 * 3 * 3 + 1024 },
  );
  const raw = Buffer.isBuffer(decoded.stdout)
    ? decoded.stdout
    : Buffer.from(decoded.stdout, "binary");
  const frameSize = 160 * 90 * 3;
  expect(raw).toHaveLength(frameSize * 3);
  return [0, 1, 2].map((index) => raw.subarray(index * frameSize, (index + 1) * frameSize));
}

describe.skipIf(!executable || !html)("Spatial isolated real Chromium/Babylon/FFmpeg", () => {
  for (const duration of [1, 83, 84, 9999, 10000]) {
    it(`renders and fully decodes ${duration}ms`, async () => {
      const result = await renderWithDurableGuardian(input(duration));
      expect(result.frameCount).toBe(Math.ceil((duration * 12) / 1000));
      expect(result.motionMp4.subarray(4, 8).toString()).toBe("ftyp");
      expect(result.compositionPng.length).toBeGreaterThan(100);
      expect(result.referencePngs).toHaveLength(3);
      expect(result.evaluatorVersion).toBe("spatial_frame_eval/v4");
    }, 120_000);
  }
  it("rejects 10001ms before browser launch", async () => {
    await expect(
      createSpatialReferenceV2Renderer(config).render(input(10001), new AbortController().signal),
    ).rejects.toThrow("spatial_v2_motion_limits_invalid");
  });
  it("draws geometry rather than only a valid blank PNG and reproduces frozen pixels", async () => {
    const scene = input(83);
    const first = await renderWithDurableGuardian(scene);
    const again = await renderWithDurableGuardian(scene);
    const empty = input(83);
    empty.blueprint.nodes = [];
    empty.motionReference.frames.forEach((frame) => {
      frame.nodes = [];
    });
    empty.motionReference.referenceFrames?.forEach((frame) => {
      frame.nodes = [];
    });
    const blank = await renderWithDurableGuardian(empty);
    expect(first.compositionPng.equals(blank.compositionPng)).toBe(false);
    expect(first.compositionPng.equals(again.compositionPng)).toBe(true);
    expect(first.referencePngs[0].png.equals(first.compositionPng)).toBe(true);

    const firstRgb = await decodePngRgb(first.compositionPng, "geometry");
    const blankRgb = await decodePngRgb(blank.compositionPng, "background");
    const repeatedRgb = await decodePngRgb(again.compositionPng, "repeat");
    // The fixed background must remain stable while subject geometry changes
    // actual decoded RGB pixels; PNG/container validity alone is insufficient.
    expect(firstRgb.subarray(0, 3)).toEqual(blankRgb.subarray(0, 3));
    expect(firstRgb.subarray(0, 3)).toEqual(repeatedRgb.subarray(0, 3));
    expect(countDifferentRgbPixels(firstRgb, blankRgb)).toBeGreaterThan(10);
  }, 120_000);

  it.each([4000, 1100])(
    "decodes first, middle, and last distinct motion frames for %dms",
    async (duration) => {
      const scene = input(duration);
      const result = await renderWithDurableGuardian(scene);
      const directory = await mkdtemp(path.join(os.tmpdir(), "spatial-motion-decode-"));
      temporaryStateDirectories.push(directory);
      const video = path.join(directory, "motion.mp4");
      await writeFile(video, result.motionMp4);
      const middle = Math.floor((result.frameCount - 1) / 2);
      const last = result.frameCount - 1;
      const decoded = await execFileAsync(process.env.SPATIAL_TEST_FFMPEG ?? "ffmpeg", [
        "-v",
        "error",
        "-i",
        video,
        "-vf",
        `select='eq(n\\,0)+eq(n\\,${middle})+eq(n\\,${last})'`,
        "-vsync",
        "0",
        "-f",
        "framemd5",
        "-",
      ]);
      const hashes = decoded.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && /^\d+,/.test(line))
        .map((line) => line.split(",").at(-1)?.trim())
        .filter((hash): hash is string => Boolean(hash));
      expect(hashes).toHaveLength(3);
      expect(new Set(hashes).size).toBe(3);
      const first = scene.motionReference.frames[0];
      const final = scene.motionReference.frames.at(-1);
      expect(first?.camera.position.x).toBeLessThan(final?.camera.position.x ?? 0);
      expect(first?.camera.targetPoint.x).toBeLessThan(final?.camera.targetPoint.x ?? 0);
      expect(first?.nodes.find((node) => node.nodeId === "actor-right")?.position.x).toBeLessThan(
        final?.nodes.find((node) => node.nodeId === "actor-right")?.position.x ?? 0,
      );

      const endReference = result.referencePngs.find((reference) => reference.slot === "end_frame");
      expect(endReference?.sourceTimeMs).toBe(duration);
      expect(endReference).toBeDefined();
      const endRgb = await decodePngRgb(endReference!.png, "end-reference");
      const finalPng = path.join(directory, "motion-final.png");
      await execFileAsync(process.env.SPATIAL_TEST_FFMPEG ?? "ffmpeg", [
        "-v",
        "error",
        "-i",
        video,
        "-vf",
        `select='eq(n\\,${last})'`,
        "-vsync",
        "0",
        "-frames:v",
        "1",
        finalPng,
      ]);
      const finalVideoRgb = await decodePngRgb(await readFile(finalPng), "video-final");
      // The MP4 is lossy; verify the final decoded frame remains the frozen end
      // reference within a bounded RGB tolerance instead of comparing bytes.
      expect(meanAbsoluteRgbDifference(endRgb, finalVideoRgb)).toBeLessThan(20);
    },
    120_000,
  );

  it.each([
    ["subject", 1],
    ["camera", -1],
  ] as const)(
    "proves %s-only displacement with RGB ROI and direction",
    async (mode, expectedDirection) => {
      const scene = input(1100, mode);
      scene.blueprint.nodes = scene.blueprint.nodes.filter((node) => node.nodeId === "actor-right");
      scene.motionReference.frames = scene.motionReference.frames.map((frame) => ({
        ...frame,
        nodes: frame.nodes.filter((node) => node.nodeId === "actor-right"),
      }));
      scene.motionReference.referenceFrames = scene.motionReference.referenceFrames?.map(
        (frame) => ({
          ...frame,
          nodes: frame.nodes.filter((node) => node.nodeId === "actor-right"),
        }),
      );
      const result = await renderWithDurableGuardian(scene);
      const frames = await decodeSelectedMotionFrames(result.motionMp4, result.frameCount);
      const bounds = frames.map((frame) => foregroundBounds(frame));
      const displacement = bounds.at(-1)!.centroidX - bounds[0].centroidX;
      expect(Math.abs(displacement)).toBeGreaterThan(2);
      expect(Math.sign(displacement)).toBe(expectedDirection);
      const edgeDelta =
        expectedDirection === 1
          ? bounds.at(-1)!.minX - bounds[0].minX
          : bounds.at(-1)!.maxX - bounds[0].maxX;
      expect(expectedDirection * edgeDelta).toBeGreaterThan(-3);
      if (mode === "subject") {
        expect(scene.motionReference.frames[0].camera).toEqual(
          scene.motionReference.frames.at(-1)!.camera,
        );
        expect(scene.motionReference.frames[0].nodes[0].position.x).toBeLessThan(
          scene.motionReference.frames.at(-1)!.nodes[0].position.x,
        );
      } else {
        expect(scene.motionReference.frames[0].nodes[0].position.x).toBe(
          scene.motionReference.frames.at(-1)!.nodes[0].position.x,
        );
        expect(scene.motionReference.frames[0].camera.position.x).toBeLessThan(
          scene.motionReference.frames.at(-1)!.camera.position.x,
        );
      }
    },
    120_000,
  );

  it("rejects frozen motion as a false positive when all decoded frames keep the same ROI", async () => {
    const scene = input(1100, "subject");
    scene.blueprint.nodes = scene.blueprint.nodes.filter((node) => node.nodeId === "actor-right");
    scene.motionReference.frames = scene.motionReference.frames.map((frame) => ({
      ...frame,
      nodes: frame.nodes.filter((node) => node.nodeId === "actor-right"),
    }));
    scene.motionReference.referenceFrames = scene.motionReference.referenceFrames?.map((frame) => ({
      ...frame,
      nodes: frame.nodes.filter((node) => node.nodeId === "actor-right"),
    }));
    const first = scene.motionReference.frames[0];
    scene.motionReference.frames = scene.motionReference.frames.map((frame) => ({
      ...frame,
      camera: first.camera,
      nodes: first.nodes,
    }));
    const result = await renderWithDurableGuardian(scene);
    const frames = await decodeSelectedMotionFrames(result.motionMp4, result.frameCount);
    const bounds = frames.map((frame) => foregroundBounds(frame));
    expect(Math.abs(bounds.at(-1)!.centroidX - bounds[0].centroidX)).toBeLessThanOrEqual(2);
    expect(meanAbsoluteRgbDifference(frames[0], frames.at(-1)!)).toBeLessThan(8);
  }, 120_000);
});
