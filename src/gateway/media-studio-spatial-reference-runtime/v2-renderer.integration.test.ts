import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        camera,
        nodes,
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
        guardianId: `spatial-render-integration-guardian:${receipt.pid}`,
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
  }, 120_000);
});
