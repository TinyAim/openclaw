import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.js";
import { createCorePluginStateSyncKeyedStore } from "../../plugin-state/plugin-state-store.js";
import type { SpatialReferenceRelayDispatchAck } from "../media-studio-spatial-reference-render-http.js";
import type { SpatialReferenceTerminalCallback } from "./reference-callback.js";
import {
  createSpatialReferenceJournal,
  type SpatialReferenceExpectedOutput,
  type SpatialReferenceJournalIdentity,
  type SpatialReferenceJournalOwner,
} from "./reference-journal.js";

const digest = "a".repeat(64);
const ack: SpatialReferenceRelayDispatchAck = {
  ok: true,
  accepted: true,
  deferredSettlement: true,
  runtimeId: "runtime-test",
  executionId: "execution-test",
  taskId: "task-test",
  materializationId: "materialization-test",
  attempt: 1,
  dispatchAttemptId: "dispatch-test",
  sequence: 1,
  leaseExpiresAt: "2099-01-01T00:00:00Z",
  intentFingerprint: "intent-test",
  executionFingerprint: "fingerprint-test",
  blueprintDigest: "blueprint-test",
};
const identity: SpatialReferenceJournalIdentity = {
  key: "key-test",
  runtimeIdempotencyKey: "key-test",
  runtimeId: ack.runtimeId,
  executionId: ack.executionId,
  workspaceId: "workspace-test",
  taskId: ack.taskId,
  materializationId: ack.materializationId,
  dispatchAttemptId: ack.dispatchAttemptId,
  sequence: ack.sequence,
  attempt: ack.attempt,
  intentFingerprint: ack.intentFingerprint,
  executionFingerprint: ack.executionFingerprint,
  blueprintDigest: ack.blueprintDigest,
  contractVersion: "spatial_reference_render/v2",
  rendererBuildDigest: "renderer-test",
  frozenDispatchDigest: digest,
};
const expected: SpatialReferenceExpectedOutput[] = [
  {
    slot: "composition_frame",
    ordinal: 0,
    artifactId: "artifact-test",
    expectedMimeType: "image/png",
  },
];
const owner: SpatialReferenceJournalOwner = {
  epoch: "epoch-test",
  pid: 10,
  pidStartTimeMs: 20,
  ownerInstanceId: "instance-test",
};
const guardian = {
  protocol: "spatial_guardian/v1" as const,
  guardianId: "guardian-test",
  generation: "guardian-generation-test",
  pid: 11,
  pidStartTimeMs: 21,
  guardianBuildDigest: identity.rendererBuildDigest,
  armedAtMs: 1,
};
const dirs: string[] = [];

afterEach(async () => {
  closePluginStateDatabase();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function state() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "spatial-journal-test-"));
  dirs.push(stateDir);
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

function journal(env: NodeJS.ProcessEnv, legacyFilePath?: string) {
  return createSpatialReferenceJournal({
    env,
    namespace: "spatial-reference-journal-test",
    ...(legacyFilePath ? { legacyFilePath } : {}),
  });
}

function successCallback(storageKey: string): SpatialReferenceTerminalCallback {
  return {
    kind: "media_studio.spatial_reference_render.callback",
    workspaceId: identity.workspaceId,
    runtimeId: identity.runtimeId,
    taskId: identity.taskId,
    materializationId: identity.materializationId,
    executionId: identity.executionId,
    attempt: identity.attempt,
    dispatchAttemptId: identity.dispatchAttemptId,
    sequence: identity.sequence,
    intentFingerprint: identity.intentFingerprint,
    executionFingerprint: identity.executionFingerprint,
    status: "succeeded",
    receipt: {
      artifactId: expected[0].artifactId,
      storageKey,
      mimeType: "image/png",
      byteLength: 1,
      sha256Hex: digest,
      pixelDigest: digest,
      width: 1,
      height: 1,
      profile: "proxy_previs",
      rendererContractVersion: "spatial_reference_render/v2",
      rendererBuildDigest: identity.rendererBuildDigest,
      usedProxySilhouettes: false,
    },
  };
}

function preparedCallback(): SpatialReferenceTerminalCallback {
  const callback = successCallback("");
  delete (callback.receipt as { storageKey?: string }).storageKey;
  return callback;
}

async function acceptTyped(env: NodeJS.ProcessEnv) {
  const value = journal(env);
  await value.accept("key-test", ack, "request-digest", { identity, expectedOutputs: expected });
  return value;
}

