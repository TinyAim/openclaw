import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  findOperatorSubagentAcceptedTombstone,
  OPERATOR_SUBAGENT_SPAWN_CAPABILITY,
  runIdempotentOperatorSubagentSpawn,
} from "./subagent-spawn-ledger.js";

describe("operator subagent spawn ledger", () => {
  let stateDir = "";
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-spawn-ledger-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    __testing.resetInflight();
  });

  afterEach(() => {
    __testing.resetInflight();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("replays the exact accepted result without spawning twice", async () => {
    const idempotencyKey = "workflow:run-a:writer:1";
    const request = {
      idempotencyKey,
      requesterSessionKey: "agent:main:main",
      task: "review the diff",
    };
    const spawn = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:reviewer:subagent:child-1",
      runId: "run-child-1",
      mode: "run",
    });

    const first = await runIdempotentOperatorSubagentSpawn({
      idempotencyKey,
      request,
      spawn,
    });
    const replay = await runIdempotentOperatorSubagentSpawn({
      idempotencyKey,
      request,
      spawn,
    });

    expect(replay).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(fs.readFileSync(__testing.ledgerPath(), "utf8"));
    expect(persisted).toMatchObject({
      version: 1,
    });
    const entry = Object.values(persisted.entries as Record<string, unknown>)[0];
    expect(entry).toMatchObject({
      requesterScopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      acceptedTombstone: {
        runId: "run-child-1",
        childSessionKey: "agent:reviewer:subagent:child-1",
        acceptedAt: expect.any(Number),
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("agent:main:main");
    await expect(
      findOperatorSubagentAcceptedTombstone({
        requesterSessionKey: "agent:main:main",
        runId: "run-child-1",
      }),
    ).resolves.toMatchObject({
      runId: "run-child-1",
      childSessionKey: "agent:reviewer:subagent:child-1",
    });
    await expect(
      findOperatorSubagentAcceptedTombstone({
        requesterSessionKey: "agent:other:main",
        runId: "run-child-1",
      }),
    ).resolves.toBeUndefined();
    expect(
      fs.readdirSync(path.dirname(__testing.ledgerPath())).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("rejects the same key with a different request fingerprint", async () => {
    const idempotencyKey = "workflow:run-b:writer:1";
    const spawn = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:reviewer:subagent:child-2",
      runId: "run-child-2",
      mode: "run",
    });
    const base = {
      idempotencyKey,
      requesterSessionKey: "agent:main:main",
      task: "review version one",
    };
    await runIdempotentOperatorSubagentSpawn({
      idempotencyKey,
      request: base,
      spawn,
    });

    const conflict = await runIdempotentOperatorSubagentSpawn({
      idempotencyKey,
      request: { ...base, task: "review a different version" },
      spawn,
    });

    expect(conflict).toMatchObject({ status: "idempotency_conflict" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("backfills the scoped tombstone when replaying a legacy accepted entry", async () => {
    const idempotencyKey = "workflow:run-legacy:writer:1";
    const request = {
      idempotencyKey,
      requesterSessionKey: "agent:main:main",
      task: "reconcile a legacy acceptance",
    };
    const spawn = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:reviewer:subagent:legacy-child",
      runId: "run-legacy-child",
      mode: "run",
    });
    await runIdempotentOperatorSubagentSpawn({ idempotencyKey, request, spawn });
    const persisted = JSON.parse(fs.readFileSync(__testing.ledgerPath(), "utf8")) as {
      entries: Record<string, { requesterScopeHash?: string; acceptedTombstone?: unknown }>;
    };
    const entry = Object.values(persisted.entries)[0];
    delete entry?.requesterScopeHash;
    delete entry?.acceptedTombstone;
    fs.writeFileSync(__testing.ledgerPath(), JSON.stringify(persisted), "utf8");

    const replay = await runIdempotentOperatorSubagentSpawn({ idempotencyKey, request, spawn });

    expect(replay).toMatchObject({ status: "accepted", runId: "run-legacy-child" });
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(
      findOperatorSubagentAcceptedTombstone({
        requesterSessionKey: "agent:main:main",
        runId: "run-legacy-child",
      }),
    ).resolves.toMatchObject({ childSessionKey: "agent:reviewer:subagent:legacy-child" });
  });

  it("turns a crash-left prepared claim into outcome_unknown without replay", async () => {
    const idempotencyKey = "workflow:run-c:writer:1";
    const request = {
      idempotencyKey,
      requesterSessionKey: "agent:main:main",
      task: "review after restart",
    };
    await __testing.seedPrepared({ idempotencyKey, request });
    const spawn = vi.fn();

    const result = await runIdempotentOperatorSubagentSpawn({
      idempotencyKey,
      request,
      spawn,
    });

    expect(result).toMatchObject({ status: "outcome_unknown" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never records accepted without exact run and child-session references", async () => {
    const idempotencyKey = "workflow:run-missing-ref:writer:1";
    const request = {
      idempotencyKey,
      requesterSessionKey: "agent:main:main",
      task: "review without refs",
    };
    const result = await runIdempotentOperatorSubagentSpawn({
      idempotencyKey,
      request,
      spawn: vi.fn().mockResolvedValue({ status: "accepted", runId: "run-without-child" }),
    });

    expect(result).toMatchObject({ status: "outcome_unknown", runId: "run-without-child" });
    await expect(
      findOperatorSubagentAcceptedTombstone({
        requesterSessionKey: "agent:main:main",
        runId: "run-without-child",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the durable ledger is corrupt", async () => {
    const ledgerPath = __testing.ledgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, "{not-json", "utf8");
    const spawn = vi.fn();

    await expect(
      runIdempotentOperatorSubagentSpawn({
        idempotencyKey: "workflow:run-d:writer:1",
        request: {
          idempotencyKey: "workflow:run-d:writer:1",
          requesterSessionKey: "agent:main:main",
          task: "must not dispatch",
        },
        spawn,
      }),
    ).rejects.toThrow(/ledger is unreadable/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("separates acceptance retention from exact runtime status durability", () => {
    expect(OPERATOR_SUBAGENT_SPAWN_CAPABILITY).toMatchObject({
      schemaVersion: "openclaw-subagent-spawn-capability/v3",
      durablePrepare: true,
      durableIdempotency: true,
      exactStatusQuery: true,
      statusMethod: "subagents.get",
      statusDurability: "registry_with_accepted_tombstone_reconcile",
      restartRecovery: "outcome_unknown",
      acceptanceRetention: "no_silent_eviction",
      hiddenSystemContextAtSpawn: true,
      hiddenSystemContextReceipt: "sha256",
    });
    expect(OPERATOR_SUBAGENT_SPAWN_CAPABILITY).not.toHaveProperty("retention");
  });
});
