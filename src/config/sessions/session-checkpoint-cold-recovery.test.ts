import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "./session-accessor.js";
import { branchCompactionCheckpointSession } from "./session-accessor.sqlite-checkpoint.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
it("restores the retained cold predecessor through its cold-storage owner before branching", async () => {
  const root = dirs.make("checkpoint-cold-");
  const fixture = await createSessionColdStorageFixture(path.join(root, "sessions.sqlite"));
  expect(
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) }),
  ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  const current = loadSessionEntry(fixture.scope)!;
  await upsertSessionEntryCore(fixture.scope, {
    ...current,
    compactionCheckpoints: [
      {
        checkpointId: "cold",
        sessionKey: fixture.scope.sessionKey,
        sessionId: current.sessionId,
        createdAt: 1,
        reason: "manual",
        preCompaction: { sessionId: historicalId, leafId: "history-assistant" },
        postCompaction: { sessionId: current.sessionId },
      },
    ],
  });
  const branch = await branchCompactionCheckpointSession({
    agentId: "main",
    storePath: fixture.scope.storePath,
    sourceKey: fixture.scope.sessionKey,
    nextKey: "agent:main:cold-recovery",
    checkpointId: "cold",
    expectedState: {
      sessionId: current.sessionId,
      lifecycleRevision: current.lifecycleRevision,
      activeWriterRunId: current.activeWriterRunId,
    },
  });
  expect(branch.status).toBe("created");
  if (branch.status !== "created") throw new Error("expected cold recovery");
  const events = await loadTranscriptEvents({
    ...fixture.scope,
    sessionKey: branch.key,
    sessionId: branch.entry.sessionId,
  });
  expect(events.map((row) => (row as { id?: string }).id)).toEqual([
    branch.entry.sessionId,
    "history-user",
    "history-assistant",
  ]);
  expect(JSON.stringify(events)).toContain("Preserved response");
});
