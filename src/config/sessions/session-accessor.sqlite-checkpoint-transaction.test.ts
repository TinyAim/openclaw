import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  applySqliteCompactionCheckpointSessionOperation,
  applySqliteCompactionCheckpointSessionOperationInTransaction,
  captureSqliteCompactionCheckpoint,
  captureSqliteCompactionCheckpointInTransaction,
  persistSqliteCompactionCheckpoint,
  persistSqliteCompactionCheckpointInTransaction,
} from "./session-accessor.sqlite-checkpoint.js";
import {
  agentId,
  sessionKey,
  sourceExpectedState,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureCheckpointSnapshotWitness } from "./session-checkpoint-snapshot-witness.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { SessionCompactionCheckpoint } from "./types.js";

const { createSession, createSiblingSession } = useSessionMessageCutFixtures();
const nextKey = "agent:main:checkpoint-branch";

describe("checkpoint branch SQLite transaction primitive", () => {
  it("captures then persists pre- and post-boundaries under the same owner", async () => {
    const { env, scope } = await createSession();
    const target = { agentId, env, sessionKey, sessionId: scope.sessionId, assertActive: () => {} };
    const before = await captureSqliteCompactionCheckpoint(target);
    expect(before).toMatchObject({ sessionId: scope.sessionId, leafId: "assistant-2" });
    await appendTranscriptMessage(scope, {
      eventId: "post",
      parentId: "assistant-2",
      message: { role: "user", content: "new" },
      now: Date.now(),
    });
    const after = await captureSqliteCompactionCheckpoint(target);
    expect(after).toMatchObject({ leafId: "post" });
    const checkpoint = {
      checkpointId: "new",
      sessionKey,
      sessionId: scope.sessionId,
      createdAt: 1,
      reason: "manual" as const,
      preCompaction: { sessionId: scope.sessionId, leafId: before!.leafId },
      postCompaction: { sessionId: scope.sessionId, leafId: after!.leafId },
    };
    await expect(
      persistSqliteCompactionCheckpoint({
        ...target,
        expectedState: sourceExpectedState,
        checkpoint,
      }),
    ).resolves.toEqual({ status: "stored" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toEqual([checkpoint]);
  });
  it("captures the current active leaf only for the expected session version", async () => {
    const { env, scope } = await createSession();
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const run = (expectedState: typeof sourceExpectedState) =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          captureSqliteCompactionCheckpointInTransaction(database, sessionKey, expectedState),
        toDatabaseOptions(resolved),
      );
    expect(run(sourceExpectedState)).toEqual({ sessionId: scope.sessionId, leafId: "assistant-2" });
    expect(run({ ...sourceExpectedState, lifecycleRevision: "stale" })).toBeNull();
  });
  it("rejects a checkpoint when the active writer changed without a lifecycle change", async () => {
    const { env, scope } = await createSession();
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const current = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, { ...current, activeWriterRunId: "replacement" });
    const expectedState = { ...sourceExpectedState, activeWriterRunId: undefined };
    expect(
      await captureSqliteCompactionCheckpoint({
        agentId,
        env,
        sessionKey,
        sessionId: scope.sessionId,
        expectedState,
        assertActive: () => {},
      }),
    ).toBeNull();
    const checkpoint = {
      checkpointId: "stale-writer",
      sessionKey,
      sessionId: scope.sessionId,
      createdAt: 1,
      reason: "manual" as const,
      preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
      postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
    };
    expect(
      runOpenClawAgentWriteTransaction(
        (database) =>
          captureSqliteCompactionCheckpointInTransaction(database, sessionKey, expectedState),
        toDatabaseOptions(resolved),
      ),
    ).toBeNull();
    expect(
      runOpenClawAgentWriteTransaction(
        (database) =>
          persistSqliteCompactionCheckpointInTransaction(
            database,
            sessionKey,
            expectedState,
            checkpoint,
          ),
        toDatabaseOptions(resolved),
      ),
    ).toEqual({ status: "conflict" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toBeUndefined();
  });
  it("persists a checkpoint only when both boundaries and the session version match", async () => {
    const { env, scope } = await createSession();
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const checkpoint = {
      checkpointId: "new",
      sessionKey,
      sessionId: scope.sessionId,
      createdAt: 1,
      reason: "manual" as const,
      preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
      postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
    };
    const run = (proposed: typeof checkpoint, expectedState = sourceExpectedState) =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          persistSqliteCompactionCheckpointInTransaction(
            database,
            sessionKey,
            expectedState,
            proposed,
          ),
        toDatabaseOptions(resolved),
      );
    expect(run(checkpoint, { ...sourceExpectedState, lifecycleRevision: "stale" })).toEqual({
      status: "conflict",
    });
    expect(
      run({ ...checkpoint, preCompaction: { sessionId: scope.sessionId, leafId: "missing" } }),
    ).toEqual({ status: "invalid" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toBeUndefined();
    expect(run(checkpoint)).toEqual({ status: "stored" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toEqual([checkpoint]);
    expect(run(checkpoint)).toEqual({ status: "invalid" });
  });
  it("requires a matching accepted successor witness before persisting cross-window boundaries", async () => {
    const { env, scope } = await createSession();
    const successor = { ...scope, sessionId: "successor" };
    await appendTranscriptEvent(successor, {
      type: "session",
      id: "successor",
      version: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await appendTranscriptMessage(successor, {
      eventId: "successor-leaf",
      parentId: null,
      message: { role: "user", content: "successor" },
      now: Date.now(),
    });
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      sessionId: "successor",
      lifecycleRevision: "next-revision",
    });
    const expectedState = { sessionId: "successor", lifecycleRevision: "next-revision" };
    const checkpoint = {
      checkpointId: "cross",
      sessionKey,
      sessionId: "successor",
      createdAt: 1,
      reason: "manual" as const,
      preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
      postCompaction: { sessionId: "successor", leafId: "successor-leaf" },
    };
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const run = (predecessor?: {
      captured: typeof sourceExpectedState;
      transition: { previous: typeof sourceExpectedState; current: typeof expectedState };
    }) =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          persistSqliteCompactionCheckpointInTransaction(
            database,
            sessionKey,
            expectedState,
            checkpoint,
            new Map(),
            predecessor,
          ),
        toDatabaseOptions(resolved),
      );
    expect(run()).toEqual({ status: "invalid" });
    expect(
      run({
        captured: sourceExpectedState,
        transition: {
          previous: { ...sourceExpectedState, sessionId: "other" },
          current: expectedState,
        },
      }),
    ).toEqual({ status: "invalid" });
    expect(
      run({
        captured: sourceExpectedState,
        transition: { previous: sourceExpectedState, current: expectedState },
      }),
    ).toEqual({ status: "stored" });
  });
  it("rolls back checkpoint persistence when write authority is revoked before commit", async () => {
    const { env, scope } = await createSession();
    const checkpoint = {
      checkpointId: "new",
      sessionKey,
      sessionId: scope.sessionId,
      createdAt: 1,
      reason: "manual" as const,
      preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
      postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
    };
    let assertions = 0;
    const params = {
      agentId,
      env,
      sessionKey,
      expectedState: sourceExpectedState,
      checkpoint,
      assertActive: () => {
        if (++assertions === 3) throw new Error("authority revoked");
      },
    };
    await expect(persistSqliteCompactionCheckpoint(params)).rejects.toThrow("authority revoked");
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toBeUndefined();
    await expect(
      persistSqliteCompactionCheckpoint({ ...params, assertActive: () => {} }),
    ).resolves.toEqual({ status: "stored" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toEqual([checkpoint]);
  });
  it("prepares owned legacy snapshot witnesses before guarded persistence", async () => {
    const { env, scope } = await createSession();
    const dir = path.dirname(resolveSessionStorePathForScope({ agentId, env, sessionKey }));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${scope.sessionId}.jsonl`);
    await fs.writeFile(file, "legacy fixture");
    const existing = loadSessionEntry(scope)!;
    const base = {
      sessionKey,
      sessionId: scope.sessionId,
      createdAt: 1,
      reason: "manual" as const,
      preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
      postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
    };
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          ...base,
          checkpointId: "old",
          preCompaction: { ...base.preCompaction, sessionFile: file },
        },
      ],
    });
    const params = {
      agentId,
      env,
      sessionKey,
      expectedState: sourceExpectedState,
      checkpoint: { ...base, checkpointId: "new" },
      assertActive: () => {},
    };
    await expect(persistSqliteCompactionCheckpoint(params)).resolves.toEqual({ status: "stored" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toHaveLength(2);
    expect(await fs.readFile(file, "utf8")).toBe("legacy fixture");
  });
  it("keeps the 25 newest checkpoint records", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    const base = {
      sessionKey,
      sessionId: scope.sessionId,
      createdAt: 1,
      reason: "manual" as const,
      preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
      postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
    };
    const records: SessionCompactionCheckpoint[] = Array.from({ length: 25 }, (_, index) => ({
      ...base,
      checkpointId: `old-${index}`,
    }));
    const snapshot = path.join(env.OPENCLAW_STATE_DIR!, "legacy.jsonl");
    await fs.writeFile(snapshot, "preserve legacy snapshot");
    records[0]!.preCompaction = { ...records[0]!.preCompaction, sessionFile: snapshot };
    records[24]!.preCompaction = { ...records[24]!.preCompaction, sessionFile: snapshot };
    await upsertSessionEntryCore(scope, { ...existing, compactionCheckpoints: records });
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const withoutWitness = runOpenClawAgentWriteTransaction(
      (database) =>
        persistSqliteCompactionCheckpointInTransaction(database, sessionKey, sourceExpectedState, {
          ...base,
          checkpointId: "new",
        }),
      toDatabaseOptions(resolved),
    );
    expect(withoutWitness).toEqual({ status: "invalid" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toHaveLength(25);
    const captured = await captureCheckpointSnapshotWitness(snapshot);
    expect(captured).not.toBeNull();
    await fs.appendFile(snapshot, " changed");
    const stale = runOpenClawAgentWriteTransaction(
      (database) =>
        persistSqliteCompactionCheckpointInTransaction(
          database,
          sessionKey,
          sourceExpectedState,
          { ...base, checkpointId: "new" },
          new Map([[snapshot, captured!]]),
        ),
      toDatabaseOptions(resolved),
    );
    expect(stale).toEqual({ status: "invalid" });
    const current = await captureCheckpointSnapshotWitness(snapshot);
    const result = runOpenClawAgentWriteTransaction(
      (database) =>
        persistSqliteCompactionCheckpointInTransaction(
          database,
          sessionKey,
          sourceExpectedState,
          { ...base, checkpointId: "new" },
          new Map([[snapshot, current!]]),
        ),
      toDatabaseOptions(resolved),
    );
    expect(result).toEqual({ status: "stored" });
    expect(
      loadSessionEntry(scope)?.compactionCheckpoints?.map((item) => item.checkpointId),
    ).toEqual([...records.slice(1).map((item) => item.checkpointId), "new"]);
    expect(await fs.readFile(snapshot, "utf8")).toBe("preserve legacy snapshot changed");
  });
  it("copies only the captured boundary, preserves the source and refuses overwrite", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
          postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
        },
      ],
    });
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const op = {
      kind: "branch" as const,
      agentId,
      env,
      sourceKey: sessionKey,
      nextKey,
      checkpointId: "checkpoint",
      expectedState: sourceExpectedState,
    };
    const run = () =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          applySqliteCompactionCheckpointSessionOperationInTransaction(
            database,
            resolved,
            op,
            sessionKey,
            nextKey,
          ),
        toDatabaseOptions(resolved),
      );
    const result = run();
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const events = await loadTranscriptEvents({
      agentId,
      env,
      sessionKey: nextKey,
      sessionId: result.entry.sessionId,
    });
    expect(events.map((event) => (event as { id?: string }).id)).toEqual([
      result.entry.sessionId,
      "user-1",
      "assistant-1",
    ]);
    expect(result.entry.lifecycleRevision).not.toBe(sourceExpectedState.lifecycleRevision);
    expect(result.entry.cliSessionBindings).toBeUndefined();
    expect(loadSessionEntry(scope)?.sessionId).toBe(scope.sessionId);
    expect(run()).toEqual({ status: "conflict" });
  });
  it("refuses stale identity and missing source boundaries without creating a branch", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "missing" },
          postCompaction: { sessionId: scope.sessionId, leafId: "missing" },
        },
      ],
    });
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const run = (expectedState: typeof sourceExpectedState) =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          applySqliteCompactionCheckpointSessionOperationInTransaction(
            database,
            resolved,
            {
              kind: "branch",
              agentId,
              env,
              sourceKey: sessionKey,
              nextKey,
              checkpointId: "checkpoint",
              expectedState,
            },
            sessionKey,
            nextKey,
          ),
        toDatabaseOptions(resolved),
      );
    expect(run({ ...sourceExpectedState, lifecycleRevision: "stale" })).toEqual({
      status: "conflict",
    });
    expect(run(sourceExpectedState)).toEqual({ status: "missing-boundary" });
    expect(loadSessionEntry({ agentId, env, sessionKey: nextKey })).toBeUndefined();
  });
  it("rejects branch and restore when an expected writer is replaced", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      activeWriterRunId: "replacement",
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
          postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
        },
      ],
    });
    const expectedState = { ...sourceExpectedState, activeWriterRunId: undefined };
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const branch = {
      kind: "branch" as const,
      agentId,
      env,
      sourceKey: sessionKey,
      nextKey,
      checkpointId: "checkpoint",
      expectedState,
    };
    const restore = {
      kind: "restore" as const,
      agentId,
      env,
      sessionKey,
      checkpointId: "checkpoint",
      expectedState,
    };
    for (const operation of [branch, restore]) {
      expect(
        runOpenClawAgentWriteTransaction(
          (database) =>
            applySqliteCompactionCheckpointSessionOperationInTransaction(
              database,
              resolved,
              operation,
              sessionKey,
              operation.kind === "branch" ? nextKey : sessionKey,
            ),
          toDatabaseOptions(resolved),
        ),
      ).toEqual({ status: "conflict" });
      await expect(applySqliteCompactionCheckpointSessionOperation(operation)).resolves.toEqual({
        status: "conflict",
      });
    }
    expect(loadSessionEntry(scope)?.sessionId).toBe(scope.sessionId);
    expect(loadSessionEntry({ agentId, env, sessionKey: nextKey })).toBeUndefined();
  });
  it("does not read another session's window named by forged checkpoint metadata", async () => {
    const { env, scope } = await createSession();
    const foreign = await createSiblingSession({
      env,
      sessionId: "foreign",
      sessionKey: "agent:main:foreign",
      headline: "private",
    });
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: foreign.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: foreign.sessionId, leafId: "foreign-user" },
          postCompaction: { sessionId: foreign.sessionId, leafId: "foreign-user" },
        },
      ],
    });
    const resolved = resolveSqliteScope({ agentId, env, sessionKey });
    const result = runOpenClawAgentWriteTransaction(
      (database) =>
        applySqliteCompactionCheckpointSessionOperationInTransaction(
          database,
          resolved,
          {
            kind: "branch",
            agentId,
            env,
            sourceKey: sessionKey,
            nextKey,
            checkpointId: "checkpoint",
            expectedState: sourceExpectedState,
          },
          sessionKey,
          nextKey,
        ),
      toDatabaseOptions(resolved),
    );
    expect(result).toEqual({ status: "missing-boundary" });
    expect(loadSessionEntry({ agentId, env, sessionKey: nextKey })).toBeUndefined();
  });
  it("prepares and publishes an ordinary branch only for the captured session version", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
          postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
        },
      ],
    });
    const op = {
      kind: "branch" as const,
      agentId,
      env,
      sourceKey: sessionKey,
      nextKey,
      checkpointId: "checkpoint",
      expectedState: sourceExpectedState,
    };
    expect(
      await applySqliteCompactionCheckpointSessionOperation({
        ...op,
        expectedState: { ...sourceExpectedState, lifecycleRevision: "stale" },
      }),
    ).toEqual({ status: "conflict" });
    const result = await applySqliteCompactionCheckpointSessionOperation(op);
    expect(result.status).toBe("created");
    expect(loadSessionEntry({ agentId, env, sessionKey: nextKey })?.sessionId).toBe(
      result.status === "created" ? result.entry.sessionId : undefined,
    );
  });
  it("rotates an ordinary restored session under its context-reset preparation", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
          postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
        },
      ],
    });
    const result = await applySqliteCompactionCheckpointSessionOperation({
      kind: "restore",
      agentId,
      env,
      sessionKey,
      checkpointId: "checkpoint",
      expectedState: sourceExpectedState,
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.entry.sessionId).not.toBe(scope.sessionId);
    expect(result.entry.previousSessionId).toBe(scope.sessionId);
    expect(loadSessionEntry(scope)?.sessionId).toBe(result.entry.sessionId);
    const events = await loadTranscriptEvents({
      agentId,
      env,
      sessionKey,
      sessionId: result.entry.sessionId,
    });
    expect(events.map((event) => (event as { id?: string }).id)).toEqual([
      result.entry.sessionId,
      "user-1",
      "assistant-1",
    ]);
  });
  it("serializes two concurrent branches into one creation and one conflict", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
          postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
        },
      ],
    });
    const op = {
      kind: "branch" as const,
      agentId,
      env,
      sourceKey: sessionKey,
      nextKey,
      checkpointId: "checkpoint",
      expectedState: sourceExpectedState,
    };
    const results = await Promise.all([
      applySqliteCompactionCheckpointSessionOperation(op),
      applySqliteCompactionCheckpointSessionOperation(op),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "created"]);
    const winner = results.find((result) => result.status === "created");
    expect(loadSessionEntry({ agentId, env, sessionKey: nextKey })?.sessionId).toBe(
      winner?.status === "created" ? winner.entry.sessionId : undefined,
    );
  });
  it("fences a second restore after the first rotates its source session", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
          postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
        },
      ],
    });
    const op = {
      kind: "restore" as const,
      agentId,
      env,
      sessionKey,
      checkpointId: "checkpoint",
      expectedState: sourceExpectedState,
    };
    const first = await applySqliteCompactionCheckpointSessionOperation(op);
    expect(first.status).toBe("created");
    expect(await applySqliteCompactionCheckpointSessionOperation(op)).toEqual({
      status: "conflict",
    });
    expect(loadSessionEntry(scope)?.sessionId).toBe(
      first.status === "created" ? first.entry.sessionId : undefined,
    );
  });
  it("does not commit two concurrent restores for the same captured session", async () => {
    const { env, scope } = await createSession();
    const existing = loadSessionEntry(scope)!;
    await upsertSessionEntryCore(scope, {
      ...existing,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint",
          sessionKey,
          sessionId: scope.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
          postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
        },
      ],
    });
    const op = {
      kind: "restore" as const,
      agentId,
      env,
      sessionKey,
      checkpointId: "checkpoint",
      expectedState: sourceExpectedState,
    };
    const results = await Promise.allSettled([
      applySqliteCompactionCheckpointSessionOperation(op),
      applySqliteCompactionCheckpointSessionOperation(op),
    ]);
    const created = results.filter(
      (result) => result.status === "fulfilled" && result.value.status === "created",
    );
    expect(created).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.status === "fulfilled" && result.value.status === "conflict",
      ),
    ).toHaveLength(1);
    const winner = created[0];
    if (!winner || winner.status !== "fulfilled" || winner.value.status !== "created")
      throw new Error("missing restore winner");
    expect(loadSessionEntry(scope)?.sessionId).toBe(winner.value.entry.sessionId);
  });
});
