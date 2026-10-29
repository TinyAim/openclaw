import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.js";
import { createSpatialReferenceJournal } from "./reference-journal.js";
import { validateSpatialReferenceV2RssLimitDiagnostic } from "./v2-rss-limit-diagnostic.js";

const detail = {
  source: "spatial_rss_limit/v1" as const,
  metric: "darwin_libproc_tree_rss_span_v1" as const,
  rootPid: 50,
  observerPid: 51,
  nodeCount: 3,
  verifiedSpanMs: 1,
  capBytes: 2147483648,
  observedBytes: 2147483649,
  peakBytes: 2147483649,
  observedAtMs: 5,
  phase: "periodic" as const,
  renderStage: "frame_render",
  frameIndex: 42,
};
const directories: string[] = [];
afterEach(async () => {
  closePluginStateDatabase();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("private RSS limit evidence", () => {
  it("accepts only exact scalar Darwin and Linux versions", () => {
    expect(validateSpatialReferenceV2RssLimitDiagnostic(detail)).toEqual(detail);
    expect(Object.isFrozen(validateSpatialReferenceV2RssLimitDiagnostic(detail))).toBe(true);
    expect(
      validateSpatialReferenceV2RssLimitDiagnostic({
        ...detail,
        metric: "linux_proc_status_tree_rss_sum_v1",
        observerPid: null,
        nodeCount: null,
        verifiedSpanMs: null,
      }),
    ).toBeDefined();
  });

  it.each([
    { argv: ["private"] },
    { path: "/private" },
    { source: "spatial_rss_limit/v2" },
    { rootPid: 0 },
    { observerPid: 50 },
    { observerPid: null },
    { nodeCount: 1 },
    { verifiedSpanMs: 3000 },
    { capBytes: -1 },
    { observedBytes: 2147483648 },
    { peakBytes: 2147483648 },
    { observedBytes: Infinity },
    { observedAtMs: NaN },
    { frameIndex: 360 },
    { renderStage: "raw private text" },
    { phase: "raw" },
    { metric: "unknown" },
    { peakBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unknown or inconsistent fields %j", (override) => {
    expect(
      validateSpatialReferenceV2RssLimitDiagnostic({ ...detail, ...override }),
    ).toBeUndefined();
  });

  it.each(["extinct", "unknown"] as const)(
    "persists exact @qualification %s metrics across cleanup/reopen without granting admission",
    async (state) => {
      const directory = await mkdtemp(path.join(tmpdir(), "spatial-rss-diagnostic-"));
      directories.push(directory);
      const env = { OPENCLAW_STATE_DIR: directory };
      const namespace = "rss-diagnostic-qualification";
      const journal = createSpatialReferenceJournal({ env, namespace });
      const owner = {
        epoch: "rss-epoch",
        pid: 10,
        pidStartTimeMs: 20,
        ownerInstanceId: "rss-owner",
      };
      const scopeKey = "rss-qualification-scope",
        runId = "rss-qualification-run";
      const claimed = await journal.claimExclusiveAdmission({
        owner,
        runtimeId: "rss-runtime",
        nowMs: 1,
        leaseExpiresAtMs: 100,
        scopeKey,
        runId,
      });
      expect(claimed.claimed).toBe(true);
      if (!claimed.claimed) throw new Error("fixture claim refused");
      const identity = claimed.identity;
      const guardian = {
        protocol: "spatial_guardian/v1" as const,
        guardianId: "rss-guardian",
        generation: "rss-generation",
        pid: 30,
        pidStartTimeMs: 40,
        guardianBuildDigest: "rss-build",
        armedAtMs: 1,
      };
      const worker = {
        pid: 50,
        startTime: 60,
        scopeId: scopeKey,
        runId,
        workerTokenDigest: "a".repeat(64),
      };
      await journal.reserveScopeGuardianLaunch({
        identity,
        owner,
        nowMs: 1,
        generation: guardian.generation,
        guardianBuildDigest: guardian.guardianBuildDigest,
      });
      await journal.armScopeGuardian({ identity, owner, guardian, nowMs: 1 });
      await journal.recordSpawnIntent({ identity, owner, guardian, nowMs: 2 });
      await journal.recordWorkerPrepared({ identity, owner, guardian, worker, nowMs: 3 });
      await journal.authorizeWorkerStart({ identity, owner, guardian, worker, nowMs: 4 });
      const common = { identity, owner, guardian, nowMs: 5 };
      const input = {
        ...common,
        observation: {
          state,
          observedAtMs: 5,
          worker: { ...worker, failureDetails: detail },
          ...(state === "extinct"
            ? {
                proof: {
                  protocol: "posix_group_observation_v1" as const,
                  processGroupId: worker.pid,
                  rootState: "dead" as const,
                },
              }
            : { reason: "scope_observation_unknown" as const }),
        },
      };
      const before = await journal.get(identity.key);
      await expect(
        journal.recordScopeObservation({
          ...input,
          observation: {
            ...input.observation,
            worker: { ...worker, failureDetails: { ...detail, rootPid: 999 } },
          },
        }),
      ).rejects.toThrow("JOURNAL_SCOPE_FAILURE_DETAILS_INVALID");
      expect(await journal.get(identity.key)).toEqual(before);
      await journal.recordScopeObservation(input);
      await expect(
        journal.recordScopeObservation({
          ...input,
          observation: {
            ...input.observation,
            worker: { ...worker, failureDetails: { ...detail, observedAtMs: 6 } },
          },
        }),
      ).rejects.toThrow("JOURNAL_SCOPE_FAILURE_DETAILS_INVALID");
      await journal.checkpoint({
        identity,
        owner,
        nowMs: 6,
        phase: "worker_exited",
        worker: { ...worker, exited: { atMs: 6, reason: "dead" } },
      });
      await expect(
        journal.releaseExclusiveAdmission({
          owner,
          nowMs: 7,
          spawned: true,
          scopeEvidence: state === "extinct" ? "extinct" : "never_spawned",
        }),
      ).resolves.toMatchObject({ released: state === "extinct" });
      closePluginStateDatabase();
      const reopened = createSpatialReferenceJournal({ env, namespace });
      expect((await reopened.get(identity.key))?.scopeRecovery?.worker?.failureDetails).toEqual(
        detail,
      );
      expect((await reopened.get(identity.key))?.callback).toBeUndefined();
      expect((await reopened.get(identity.key))?.renderProof).toBeUndefined();
      await expect(reopened.getRuntimeAdmission()).resolves.toMatchObject({
        state: state === "extinct" ? "released" : "quarantined",
      });
    },
  );
});
