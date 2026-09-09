import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import {
  createSpatialReferenceJournal,
  type SpatialReferenceExpectedOutput,
  type SpatialReferenceJournalIdentity,
  type SpatialReferenceJournalOwner,
} from "./reference-journal.js";

const guardianUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spatialReferenceGuardian);
const rendererFixtureUrl = new URL("./spatial-guardian.renderer.fixture.mjs", import.meta.url);

describe.skipIf(process.platform === "win32")("spatial guardian private launch", () => {
  const supervisors: Array<ReturnType<typeof createProcessSupervisor>> = [];

  afterEach(async () => {
    closePluginStateDatabase();
    await Promise.all(supervisors.splice(0).map(async (supervisor) => await supervisor.shutdown()));
  });

  it("requires durable parent acknowledgements before it starts its owned renderer child", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spatial-guardian-"));
    const requestPath = path.join(directory, "request.json");
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        workDir: directory,
        outputs: [{ slot: "end_frame", ordinal: 0 }],
      }),
    );
    const supervisor = createProcessSupervisor();
    supervisors.push(supervisor);
    const messages: unknown[] = [];
    const generation = "guardian-integration-generation";
    const identity: SpatialReferenceJournalIdentity = {
      key: "guardian-integration-idempotency",
      runtimeId: "guardian-integration-runtime",
      runtimeIdempotencyKey: "guardian-integration-idempotency",
      executionId: "guardian-integration-execution",
      workspaceId: "guardian-integration-workspace",
      taskId: "guardian-integration-task",
      materializationId: "guardian-integration-materialization",
      dispatchAttemptId: "guardian-integration-dispatch",
      sequence: 1,
      attempt: 1,
      intentFingerprint: "guardian-integration-intent",
      executionFingerprint: "guardian-integration-execution-fingerprint",
      blueprintDigest: "guardian-integration-blueprint",
      contractVersion: "spatial_reference_render/v2",
      rendererBuildDigest: "guardian-integration-build",
      frozenDispatchDigest: "a".repeat(64),
    };
    const expected: SpatialReferenceExpectedOutput[] = [
      {
        slot: "end_frame",
        ordinal: 0,
        artifactId: "guardian-output",
        expectedMimeType: "image/png",
      },
    ];
    const parentStartTime = getFileLockProcessStartTime(process.pid);
    if (parentStartTime === null) throw new Error("guardian_test_parent_identity_unavailable");
    const owner: SpatialReferenceJournalOwner = {
      epoch: "guardian-integration-owner",
      pid: process.pid,
      pidStartTimeMs: parentStartTime,
      ownerInstanceId: "guardian-integration-instance",
    };
    const journal = createSpatialReferenceJournal({
      env: { OPENCLAW_STATE_DIR: directory },
      namespace: "guardian-integration-journal",
    });
    await journal.accept({
      identity,
      ack: {
        ok: true,
        accepted: true,
        deferredSettlement: true,
        runtimeId: identity.runtimeId,
        executionId: identity.executionId,
        taskId: identity.taskId,
        materializationId: identity.materializationId,
        attempt: identity.attempt,
        dispatchAttemptId: identity.dispatchAttemptId,
        sequence: identity.sequence,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        intentFingerprint: identity.intentFingerprint,
        executionFingerprint: identity.executionFingerprint,
        blueprintDigest: identity.blueprintDigest,
      },
      requestDigest: "guardian-integration-request",
      expectedOutputs: expected,
    });
    const scopeKey = "spatial-guardian-integration-scope";
    const runId = "spatial-guardian-integration-run";
    await journal.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 100_000,
      scopeKey,
      runId,
    });
    try {
      const run = await supervisor.spawn({
        mode: "child",
        runId,
        sessionId: "spatial-guardian-integration-session",
        backendId: "spatial-reference-v2-guardian",
        scopeKey,
        argv: [
          process.execPath,
          ...resolveRuntimeWorkerArgv(guardianUrl),
          "--renderer-worker-url",
          rendererFixtureUrl.href,
          "--request",
          requestPath,
          "--manifest",
          manifestPath,
          "--generation",
          generation,
        ],
        stdinMode: "pipe-closed",
        ownedWorker: true,
        deferWorkerStart: true,
        workerStartHandshake: true,
        captureOutput: false,
        onWorkerMessage: (message) => messages.push(message),
      });
      expect(run.openStartGate).toBeTypeOf("function");
      expect(run.sendWorkerMessage).toBeTypeOf("function");
      const guardianStartTime = getFileLockProcessStartTime(run.pid!);
      if (guardianStartTime === null) throw new Error("guardian_test_identity_unavailable");
      const guardian = {
        protocol: "spatial_guardian/v1" as const,
        guardianId: `guardian-integration:${run.pid}`,
        generation,
        pid: run.pid!,
        pidStartTimeMs: guardianStartTime,
        guardianBuildDigest: identity.rendererBuildDigest,
        armedAtMs: 1,
      };
      await journal.armScopeGuardian({ identity, owner, guardian, nowMs: 1 });
      await run.openStartGate?.();
      await run.sendWorkerMessage?.({
        type: "spatial-guardian-journal-context-v1",
        generation,
        sequence: 0,
        journal: {
          stateDir: directory,
          namespace: "guardian-integration-journal",
          identity,
          owner,
        },
        guardian,
        scope: { scopeKey, runId },
      });
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "spatial-guardian-spawn-intent-v1",
            generation,
            sequence: 0,
          }),
        ),
      );
      await run.sendWorkerMessage?.({
        type: "spatial-guardian-spawn-intent-ack-v1",
        generation,
        sequence: 0,
      });
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "spatial-guardian-worker-prepared-v1",
            generation,
            sequence: 1,
            worker: { pid: expect.any(Number), startTime: expect.any(Number) },
          }),
        ),
      );
      await run.sendWorkerMessage?.({
        type: "spatial-guardian-authorize-start-v1",
        generation,
        sequence: 1,
      });
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "spatial-guardian-start-authorized-v1",
            generation,
            sequence: 2,
          }),
        ),
      );
      await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
      await supervisor.waitForScope(scopeKey);
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
        outputs: [{ slot: "end_frame", ordinal: 0, file: "guardian-end_frame-0.png" }],
      });
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "spatial-guardian-scope-observation-v1",
          generation,
          sequence: 2,
          reason: "posix_scope_unproven",
        }),
      );
      await expect(journal.get(identity.key)).resolves.toMatchObject({
        launchState: "start_authorized",
        worker: { scopeId: scopeKey, runId },
        scopeRecovery: { state: "unknown", reason: "scope_observation_unknown" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
