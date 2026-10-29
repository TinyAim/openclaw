import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "./session-accessor.js";
import { branchCompactionCheckpointSession } from "./session-accessor.sqlite-checkpoint.js";
import {
  agentId,
  sourceExpectedState,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
const { createSession } = useSessionMessageCutFixtures();
it("prefers an owned legacy pre-snapshot over a hot post-compaction fallback", async () => {
  const { env, scope } = await createSession();
  const directory = path.dirname(resolveSessionStorePathForScope(scope));
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "legacy-window.jsonl");
  const rows = [
    { type: "session", id: "legacy-window", version: 3 },
    {
      type: "message",
      id: "legacy-original",
      parentId: null,
      message: { role: "user", content: "legacy original evidence" },
    },
    {
      type: "message",
      id: "legacy-sibling",
      parentId: null,
      message: { role: "user", content: "unselected sibling" },
    },
  ];
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n"));
  await upsertSessionEntryCore(scope, {
    ...loadSessionEntry(scope)!,
    compactionCheckpoints: [
      {
        checkpointId: "legacy",
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        createdAt: 1,
        reason: "manual",
        preCompaction: { sessionId: "legacy-window", sessionFile: file, leafId: "legacy-original" },
        postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
      },
    ],
  });
  const branch = await branchCompactionCheckpointSession({
    agentId,
    env,
    sourceKey: scope.sessionKey,
    nextKey: "agent:main:legacy-recovery",
    checkpointId: "legacy",
    expectedState: sourceExpectedState,
  });
  expect(branch.status).toBe("created");
  if (branch.status !== "created") throw new Error("expected legacy recovery");
  const restored = await loadTranscriptEvents({
    ...scope,
    sessionKey: branch.key,
    sessionId: branch.entry.sessionId,
  });
  expect(restored.map((row) => (row as { id?: string }).id)).toEqual([
    branch.entry.sessionId,
    "legacy-original",
  ]);
  expect(JSON.stringify(restored)).toContain("legacy original evidence");
  expect(JSON.stringify(restored)).not.toContain("unselected sibling");
  expect(await fs.readFile(file, "utf8")).toBe(rows.map((row) => JSON.stringify(row)).join("\n"));
});
