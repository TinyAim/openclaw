import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.js";
import { createChildAdapter } from "../../process/supervisor/adapters/child.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import type { ProcessSupervisor, SpawnInput } from "../../process/supervisor/types.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { SpatialReferenceJournalRow } from "./reference-journal-record.js";
import type {
  SpatialReferenceJournalIdentity,
  SpatialReferenceJournalOwner,
  SpatialReferenceJournalScopeGuardian,
  SpatialReferenceJournalScopeGuardianProcessIdentity,
} from "./reference-journal-record.js";
import { createSpatialReferenceJournal } from "./reference-journal.js";
import { v2Dispatch } from "./reference.test-harness.js";
import {
  buildSpatialReferenceV2Manifest,
  spatialReferenceV2BuildDigest,
} from "./v2-build-manifest.js";
import {
  acceptSpatialReferenceV2ScopeObservation,
  assertSpatialReferenceV2DurableExtinction,
  assertSpatialReferenceV2ExtinctObservation,
} from "./v2-renderer-scope-evidence.js";
import { createSpatialReferenceV2Renderer } from "./v2-renderer.js";
import { SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL } from "./v2-renderer.js";
import { supportsSpatialReferenceV2ResourceLimits } from "./v2-resource-watch.js";

const fixtureUrl = new URL("./v2-renderer.supervision.fixture.mjs", import.meta.url);
const preReadyExitFixtureUrl = new URL("./v2-renderer.pre-ready-exit.fixture.mjs", import.meta.url);
const noWindows = process.platform === "win32";
const buildReferenceHtml = path.resolve(
  process.cwd(),
  "../../../apps/control_surface/spatial_babylon/dist/reference_render.html",
);
const buildToolchain = {
  chromiumVersion: "test-chromium",
  ffmpegVersion: "test-ffmpeg",
  ffprobeVersion: "test-ffprobe",
  ffmpegBuildConfiguration: "test-ffmpeg-build",
  ffprobeBuildConfiguration: "test-ffprobe-build",
};

async function waitForDead(pid: number): Promise<void> {
  await vi.waitFor(() => expect(isPidDefinitelyDead(pid)).toBe(true), { timeout: 2_000 });
}

async function createQualificationJournalFixture() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "spatial-prearm-renderer-test-"));
  const journal = createSpatialReferenceJournal({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    namespace: "spatial-prearm-renderer-test",
  });
  const owner: SpatialReferenceJournalOwner = {
    epoch: `prearm-owner-${Date.now()}`,
    pid: process.pid,
    pidStartTimeMs: Date.now(),
    ownerInstanceId: `prearm-owner-instance-${Date.now()}`,
  };
  const scopeKey = `prearm-scope-${Date.now()}`;
  const runId = `${scopeKey}-run`;
  const claimed = await journal.claimExclusiveAdmission({
    owner,
    nowMs: Date.now(),
    leaseExpiresAtMs: Date.now() + 60_000,
    scopeKey,
    runId,
    runtimeId: "prearm-runtime",
  });
  if (!claimed.claimed) throw new Error("prearm_journal_claim_failed");
  return { stateDir, journal, owner, identity: claimed.identity, scopeKey, runId };
}

function fixtureSupervisor(params: { audits: unknown[] }): {
  supervisor: ProcessSupervisor;
  shutdown: () => Promise<void>;
} {
  const owned = createProcessSupervisor();
  const supervisor: ProcessSupervisor = {
    acquireScopeCleanup: (scopeKey, options) => owned.acquireScopeCleanup(scopeKey, options),
    spawn: async (input: SpawnInput) =>
      await owned.spawn({
        ...input,
        // Test wrapper changes only the launched, owned child. It preserves the
        // production parent request assembly, scope, lifecycle gate, and owner.
        ...(input.mode === "child"
          ? {
              // Preserve the parent-assembled request/manifest arguments while
              // replacing only the owned worker entrypoint with the fixture.
              argv: [
                process.execPath,
                fixtureUrl.pathname,
                ...input.argv.slice(input.argv.indexOf("--request")),
              ],
              onWorkerMessage: (message: unknown) => {
                input.onWorkerMessage?.(message);
                params.audits.push(message);
              },
            }
          : {}),
      }),
    cancel: (runId, reason) => owned.cancel(runId, reason),
    cancelScope: (scopeKey, reason) => owned.cancelScope(scopeKey, reason),
    getRecord: (runId) => owned.getRecord(runId),
  };
  return { supervisor, shutdown: owned.shutdown };
}