describe("Spatial reference SQLite execution journal", () => {
  it("commits the lock and execution claim as one real SQLite pair across reopen", async () => {
    const env = await state();
    const first = await acceptTyped(env);
    const contender = { ...owner, epoch: "epoch-contender", ownerInstanceId: "instance-contender" };
    const [left, right] = await Promise.all([
      first.claim({
        identity,
        owner,
        expectedOutputs: expected,
        nowMs: 1,
        leaseExpiresAtMs: 2,
        scopeKey: "scope-owner",
        runId: "run-owner",
      }),
      first.claim({
        identity,
        owner: contender,
        expectedOutputs: expected,
        nowMs: 1,
        leaseExpiresAtMs: 2,
        scopeKey: "scope-contender",
        runId: "run-contender",
      }),
    ]);
    expect([left, right].filter((result) => result.claimed)).toHaveLength(1);
    expect([left, right].find((result) => !result.claimed)).toMatchObject({
      reason: "active_owner",
    });

    closePluginStateDatabase();
    const reopened = journal(env);
    await expect(reopened.getRuntimeAdmission()).resolves.toMatchObject({
      state: "owned",
      executionKey: identity.key,
    });
    const stored = await reopened.get(identity.key);
    expect(stored?.claim?.scopeKey).toBe("scope-owner");
    expect(stored?.claim?.runId).toBe("run-owner");
  });

  it("keeps an unproven release durably quarantined after close/reopen", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "scope-test",
      runId: "run-test",
    });
    await value.armScopeGuardian({ identity, owner, nowMs: 1, guardian });
    await value.release({ identity, owner, nowMs: 3 });

    closePluginStateDatabase();
    const reopened = journal(env);
    await expect(reopened.getRuntimeAdmission()).resolves.toMatchObject({ state: "quarantined" });
    await expect(reopened.get(identity.key)).resolves.toMatchObject({
      phase: "terminal",
      callback: { status: "failed", errorCode: "spatial_scope_stop_unconfirmed" },
    });
    await expect(
      reopened.claim({
        identity,
        owner: { ...owner, epoch: "new-epoch" },
        expectedOutputs: expected,
        nowMs: 4,
        leaseExpiresAtMs: 5,
      }),
    ).resolves.toMatchObject({ claimed: false, reason: "terminal" });
  });

  it("records an unsafe terminal attempt as failed and keeps its owner pair quarantined", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "scope-test",
      runId: "run-test",
    });

    await expect(
      value.finish(identity.key, successCallback("artifacts/test"), {
        identity,
        owner,
        nowMs: 3,
      }),
    ).resolves.toMatchObject({ status: "failed", errorCode: "spatial_scope_stop_unconfirmed" });
    await expect(value.getRuntimeAdmission()).resolves.toMatchObject({
      state: "quarantined",
      scope: "exact",
    });
    await expect(value.get(identity.key)).resolves.toMatchObject({
      phase: "terminal",
      callback: { status: "failed" },
    });
  });

  it("quarantines a literal V2 owner pair instead of fabricating a scope or reclaiming it", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    const raw = createCorePluginStateSyncKeyedStore<unknown>({
      ownerId: "core:media-studio-spatial-reference-runtime",
      namespace: "spatial-reference-journal-test",
      maxEntries: 512,
      overflowPolicy: "reject-new",
      env,
    });
    const v2Row = {
      ...(await value.get(identity.key))!,
      schemaVersion: 2,
      claim: {
        ...owner,
        leaseExpiresAtMs: 0,
      },
    };
    raw.transaction(["@runtime-lock", identity.key], (transaction) => {
      transaction.set("@runtime-lock", {
        recordType: "runtime_lock",
        schemaVersion: 2,
        runtimeId: identity.runtimeId,
        executionKey: identity.key,
        owner,
      });
      transaction.set(identity.key, v2Row);
    });

    await expect(
      value.claim({
        identity,
        owner: { ...owner, epoch: "epoch-new" },
        expectedOutputs: expected,
        nowMs: 10,
        leaseExpiresAtMs: 11,
      }),
    ).resolves.toMatchObject({ claimed: false, reason: "runtime_quarantined" });
    await expect(value.getRuntimeAdmission()).resolves.toMatchObject({
      state: "quarantined",
      scope: "unavailable",
    });
    expect((await value.get(identity.key))?.phase).toBe("legacy_reconciling");
  });

  it("rejects a throwing, async, or over-capacity trusted-core two-key mutation without partial SQLite writes", async () => {
    const env = await state();
    const core = createCorePluginStateSyncKeyedStore<{ value: number }>({
      ownerId: "core:spatial-journal-transaction-test",
      namespace: "transaction-test",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    expect(() =>
      core.transaction(["a", "b"], (transaction) => {
        transaction.set("a", { value: 1 });
        transaction.set("b", { value: 2 });
      }),
    ).toThrow("reached its 1-row limit");
    expect(core.lookup("a")).toBeUndefined();
    expect(core.lookup("b")).toBeUndefined();
    expect(() =>
      core.transaction(["a", "b"], (transaction) => {
        transaction.set("a", { value: 1 });
        throw new Error("mutator-abort");
      }),
    ).toThrow("Failed to transactionally update plugin state entries.");
    expect(core.lookup("a")).toBeUndefined();
    expect(() =>
      (core.transaction as unknown as (keys: string[], mutate: () => unknown) => unknown)(
        ["a"],
        () => Promise.resolve(),
      ),
    ).toThrow("synchronous mutator");
  });

  it("persists a frozen identity and expected outputs before exposing the ACK", async () => {
    const env = await state();
    const first = await acceptTyped(env);
    expect((await first.get(identity.key))?.identity).toEqual(identity);
    expect((await first.get(identity.key))?.expectedOutputs).toEqual(expected);

    closePluginStateDatabase();
    const reopened = journal(env);
    expect(
      (
        await reopened.accept("key-test", ack, "request-digest", {
          identity,
          expectedOutputs: expected,
        })
      ).replay,
    ).toBe(true);
    await expect(
      reopened.accept("key-test", ack, "request-digest", {
        identity: { ...identity, frozenDispatchDigest: "b".repeat(64) },
        expectedOutputs: expected,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });

  it("does not let lease expiry alone replace an owner or start a second runtime job", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    expect(
      (
        await value.claim({
          identity,
          owner,
          expectedOutputs: expected,
          nowMs: 1,
          leaseExpiresAtMs: 2,
        })
      ).claimed,
    ).toBe(true);
    const contender = await value.claim({
      identity,
      owner: { ...owner, epoch: "epoch-contender", ownerInstanceId: "instance-contender" },
      expectedOutputs: expected,
      nowMs: 9_999,
      leaseExpiresAtMs: 10_000,
    });
    expect(contender).toMatchObject({ claimed: false, reason: "active_owner" });
  });

  it("persists the private guardian sequence once and rejects stale identities or never-spawned after intent", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "scope-test",
      runId: "run-test",
    });
    await value.armScopeGuardian({ identity, owner, nowMs: 1, guardian });
    await value.recordSpawnIntent({ identity, owner, nowMs: 2, guardian });
    await expect(
      value.recordScopeObservation({
        identity,
        owner,
        nowMs: 2,
        guardian,
        observation: { state: "never_spawned", observedAtMs: 2 },
      }),
    ).rejects.toThrow("JOURNAL_SCOPE_OBSERVATION_INVALID");

    const worker = {
      pid: 50,
      startTime: 51,
      scopeId: "scope-test",
      runId: "run-test",
      workerTokenDigest: digest,
    };
    await expect(
      value.recordWorkerPrepared({
        identity,
        owner,
        nowMs: 3,
        guardian: { ...guardian, generation: "stale-generation" },
        worker,
      }),
    ).rejects.toThrow("JOURNAL_GUARDIAN_WORKER_PREPARED_INVALID");
    await value.recordWorkerPrepared({ identity, owner, nowMs: 3, guardian, worker });
    await value.recordWorkerPrepared({ identity, owner, nowMs: 4, guardian, worker });
    await value.authorizeWorkerStart({ identity, owner, nowMs: 4, guardian, worker });
    await value.authorizeWorkerStart({ identity, owner, nowMs: 5, guardian, worker });
    await expect(value.get(identity.key)).resolves.toMatchObject({
      launchState: "start_authorized",
      worker: { pid: 50, startTime: 51, scopeId: "scope-test", runId: "run-test" },
    });
  });

  it("keeps a cancel fence through a stop-only claim, then records the actual cancelled terminal", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "scope-test",
      runId: "run-test",
    });
    await value.armScopeGuardian({ identity, owner, nowMs: 1, guardian });
    const activeWorker = {
      pid: 10,
      startTime: 20,
      scopeId: "scope-test",
      runId: "run-test",
      workerTokenDigest: digest,
    };
    await value.recordSpawnIntent({ identity, owner, nowMs: 1, guardian });
    await value.recordWorkerPrepared({ identity, owner, nowMs: 1, guardian, worker: activeWorker });
    await value.authorizeWorkerStart({ identity, owner, nowMs: 1, guardian, worker: activeWorker });
    await value.cancel(identity.key, identity.dispatchAttemptId);
    const stopOwner = { ...owner, epoch: "epoch-stop" };
    const blocked = await value.claim({
      identity,
      owner: stopOwner,
      expectedOutputs: expected,
      nowMs: 3,
      leaseExpiresAtMs: 4,
    });
    expect(blocked).toMatchObject({ claimed: false, reason: "cancelled" });
    const stopped = await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 3,
      leaseExpiresAtMs: 4,
      mode: "stop_only",
    });
    expect(stopped.claimed).toBe(true);
    await value.checkpoint({
      identity,
      owner,
      nowMs: 3,
      phase: "worker_exited",
      worker: {
        pid: 10,
        startTime: 20,
        scopeId: "scope-test",
        workerTokenDigest: digest,
        exited: { atMs: 3, reason: "cancelled" },
      },
    });
    await value.recordScopeObservation({
      identity,
      owner,
      nowMs: 3,
      guardian,
      observation: {
        state: "extinct",
        observedAtMs: 3,
        worker: { pid: 10, startTime: 20, scopeId: "scope-test", runId: "run-test" },
        proof: {
          protocol: "windows_job_v1",
          jobIncarnationId: "job-test",
          activeProcessCount: 0,
          workerPid: 10,
          workerStartTime: 20,
        },
      },
    });
    await expect(
      value.finish(
        identity.key,
        { ...successCallback("storage-test"), status: "cancelled" },
        {
          identity,
          owner,
          nowMs: 3,
          scopeEvidence: "extinct",
        },
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("only terminalizes a success after every prepared output has a finalized storage receipt", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
    });
    await value.checkpoint({
      identity,
      owner,
      nowMs: 1,
      phase: "prepared",
      prepared: {
        callback: preparedCallback(),
        outputs: [
          {
            slot: "composition_frame",
            ordinal: 0,
            artifactId: "artifact-test",
            size: 1,
            sha256Hex: digest,
            mimeType: "image/png",
          },
        ],
      },
    });
    await expect(
      value.finish(identity.key, successCallback("storage-test"), {
        identity,
        owner,
        nowMs: 1,
        scopeEvidence: "never_spawned",
      }),
    ).rejects.toThrow("TERMINAL_OUTPUTS_INCOMPLETE");
    await value.checkpoint({
      identity,
      owner,
      nowMs: 1,
      phase: "output_finalized",
      finalizedOutput: {
        slot: "composition_frame",
        ordinal: 0,
        artifactId: "artifact-test",
        size: 1,
        sha256Hex: digest,
        mimeType: "image/png",
        storageKey: "storage-test",
      },
    });
    await expect(
      value.finish(identity.key, successCallback("storage-test"), {
        identity,
        owner,
        nowMs: 1,
        scopeEvidence: "never_spawned",
      }),
    ).resolves.toEqual(successCallback("storage-test"));
  });

  it("commits exclusive qualification admission and never-spawned release across reopen", async () => {
    const env = await state();
    const value = journal(env);
    const claimed = await value.claimExclusiveAdmission({
      owner,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "qual-scope",
      runId: "qual-run",
      runtimeId: identity.runtimeId,
    });
    expect(claimed).toMatchObject({ claimed: true, executionKey: "@qualification" });
    if (claimed.claimed) {
      expect(claimed.owner.scopeKey).toBe("qual-scope");
      expect(claimed.owner.runId).toBe("qual-run");
    }
    await expect(value.getRuntimeAdmission()).resolves.toMatchObject({
      state: "owned",
      executionKey: "@qualification",
    });
    await expect(
      value.releaseExclusiveAdmission({
        owner,
        nowMs: 3,
        scopeEvidence: "never_spawned",
        spawned: false,
      }),
    ).resolves.toMatchObject({ released: true });

    closePluginStateDatabase();
    const reopened = journal(env);
    await expect(reopened.getRuntimeAdmission()).resolves.toMatchObject({ state: "released" });
    await expect(
      reopened.claimExclusiveAdmission({
        owner: { ...owner, epoch: "epoch-next" },
        nowMs: 4,
        leaseExpiresAtMs: 5,
        scopeKey: "qual-scope-next",
        runId: "qual-run-next",
        runtimeId: identity.runtimeId,
      }),
    ).resolves.toMatchObject({
      claimed: true,
      executionKey: "@qualification",
      owner: { claimVersion: 2 },
    });
  });

  it("rejects Gateway self-attestation and keeps an armed no-checkpoint scope fenced across reopen", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "scope-test",
      runId: "run-test",
    });
    const selfGuardian = { ...guardian, pid: owner.pid, pidStartTimeMs: owner.pidStartTimeMs };
    await expect(
      value.armScopeGuardian({ identity, owner, nowMs: 1, guardian: selfGuardian }),
    ).rejects.toThrow("JOURNAL_SCOPE_GUARDIAN_INVALID");
  });

  it("rejects root-only extinction reported by the Gateway itself", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "scope-test",
      runId: "run-test",
    });
    const selfGuardian = { ...guardian, pid: owner.pid, pidStartTimeMs: owner.pidStartTimeMs };
    await expect(
      value.armScopeGuardian({ identity, owner, nowMs: 1, guardian: selfGuardian }),
    ).rejects.toThrow("JOURNAL_SCOPE_GUARDIAN_INVALID");
  });

  it("accepts an exact POSIX process-group extinction proof for safe release", async () => {
    const env = await state();
    const value = await acceptTyped(env);
    const worker = {
      pid: 50,
      startTime: 51,
      scopeId: "scope-test",
      runId: "run-test",
      workerTokenDigest: digest,
    };
    await value.claim({
      identity,
      owner,
      expectedOutputs: expected,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "scope-test",
      runId: "run-test",
    });
    await value.armScopeGuardian({ identity, owner, nowMs: 1, guardian });
    await value.recordSpawnIntent({ identity, owner, nowMs: 2, guardian });
    await value.recordWorkerPrepared({ identity, owner, nowMs: 2, guardian, worker });
    await value.authorizeWorkerStart({ identity, owner, nowMs: 3, guardian, worker });
    await value.checkpoint({
      identity,
      owner,
      nowMs: 4,
      phase: "worker_started",
      worker,
    });
    const exitedWorker = {
      ...worker,
      exited: { atMs: 5, reason: "completed" as const },
    };
    await value.checkpoint({
      identity,
      owner,
      nowMs: 5,
      phase: "worker_exited",
      worker: exitedWorker,
    });
    await value.recordScopeObservation({
      identity,
      owner,
      nowMs: 6,
      guardian,
      observation: {
        state: "extinct",
        observedAtMs: 6,
        worker,
        proof: {
          protocol: "posix_group_observation_v1",
          processGroupId: worker.pid,
          rootState: "dead",
        },
      },
    });
    await expect(
      value.release({ identity, owner, nowMs: 7, scopeEvidence: "extinct", worker: exitedWorker }),
    ).resolves.toMatchObject({ worker: exitedWorker });
    await expect(value.getRuntimeAdmission()).resolves.toMatchObject({ state: "released" });
  });

  it("refuses never-spawned exclusive release after a probe/worker spawn and keeps the pair quarantined", async () => {
    const env = await state();
    const value = journal(env);
    await value.claimExclusiveAdmission({
      owner,
      nowMs: 1,
      leaseExpiresAtMs: 2,
      scopeKey: "qual-scope",
      runId: "qual-run",
      runtimeId: identity.runtimeId,
    });
    await expect(
      value.releaseExclusiveAdmission({
        owner,
        nowMs: 3,
        scopeEvidence: "never_spawned",
        spawned: true,
      }),
    ).resolves.toMatchObject({ released: false, quarantined: true });
    await expect(value.getRuntimeAdmission()).resolves.toMatchObject({ state: "quarantined" });

    closePluginStateDatabase();
    const reopened = journal(env);
    await expect(reopened.getRuntimeAdmission()).resolves.toMatchObject({ state: "quarantined" });
    await expect(
      reopened.claimExclusiveAdmission({
        owner: { ...owner, epoch: "epoch-next" },
        nowMs: 4,
        leaseExpiresAtMs: 5,
        scopeKey: "qual-scope-next",
        runId: "qual-run-next",
        runtimeId: identity.runtimeId,
      }),
    ).resolves.toMatchObject({ claimed: false, reason: "runtime_quarantined" });
  });

  it("imports a strictly valid v1 file once, reads it back, and archives it instead of dual-reading", async () => {
    const env = await state();
    const legacyPath = path.join(env.OPENCLAW_STATE_DIR!, "reference-journal.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        rows: [
          { key: "legacy-key", dispatchAttemptId: ack.dispatchAttemptId, cancelled: false, ack },
        ],
      }),
    );
    const value = journal(env, legacyPath);
    expect((await value.get("legacy-key"))?.phase).toBe("legacy_nonresumable");
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${legacyPath}.spatial-reference-journal.v1-archived`, "utf8")).toContain(
      "legacy-key",
    );
  });
});
