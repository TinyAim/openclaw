import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  createSessionEntryWithTranscript,
  loadSessionEntry,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "./session-accessor.js";
import {
  branchCompactionCheckpointSession,
  captureSqliteCompactionCheckpoint,
  persistSqliteCompactionCheckpoint,
  restoreCompactionCheckpointSession,
} from "./session-accessor.sqlite-checkpoint.js";
import {
  agentId,
  sourceExpectedState,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { hasExistingNativeIncognitoCheckpointOwner } from "./session-checkpoint-native-incognito.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { withAcquiredIncognitoSessionBinding } from "./session-incognito-binding.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";
const { createSession } = useSessionMessageCutFixtures();
describe("checkpoint public storage owner", () => {
  it.each([false, true])(
    "refuses a retained capture after the original writer is replaced (native incognito=%s)",
    async (incognito) => {
      const { scope } = await createSession({ incognito });
      const before = await captureSqliteCompactionCheckpoint({ ...scope, assertActive() {} });
      if (!before) throw new Error("missing original writer capture");
      const current = await readSessionEntryReadOnlyInWorker({
        ...scope,
        readConsistency: "latest",
      });
      if (!current) throw new Error("missing current entry");
      await upsertSessionEntryCore(scope, { ...current, activeWriterRunId: "replacement-writer" });
      expect(
        await persistSqliteCompactionCheckpoint({
          ...scope,
          source: before,
          expectedState: {
            sessionId: before.sessionId,
            lifecycleRevision: before.lifecycleRevision,
            activeWriterRunId: "replacement-writer",
          },
          assertActive() {},
          checkpoint: {
            checkpointId: "stale-capture",
            sessionId: scope.sessionId,
            sessionKey: scope.sessionKey,
            createdAt: 1,
            reason: "manual",
            preCompaction: { sessionId: before.sessionId, leafId: before.leafId },
            postCompaction: { sessionId: before.sessionId, leafId: before.leafId },
          },
        }),
      ).toEqual({ status: "conflict" });
      expect(loadSessionEntry(scope)?.compactionCheckpoints).toBeUndefined();
    },
  );
  it("retains and recovers through the production native incognito creation owner without disk", async () => {
    const fixture = await createSession();
    const scope = {
      ...fixture.scope,
      sessionKey: "agent:main:dashboard:incognito-production",
      sessionId: "native-private",
    };
    expect(
      await createSessionEntryWithTranscript(scope, () => ({
        ok: true,
        entry: {
          sessionId: scope.sessionId,
          lifecycleRevision: "native-revision",
          incognito: true,
          updatedAt: 1,
        },
      })),
    ).toMatchObject({ ok: true });
    expect(hasExistingNativeIncognitoCheckpointOwner(scope)).toBe(true);
    const owner = listOpenIncognitoAgentDatabases().find((owner) => owner.agentId === agentId)!;
    expect(owner).toBeDefined();
    expect(existsSync(owner.storePath)).toBe(false);
    await appendTranscriptMessage(scope, {
      eventId: "private-before",
      parentId: null,
      message: { role: "user", content: "private original" },
      now: 1,
    });
    const before = await captureSqliteCompactionCheckpoint({ ...scope, assertActive() {} });
    expect(before?.storageKind).toBe("native-incognito");
    if (!before) throw new Error("missing native pre-compaction boundary");
    await appendTranscriptMessage(scope, {
      eventId: "private-after",
      parentId: "private-before",
      message: { role: "assistant", content: "private current" },
      now: 2,
    });
    const after = await captureSqliteCompactionCheckpoint({ ...scope, assertActive() {} });
    if (!after) throw new Error("missing native post-compaction boundary");
    const checkpoint = {
      checkpointId: "native-retained",
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      createdAt: 3,
      reason: "manual" as const,
      preCompaction: { sessionId: before.sessionId, leafId: before.leafId },
      postCompaction: { sessionId: after.sessionId, leafId: after.leafId },
    };
    expect(
      await persistSqliteCompactionCheckpoint({
        ...scope,
        expectedState: after,
        source: before,
        checkpoint,
        assertActive() {},
      }),
    ).toEqual({ status: "stored" });
    expect(loadSessionEntry(scope)?.compactionCheckpoints).toEqual([checkpoint]);
    const nextKey = "agent:main:dashboard:incognito-production-branch";
    const branch = await branchCompactionCheckpointSession({
      agentId,
      env: fixture.env,
      sourceKey: scope.sessionKey,
      nextKey,
      checkpointId: checkpoint.checkpointId,
      expectedState: after,
    });
    expect(branch.status).toBe("created");
    if (branch.status !== "created") throw new Error("native branch failed");
    expect(branch.entry.incognito).toBe(true);
    expect(
      (
        await loadTranscriptEvents({
          ...scope,
          sessionKey: nextKey,
          sessionId: branch.entry.sessionId,
        })
      )
        .filter((event) => event.type === "message")
        .map((event) => event.id),
    ).toEqual(["private-before"]);
    const restored = await restoreCompactionCheckpointSession({
      agentId,
      env: fixture.env,
      sessionKey: scope.sessionKey,
      checkpointId: checkpoint.checkpointId,
      expectedState: after,
    });
    expect(restored.status).toBe("created");
    if (restored.status !== "created") throw new Error("native restore failed");
    expect(loadSessionEntry(scope)?.sessionId).toBe(restored.entry.sessionId);
    expect(
      (await loadTranscriptEvents({ ...scope, sessionId: restored.entry.sessionId }))
        .filter((event) => event.type === "message")
        .map((event) => event.id),
    ).toEqual(["private-before"]);
    expect(existsSync(owner.storePath)).toBe(false);
    expect(hasExistingNativeIncognitoCheckpointOwner(scope)).toBe(true);
  });

  it("refuses a foreign native capture and any owned frame before synchronous checkpoint SQL", async () => {
    const fixture = await createSession({ incognito: true });
    const scope = fixture.scope;
    const before = await captureSqliteCompactionCheckpoint({ ...scope, assertActive() {} });
    if (!before) throw new Error("missing native capture");
    expect(
      await captureSqliteCompactionCheckpoint({
        ...scope,
        sessionId: "foreign-session",
        assertActive() {},
      }),
    ).toBeNull();
    await expect(
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          assertCommitAllowed() {},
          withTranscriptWrite: async (write) => write(),
        },
        () => captureSqliteCompactionCheckpoint({ ...scope, assertActive() {} }),
      ),
    ).rejects.toThrow();
    const other = {
      ...scope,
      sessionKey: "agent:main:dashboard:incognito-other",
      sessionId: "other",
    };
    await createSessionEntryWithTranscript(other, () => ({
      ok: true,
      entry: { sessionId: other.sessionId, updatedAt: 1, incognito: true },
    }));
    expect(
      await persistSqliteCompactionCheckpoint({
        ...other,
        source: before,
        expectedState: { sessionId: other.sessionId },
        assertActive() {},
        checkpoint: {
          checkpointId: "foreign",
          sessionKey: other.sessionKey,
          sessionId: other.sessionId,
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: before.sessionId, leafId: before.leafId },
          postCompaction: { sessionId: before.sessionId, leafId: before.leafId },
        },
      }),
    ).toEqual({ status: "conflict" });
    expect(loadSessionEntry(other)?.compactionCheckpoints).toBeUndefined();
  });
  it.each([false, true])(
    "branches then restores through its actual owner (actor=%s)",
    async (incognito) => {
      const fixture = await createSession();
      const scope = {
        ...fixture.scope,
        sessionKey: incognito ? "agent:main:dashboard:incognito-source" : fixture.scope.sessionKey,
      };
      const env = fixture.env;
      const current = loadSessionEntry(fixture.scope)!;
      const checkpoint = {
        checkpointId: "retained",
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        createdAt: 1,
        reason: "manual" as const,
        preCompaction: { sessionId: scope.sessionId, leafId: "assistant-1" },
        postCompaction: { sessionId: scope.sessionId, leafId: "assistant-2" },
      };
      const run = async (
        binding?: Parameters<Parameters<typeof withAcquiredIncognitoSessionBinding>[2]>[0],
      ) => {
        const read = () =>
          readSessionEntryReadOnlyInWorker({ ...scope, readConsistency: "latest" });
        if (binding) {
          await binding.actor.sessions.create(
            { assertCurrent: () => binding.actor.assertCurrent() },
            {
              sessionKey: scope.sessionKey,
              entry: { ...current, incognito: true, compactionCheckpoints: [checkpoint] },
            },
          );
          for (const event of [
            { id: "user-1", parentId: null, message: { role: "user", content: "first prompt" } },
            {
              id: "assistant-1",
              parentId: "user-1",
              message: { role: "assistant", content: "first answer" },
            },
            {
              id: "user-2",
              parentId: "assistant-1",
              message: { role: "user", content: "second prompt" },
            },
            {
              id: "assistant-2",
              parentId: "user-2",
              message: { role: "assistant", content: "second answer" },
            },
          ])
            await appendTranscriptMessage(scope, {
              eventId: event.id,
              parentId: event.parentId,
              message: event.message,
              now: 1,
            });
        } else
          await upsertSessionEntryCore(scope, { ...current, compactionCheckpoints: [checkpoint] });
        const nextKey = incognito
          ? "agent:main:dashboard:incognito-branch"
          : "agent:main:checkpoint-branch";
        const branch = await branchCompactionCheckpointSession({
          agentId,
          env,
          sourceKey: scope.sessionKey,
          nextKey,
          checkpointId: "retained",
          expectedState: sourceExpectedState,
        });
        expect(branch.status).toBe("created");
        if (branch.status !== "created") throw new Error("expected checkpoint branch");
        expect((await read())?.sessionId).toBe(scope.sessionId);
        expect(
          (
            await loadTranscriptEvents({
              ...scope,
              sessionKey: nextKey,
              sessionId: branch.entry.sessionId,
            })
          ).map((row) => (row as { id?: string }).id),
        ).toEqual([branch.entry.sessionId, "user-1", "assistant-1"]);
        const restored = await restoreCompactionCheckpointSession({
          agentId,
          env,
          sessionKey: scope.sessionKey,
          checkpointId: "retained",
          expectedState: sourceExpectedState,
        });
        expect(restored.status).toBe("created");
        if (restored.status !== "created") throw new Error("expected checkpoint restore");
        expect((await read())?.sessionId).toBe(restored.entry.sessionId);
        expect(
          await restoreCompactionCheckpointSession({
            agentId,
            env,
            sessionKey: scope.sessionKey,
            checkpointId: "retained",
            expectedState: sourceExpectedState,
          }),
        ).toEqual({ status: "conflict" });
      };
      if (incognito) {
        const result = await withAcquiredIncognitoSessionBinding(
          scope,
          { assertCurrent() {} },
          async (binding) => {
            await run(binding);
            expect(existsSync(binding.actor.path)).toBe(false);
            return "verified";
          },
          { existingOnly: false },
        );
        expect(result).toBe("verified");
      } else await run();
    },
  );
});