describe("spatial v2 scope evidence", () => {
  const guardian = {
    pid: 101,
    startTime: 102,
    runId: "run-1",
    scopeKey: "scope-1",
    generation: "generation-1",
  } as const;
  const worker = {
    pid: 201,
    startTime: 202,
    runId: "run-1",
    scopeKey: "scope-1",
  } as const;
  const expected = { guardian, worker };
  const extinct = {
    guardian,
    worker,
    state: "extinct" as const,
    proof: {
      protocol: "posix_group_observation_v1" as const,
      processGroupId: worker.pid,
      rootState: "dead" as const,
    },
  };

  it("accepts only a reasoned unknown observation before a proven extinction", () => {
    const unknown = acceptSpatialReferenceV2ScopeObservation(
      undefined,
      {
        guardian,
        worker,
        state: "unknown",
        reason: "posix_scope_unproven",
      },
      expected,
    );
    expect(unknown.state).toBe("unknown");
    expect(() => assertSpatialReferenceV2ExtinctObservation(unknown, expected)).toThrow(
      "spatial_v2_scope_observation_unconfirmed",
    );
    expect(() =>
      acceptSpatialReferenceV2ScopeObservation(
        undefined,
        {
          ...unknown,
          proof: extinct.proof,
        },
        expected,
      ),
    ).toThrow("spatial_v2_scope_observation_unknown_invalid");
  });

  it("rejects stale owner/claim identities and contradictory observations", () => {
    expect(() =>
      acceptSpatialReferenceV2ScopeObservation(
        undefined,
        {
          ...extinct,
          guardian: { ...guardian, runId: "old-run" },
        },
        expected,
      ),
    ).toThrow("spatial_v2_scope_observation_identity_mismatch");
    expect(() =>
      acceptSpatialReferenceV2ScopeObservation(
        undefined,
        {
          ...extinct,
          worker: { ...worker, scopeKey: "old-scope" },
        },
        expected,
      ),
    ).toThrow("spatial_v2_scope_observation_identity_mismatch");
    const accepted = acceptSpatialReferenceV2ScopeObservation(undefined, extinct, expected);
    expect(() =>
      acceptSpatialReferenceV2ScopeObservation(
        accepted,
        {
          ...extinct,
          proof: { ...extinct.proof, rootState: "reused" },
        },
        expected,
      ),
    ).toThrow("spatial_v2_scope_observation_conflict");
    expect(() => assertSpatialReferenceV2ExtinctObservation(extinct, expected)).not.toThrow();
  });

  it("accepts durable proof when semantic fields are reordered and rejects current-worker or claim drift", () => {
    const durableWorker = {
      pid: 201,
      startTime: 202,
      scopeId: "scope-1",
      runId: "run-1",
      workerTokenDigest: "worker-digest",
    };
    const claim = {
      epoch: "epoch-1",
      pid: 301,
      pidStartTimeMs: 302,
      ownerInstanceId: "owner-1",
      leaseExpiresAtMs: 999,
      claimVersion: 7,
      scopeKey: "scope-1",
      runId: "run-1",
    };
    const proof = {
      protocol: "posix_group_observation_v1" as const,
      processGroupId: 201,
      rootState: "dead" as const,
    };
    const row = {
      recordType: "execution",
      schemaVersion: 4,
      key: "key-1",
      dispatchAttemptId: "attempt-1",
      cancelled: false,
      phase: "terminal",
      claim,
      worker: durableWorker,
      scopeRecovery: {
        guardian: {
          protocol: "spatial_guardian/v1",
          guardianId: "guardian-1",
          generation: "generation-1",
          pid: 101,
          pidStartTimeMs: 102,
          guardianBuildDigest: "sha256:guardian",
          armedAtMs: 1,
        },
        claimVersion: 7,
        owner: {
          epoch: "epoch-1",
          pid: 301,
          pidStartTimeMs: 302,
          ownerInstanceId: "owner-1",
        },
        state: "extinct",
        observedAtMs: 10,
        probes: 1,
        firstObservedAtMs: 9,
        worker: {
          pid: 201,
          startTime: 202,
          scopeId: "scope-1",
          runId: "run-1",
        },
        proof,
      },
    } as unknown as SpatialReferenceJournalRow;
    const reorderedProof = {
      rootState: "dead" as const,
      processGroupId: 201,
      protocol: "posix_group_observation_v1" as const,
    };
    expect(() =>
      assertSpatialReferenceV2DurableExtinction(
        {
          guardian: { ...guardian },
          worker: { ...worker },
          state: "extinct",
          proof: reorderedProof,
        },
        row,
      ),
    ).not.toThrow();
    expect(() =>
      assertSpatialReferenceV2DurableExtinction(
        {
          guardian: { ...guardian },
          worker: { ...worker, pid: 999 },
          state: "extinct",
          proof: reorderedProof,
        },
        row,
      ),
    ).toThrow("spatial_v2_scope_observation_durable_identity_mismatch");
    expect(() =>
      assertSpatialReferenceV2DurableExtinction(
        {
          guardian: { ...guardian },
          worker: { ...worker },
          state: "extinct",
          proof: reorderedProof,
        },
        { ...row, claim: { ...claim, claimVersion: 8 } },
      ),
    ).toThrow("spatial_v2_scope_observation_durable_identity_mismatch");
  });
});

