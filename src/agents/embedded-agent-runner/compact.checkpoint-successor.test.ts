import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  contextEngineCompactMock,
  hookRunner,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
} from "./compact.hooks.harness.js";
const { compactEmbeddedAgentSession: compact } = await loadCompactHooksHarness();
// Load after the harness module reset: use the same real private Host/SQLite owners.
const [accessor, databases, checkpoints] = await Promise.all([
  import("../../config/sessions/session-accessor.js"),
  import("../../state/openclaw-agent-db.js"),
  import("../../config/sessions/session-accessor.sqlite-checkpoint.js"),
]);
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await databases.closeOpenClawAgentDatabasesAsync();
    databases.closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
it.each([false, true])(
  "retains actual queued Host-owned boundaries (successor=%s)",
  async (rotates) => {
    const workspaceDir = await realpath(dirs.make("queued-checkpoint-"));
    resetCompactHooksHarnessMocks(workspaceDir);
    hookRunner.hasHooks.mockReturnValue(false);
    const sessionKey = "agent:main:queued-checkpoint";
    const target = {
      agentId: "main",
      sessionKey,
      sessionId: "original",
      storePath: join(workspaceDir, "sessions.sqlite"),
    };
    const owner = {
      sessionId: target.sessionId,
      lifecycleRevision: "original-revision",
      activeWriterRunId: "original-writer",
    };
    await accessor.upsertSessionEntryCore(target, { ...owner, updatedAt: 1 });
    await accessor.appendTranscriptEvent(target, {
      type: "session",
      id: target.sessionId,
      version: 3,
      timestamp: "2026-10-28T00:00:00Z",
    });
    await accessor.appendTranscriptMessage(target, {
      eventId: "original-leaf",
      parentId: null,
      now: 1,
      message: { role: "user", content: "original evidence" },
    });
    const next = rotates ? { ...target, sessionId: "successor" } : target;
    // Engine-owned prepared transcript exists before its declared successor is admitted.
    if (rotates) {
      await accessor.appendTranscriptEvent(next, {
        type: "session",
        id: next.sessionId,
        version: 3,
        timestamp: "2026-10-28T00:00:00Z",
      });
      await accessor.appendTranscriptMessage(next, {
        eventId: "successor-leaf",
        parentId: null,
        now: 2,
        message: { role: "user", content: "retained engine summary" },
      });
    }
    contextEngineCompactMock.mockImplementation(async () => {
      if (!rotates)
        await accessor.appendTranscriptEvent(target, {
          type: "compaction",
          id: "compacted-leaf",
          parentId: "original-leaf",
          timestamp: "2026-10-28T00:00:01Z",
          summary: "retained summary",
          firstKeptEntryId: "original-leaf",
          tokensBefore: 100,
        });
      return {
        ok: true,
        compacted: true,
        result: {
          sessionId: next.sessionId,
          summary: "retained summary",
          tokensBefore: 100,
          tokensAfter: 20,
        },
      };
    });
    resolveContextEngineMock.mockResolvedValue({
      info: { id: "checkpoint-engine", name: "Checkpoint engine", ownsCompaction: true },
      compact: contextEngineCompactMock,
    });
    const result = await compact({
      ...target,
      sessionTarget: target,
      sessionFile: sessionKey,
      sessionEntry: { ...owner, updatedAt: 1 },
      workspaceDir,
      provider: "codex",
      model: "test-model",
      agentHarnessId: "codex",
      enqueue: async (task) => await task(),
    });
    expect(result).toMatchObject({ ok: true, compacted: true });
    const entry = accessor.loadSessionEntry({ ...next, readConsistency: "latest" })!;
    expect(entry.compactionCheckpoints).toHaveLength(1);
    const checkpoint = entry.compactionCheckpoints![0]!;
    expect(checkpoint).toMatchObject({
      sessionKey,
      sessionId: next.sessionId,
      preCompaction: { sessionId: target.sessionId, leafId: "original-leaf" },
      postCompaction: {
        sessionId: next.sessionId,
        leafId: rotates ? "successor-leaf" : "compacted-leaf",
      },
    });
    if (rotates) expect(entry.previousSessionId).toBe(target.sessionId);
    const branch = await checkpoints.branchCompactionCheckpointSession({
      agentId: target.agentId,
      sourceKey: sessionKey,
      storePath: target.storePath,
      nextKey: "agent:main:checkpoint-recovery",
      checkpointId: checkpoint.checkpointId,
      expectedState: {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      },
    });
    expect(branch.status).toBe("created");
    if (branch.status !== "created") throw new Error("expected retained predecessor recovery");
    expect(
      JSON.stringify(
        await accessor.loadTranscriptEvents({
          ...target,
          sessionKey: branch.key,
          sessionId: branch.entry.sessionId,
        }),
      ),
    ).toContain("original evidence");
  },
);