describe.skipIf(noWindows || !supportsSpatialReferenceV2ResourceLimits())(
  "spatial v2 supervised worker",
  () => {
    const adapters: Array<Awaited<ReturnType<typeof createChildAdapter>>> = [];

    afterEach(() => {
      for (const adapter of adapters.splice(0)) {
        adapter.kill("SIGKILL");
        adapter.dispose();
      }
    });

    it("self-terminates a gated owned child when its parent IPC closes", async () => {
      const adapter = await createChildAdapter({
        argv: [process.execPath, fixtureUrl.pathname],
        stdinMode: "pipe-closed",
        ownedWorker: true,
        workerStartHandshake: true,
      });
      adapters.push(adapter);
      expect(adapter.pid).toBeTypeOf("number");
      await adapter.openStartGate?.();
      adapter.closeStartGate?.();
      await expect(adapter.wait()).resolves.toMatchObject({ code: 0, signal: null });
      await waitForDead(adapter.pid!);
    });

    it("cancels an unopened owned worker scope and confirms extinction", async () => {
      const supervisor = createProcessSupervisor();
      const scopeKey = `spatial-v2-supervision-cancel-${Date.now()}`;
      const closeScopeCleanup = supervisor.acquireScopeCleanup(scopeKey, {
        processTree: "transport-only",
      });
      const run = await supervisor.spawn({
        mode: "child",
        runId: `${scopeKey}-run`,
        sessionId: "spatial-v2-test",
        backendId: "spatial-v2-test",
        scopeKey,
        argv: [process.execPath, fixtureUrl.pathname],
        stdinMode: "pipe-closed",
        ownedWorker: true,
        deferWorkerStart: true,
        captureOutput: false,
      });
      expect(run.openStartGate).toBeTypeOf("function");
      expect(run.pid).toBeTypeOf("number");
      supervisor.cancelScope(scopeKey, "manual-cancel");
      await closeScopeCleanup();
      await expect(run.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
      await waitForDead(run.pid!);
      await supervisor.shutdown();
    });

    it("registers required-all cleanup before spawn and closes it when spawn rejects", async () => {
      const events: string[] = [];
      let cleanupClosed = false;
      const supervisor: ProcessSupervisor = {
        acquireScopeCleanup: (_scopeKey, _options) => {
          events.push("acquire");
          return async () => {
            events.push("cleanup");
            cleanupClosed = true;
          };
        },
        spawn: async () => {
          events.push("spawn");
          throw new Error("fixture_spawn_rejected");
        },
        cancel: () => undefined,
        cancelScope: () => events.push("cancel-scope"),
        getRecord: () => undefined,
      };
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: "fixture-no-chromium",
        referenceRenderHtmlPath: "/fixture/no-html",
        supervisor,
        guardianWorkerUrl: fixtureUrl,
      });

      await expect(
        renderer.renderMissing?.(v2Dispatch(), new AbortController().signal, [
          { slot: "end_frame", ordinal: 0 },
        ]),
      ).rejects.toThrow("fixture_spawn_rejected");
      expect(events.slice(0, 2)).toEqual(["acquire", "spawn"]);
      expect(cleanupClosed).toBe(true);
      expect(events).toContain("cleanup");
    });

    it("writes a pre-spawn exit receipt only after the exact Guardian scope settles", async () => {
      const fixture = fixtureSupervisor({ audits: [] });
      const parentStartTime = Date.now();
      const owner: SpatialReferenceJournalOwner = {
        epoch: "prearm-owner",
        pid: process.pid,
        pidStartTimeMs: parentStartTime,
        ownerInstanceId: "prearm-owner-instance",
      };
      const identity: SpatialReferenceJournalIdentity = {
        key: "prearm-execution",
        runtimeIdempotencyKey: "prearm-execution",
        runtimeId: "prearm-runtime",
        executionId: "prearm-execution-id",
        workspaceId: "prearm-workspace",
        taskId: "prearm-task",
        materializationId: "prearm-materialization",
        dispatchAttemptId: "prearm-attempt",
        sequence: 1,
        attempt: 1,
        intentFingerprint: "prearm-intent",
        executionFingerprint: "prearm-fingerprint",
        blueprintDigest: "prearm-blueprint",
        contractVersion: "spatial_reference_render/v2",
        rendererBuildDigest: "prearm-renderer-build",
        frozenDispatchDigest: "d".repeat(64),
      };
      let journalGuardian: SpatialReferenceJournalScopeGuardian | undefined;
      const reserved = vi.fn(
        async ({ generation, nowMs }: { generation: string; nowMs: number }) => ({
          protocol: "spatial_guardian_reservation/v1" as const,
          generation,
          claimVersion: 1,
          owner: { ...owner, claimVersion: 1, scopeKey: "prearm-scope", runId: "prearm-run" },
          scopeKey: "prearm-scope",
          runId: "prearm-run",
          guardianBuildDigest: identity.rendererBuildDigest,
          reservedAtMs: nowMs,
        }),
      );
      const onExitedBeforeSpawnIntent = vi.fn(async (receipt: { pid: number }) => {
        await waitForDead(receipt.pid);
      });
      const controller = new AbortController();
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: "fixture-no-chromium",
        referenceRenderHtmlPath: "/fixture/no-html",
        supervisor: fixture.supervisor,
        guardianWorkerUrl: fixtureUrl,
      });
      try {
        await expect(
          renderer.renderMissing?.(
            v2Dispatch(),
            controller.signal,
            [{ slot: "end_frame", ordinal: 0 }],
            {
              executionScope: { scopeKey: "prearm-scope", runId: "prearm-run" },
              guardianJournal: {
                stateDir: "/fixture/state",
                namespace: "prearm-namespace",
                identity,
                owner,
                guardianBuildDigest: identity.rendererBuildDigest,
                reserveGuardianLaunch: reserved,
                guardianFor: () => journalGuardian,
              },
              onGuardianLaunched: async (receipt) => {
                journalGuardian = {
                  protocol: "spatial_guardian/v1",
                  guardianId: `spatial-guardian:${owner.epoch}:${receipt.pid}`,
                  generation: receipt.generation,
                  pid: receipt.pid,
                  pidStartTimeMs: receipt.startTime,
                  guardianBuildDigest: identity.rendererBuildDigest,
                  armedAtMs: Date.now(),
                };
                controller.abort();
              },
              onGuardianExitedBeforeSpawnIntent: onExitedBeforeSpawnIntent,
            },
          ),
        ).rejects.toThrow("spatial_v2_cancelled_before_start");
        expect(reserved).toHaveBeenCalledOnce();
        expect(onExitedBeforeSpawnIntent).toHaveBeenCalledOnce();
      } finally {
        await fixture.shutdown();
      }
    });

    it("records the reserved Guardian identity when a real process exits before READY", async () => {
      const supervisor = createProcessSupervisor();
      const fixture = await createQualificationJournalFixture();
      let journalGuardian: SpatialReferenceJournalScopeGuardian | undefined;
      const launched = vi.fn(
        async (receipt: { pid: number; startTime: number; generation: string }) => {
          journalGuardian = {
            protocol: "spatial_guardian/v1",
            guardianId: `spatial-guardian:${fixture.owner.epoch}:${receipt.pid}`,
            generation: receipt.generation,
            pid: receipt.pid,
            pidStartTimeMs: receipt.startTime,
            guardianBuildDigest: fixture.identity.rendererBuildDigest,
            armedAtMs: Date.now(),
          };
          await fixture.journal.armScopeGuardian({
            identity: fixture.identity,
            owner: fixture.owner,
            guardian: journalGuardian,
            nowMs: Date.now(),
          });
        },
      );
      const exited = vi.fn(
        async (receipt: { pid: number; startTime: number; generation: string }) => {
          await waitForDead(receipt.pid);
          const guardian: SpatialReferenceJournalScopeGuardianProcessIdentity = {
            protocol: "spatial_guardian/v1",
            guardianId: `spatial-guardian:${fixture.owner.epoch}:${receipt.pid}`,
            generation: receipt.generation,
            pid: receipt.pid,
            pidStartTimeMs: receipt.startTime,
            guardianBuildDigest: fixture.identity.rendererBuildDigest,
          };
          await fixture.journal.recordPrearmGuardianExit({
            identity: fixture.identity,
            owner: fixture.owner,
            guardian,
            nowMs: Date.now(),
          });
        },
      );
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: "fixture-no-chromium",
        referenceRenderHtmlPath: "/fixture/no-html",
        supervisor,
        guardianWorkerUrl: preReadyExitFixtureUrl,
      });
      try {
        await expect(
          renderer.renderMissing?.(
            v2Dispatch(),
            new AbortController().signal,
            [{ slot: "end_frame", ordinal: 0 }],
            {
              executionScope: { scopeKey: fixture.scopeKey, runId: fixture.runId },
              guardianJournal: {
                stateDir: fixture.stateDir,
                namespace: "spatial-prearm-renderer-test",
                identity: fixture.identity,
                owner: fixture.owner,
                guardianBuildDigest: fixture.identity.rendererBuildDigest,
                reserveGuardianLaunch: ({ generation, nowMs }) =>
                  fixture.journal.reserveScopeGuardianLaunch({
                    identity: fixture.identity,
                    owner: fixture.owner,
                    generation,
                    guardianBuildDigest: fixture.identity.rendererBuildDigest,
                    nowMs,
                  }),
                guardianFor: (receipt) =>
                  journalGuardian?.pid === receipt.pid &&
                  journalGuardian.pidStartTimeMs === receipt.startTime &&
                  journalGuardian.generation === receipt.generation
                    ? journalGuardian
                    : undefined,
              },
              onGuardianLaunched: launched,
              onGuardianExitedBeforeSpawnIntent: exited,
              onSpawnIntent: vi.fn(),
            },
          ),
        ).rejects.toThrow("spatial_guardian_exited_before_ready");
        expect(launched).not.toHaveBeenCalled();
        expect(exited).toHaveBeenCalledOnce();
        const receipt = exited.mock.calls[0]?.[0];
        expect(receipt).toMatchObject({
          pid: expect.any(Number),
          startTime: expect.any(Number),
          generation: expect.any(String),
          scopeKey: fixture.scopeKey,
          runId: fixture.runId,
        });
        const row = await fixture.journal.get("@qualification");
        expect(row).toMatchObject({
          launchState: "guardian_reserved",
          prearmGuardianExitWitness: {
            protocol: "spatial_guardian_prearm_exit/v1",
            guardian: {
              pid: receipt!.pid,
              pidStartTimeMs: receipt!.startTime,
              generation: receipt!.generation,
            },
          },
        });
        expect(row).not.toHaveProperty("scopeRecovery");
        expect(row).not.toHaveProperty("worker");
      } finally {
        await supervisor.shutdown();
        closePluginStateDatabase();
        await rm(fixture.stateDir, { recursive: true, force: true });
      }
    });

    it("leaves only the reservation when a real Guardian PID receipt is unavailable", async () => {
      const owned = createProcessSupervisor();
      const fixture = await createQualificationJournalFixture();
      const supervisor: ProcessSupervisor = {
        acquireScopeCleanup: (scopeKey, options) => owned.acquireScopeCleanup(scopeKey, options),
        spawn: async (input: SpawnInput) => {
          const run = await owned.spawn(input);
          return { ...run, pid: undefined };
        },
        cancel: (runId, reason) => owned.cancel(runId, reason),
        cancelScope: (scopeKey, reason) => owned.cancelScope(scopeKey, reason),
      };
      const exited = vi.fn();
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: "fixture-no-chromium",
        referenceRenderHtmlPath: "/fixture/no-html",
        supervisor,
        guardianWorkerUrl: preReadyExitFixtureUrl,
      });
      try {
        await expect(
          renderer.renderMissing?.(
            v2Dispatch(),
            new AbortController().signal,
            [{ slot: "end_frame", ordinal: 0 }],
            {
              executionScope: { scopeKey: fixture.scopeKey, runId: fixture.runId },
              guardianJournal: {
                stateDir: fixture.stateDir,
                namespace: "spatial-prearm-renderer-test",
                identity: fixture.identity,
                owner: fixture.owner,
                guardianBuildDigest: fixture.identity.rendererBuildDigest,
                reserveGuardianLaunch: ({ generation, nowMs }) =>
                  fixture.journal.reserveScopeGuardianLaunch({
                    identity: fixture.identity,
                    owner: fixture.owner,
                    generation,
                    guardianBuildDigest: fixture.identity.rendererBuildDigest,
                    nowMs,
                  }),
                guardianFor: () => undefined,
              },
              onGuardianExitedBeforeSpawnIntent: exited,
            },
          ),
        ).rejects.toThrow("spatial_guardian_identity_unavailable");
        expect(exited).not.toHaveBeenCalled();
        const row = await fixture.journal.get("@qualification");
        expect(row).toMatchObject({ launchState: "guardian_reserved" });
        expect(row).not.toHaveProperty("prearmGuardianExitWitness");
      } finally {
        await owned.shutdown();
        closePluginStateDatabase();
        await rm(fixture.stateDir, { recursive: true, force: true });
      }
    });

    it("renders only a sparse plan through a real owned worker without relaying credentials", async () => {
      const audits: unknown[] = [];
      const fixture = fixtureSupervisor({ audits });
      const lifecycleOrder: string[] = [];
      const lifecycle = {
        onGuardianLaunched: vi.fn(async () => lifecycleOrder.push("armed")),
        onSpawnIntent: vi.fn(async () => lifecycleOrder.push("spawn_intent")),
        onLaunched: vi.fn(async () => lifecycleOrder.push("worker_prepared")),
        onStartAuthorized: vi.fn(async () => lifecycleOrder.push("start_authorized")),
        onScopeObservation: vi.fn(async () => lifecycleOrder.push("extinct")),
        onExited: vi.fn(async () => lifecycleOrder.push("worker_exited")),
      };
      const input = v2Dispatch();
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: "fixture-no-chromium",
        referenceRenderHtmlPath: "/fixture/no-html",
        supervisor: fixture.supervisor,
        guardianWorkerUrl: fixtureUrl,
      });
      const outputs = await renderer.renderMissing?.(
        input,
        new AbortController().signal,
        [{ slot: "end_frame", ordinal: 0 }],
        lifecycle,
      );
      expect(outputs).toEqual([{ slot: "end_frame", ordinal: 0, png: Buffer.from("end_frame:0") }]);
      expect(lifecycle.onLaunched).toHaveBeenCalledOnce();
      expect(lifecycle.onExited).toHaveBeenCalledOnce();
      expect(lifecycle.onGuardianLaunched).toHaveBeenCalledOnce();
      expect(lifecycle.onSpawnIntent).toHaveBeenCalledOnce();
      expect(lifecycle.onStartAuthorized).toHaveBeenCalledOnce();
      expect(lifecycle.onScopeObservation).toHaveBeenCalledOnce();
      expect(lifecycleOrder).toEqual([
        "armed",
        "spawn_intent",
        "worker_prepared",
        "start_authorized",
        "extinct",
        "worker_exited",
      ]);
      expect(lifecycle.onExited).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: expect.any(Number),
          startTime: expect.any(Number),
          scopeKey: expect.stringMatching(/^spatial-reference-v2:/),
        }),
        "completed",
      );
      const audit = JSON.stringify(
        audits.find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { type?: unknown }).type === "spatial-v2-test-audit",
        ),
      );
      for (const forbidden of [
        "upload-grant-1",
        "upload-grant-motion-1",
        "runtime-1",
        "ws-1",
        "controlApiBaseUrl",
        "callback",
        "token",
        "grantToken",
        "sourceGrants",
      ]) {
        expect(audit).not.toContain(forbidden);
      }
      expect(audit).toContain('"type":"openclaw-worker-start-v1"');
      await fixture.shutdown();
    });

    it("does not settle exit or remove recovery state when durable scope readback rejects", async () => {
      const fixture = fixtureSupervisor({ audits: [] });
      const onExited = vi.fn(async () => undefined);
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: "fixture-no-chromium",
        referenceRenderHtmlPath: "/fixture/no-html",
        supervisor: fixture.supervisor,
        guardianWorkerUrl: fixtureUrl,
      });
      await expect(
        renderer.renderMissing?.(
          v2Dispatch(),
          new AbortController().signal,
          [{ slot: "end_frame", ordinal: 0 }],
          {
            onScopeObservation: vi.fn(async () => {
              throw new Error("fixture_durable_readback_rejected");
            }),
            onExited,
          },
        ),
      ).rejects.toThrow("fixture_durable_readback_rejected");
      expect(onExited).not.toHaveBeenCalled();
      await fixture.shutdown();
    });

    it("delivers a toolchain proof only after the guardian authorizes its child", async () => {
      const fixture = fixtureSupervisor({ audits: [] });
      const lifecycleOrder: string[] = [];
      const lifecycle = {
        onGuardianLaunched: vi.fn(async () => lifecycleOrder.push("armed")),
        onSpawnIntent: vi.fn(async () => lifecycleOrder.push("spawn_intent")),
        onLaunched: vi.fn(async () => lifecycleOrder.push("worker_prepared")),
        onStartAuthorized: vi.fn(async () => lifecycleOrder.push("start_authorized")),
        onToolchainProof: vi.fn(async () => lifecycleOrder.push("toolchain_proof")),
        onScopeObservation: vi.fn(async () => lifecycleOrder.push("extinct")),
        onExited: vi.fn(async () => lifecycleOrder.push("worker_exited")),
      };
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: "fixture-no-chromium",
        referenceRenderHtmlPath: "/fixture/no-html",
        supervisor: fixture.supervisor,
        guardianWorkerUrl: fixtureUrl,
        collectToolchainProof: true,
      });
      await renderer.renderMissing?.(
        v2Dispatch(),
        new AbortController().signal,
        [{ slot: "end_frame", ordinal: 0 }],
        lifecycle,
      );
      expect(lifecycle.onToolchainProof).toHaveBeenCalledWith(
        expect.objectContaining({
          chromiumVersion: "fixture-chromium",
          ffmpegSha256: "a".repeat(64),
        }),
      );
      expect(lifecycleOrder).toEqual([
        "armed",
        "spawn_intent",
        "worker_prepared",
        "start_authorized",
        "toolchain_proof",
        "extinct",
        "worker_exited",
      ]);
      await fixture.shutdown();
    });

    it("rejects a frozen digest mismatch before it asks the supervisor to spawn a worker", async () => {
      const fixture = fixtureSupervisor({ audits: [] });
      const spawn = vi.fn(fixture.supervisor.spawn);
      const manifestInput = {
        referenceRenderHtmlPath: buildReferenceHtml,
        chromiumExecutablePath: process.execPath,
        toolchain: buildToolchain,
      };
      const manifest = await buildSpatialReferenceV2Manifest({
        ...manifestInput,
        rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      });
      const input = v2Dispatch();
      input.renderIntent.rendererBuildDigest = "sha256:frozen-drift";
      const renderer = createSpatialReferenceV2Renderer({
        chromiumExecutablePath: process.execPath,
        referenceRenderHtmlPath: buildReferenceHtml,
        supervisor: { ...fixture.supervisor, spawn },
        buildIdentity: {
          advertisedDigest: spatialReferenceV2BuildDigest(manifest),
          manifestInput,
          readHostAvailableBytes: () => 4 * 1024 * 1024 * 1024,
        },
      });
      await expect(
        renderer.renderMissing?.(input, new AbortController().signal, [
          { slot: "end_frame", ordinal: 0 },
        ]),
      ).rejects.toThrow("spatial_v2_renderer_build_mismatch");
      expect(spawn).not.toHaveBeenCalled();
      await fixture.shutdown();
    });
  },
);
