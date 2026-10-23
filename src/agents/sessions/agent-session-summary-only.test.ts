import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  createFileBackedCompactionCheckpointStore,
  listSessionCompactionCheckpoints,
} from "../../gateway/session-compaction-checkpoints.js";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardRuntime,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import { testing } from "../agent-hooks/compaction-safeguard.test-support.js";
import type { summarizeInStages } from "../compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => testing.setSummarizeInStagesForTest());

describe("manual summary-only compaction", () => {
  it.each([undefined, "preserve_recent", "summary_only"] as const)(
    "preserves SQLite raw history and applies %s only to active context",
    async (historyMode) => {
      const cwd = tempDirs.make("openclaw-summary-only-");
      const target = {
        agentId: "main",
        sessionId: "summary-only-session",
        sessionKey: "agent:main:summary-only-session",
        storePath: path.join(cwd, "sessions.json"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(target, cwd);
      manager.appendMessage({ role: "user", content: "Prior task", timestamp: 1 });
      const priorAssistantId = manager.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "Prior answer" }]),
      );
      manager.appendCompaction("Verified earlier project fact.", priorAssistantId, 100);
      manager.appendMessage({ role: "user", content: "Describe your assignment", timestamp: 3 });
      const oldAssistant = "Historical assistant refused repeated capability questions.";
      manager.appendMessage(createAssistant(testModel, [{ type: "text", text: oldAssistant }]));
      manager.flushPendingPersistence();
      const prompts: string[] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        prompts.push(JSON.stringify(context.messages));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "Attributed role-aware summary." }]),
        );
      });
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 0 },
          retry: { enabled: false },
        }),
      });
      manager.flushPendingPersistence();
      const rawBefore = await loadTranscriptEvents(target);
      const checkpointStore = createFileBackedCompactionCheckpointStore();
      const checkpointSnapshot =
        historyMode === "summary_only"
          ? await checkpointStore.captureSnapshot({
              sessionManager: manager,
              sessionTarget: target,
              sessionFile: formatSqliteSessionFileMarker(target),
            })
          : null;
      const result = await session.compact("Current assignment: setting steward.", { historyMode });
      const rawAfter = await loadTranscriptEvents(target);
      expect(rawAfter.slice(0, rawBefore.length)).toEqual(rawBefore);
      expect(rawAfter).toHaveLength(rawBefore.length + 1);
      const reopened = SessionManager.open(target, cwd);
      const leaf = reopened.getLeafEntry();
      expect(leaf?.type).toBe("compaction");
      if (historyMode === "summary_only") {
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Verified earlier project fact.");
        expect(prompts[0]).toContain(oldAssistant);
        expect(result.firstKeptEntryId).toBe(leaf?.id);
        expect(reopened.buildSessionContext().messages).toEqual([
          expect.objectContaining({
            role: "compactionSummary",
            summary: "Attributed role-aware summary.",
          }),
        ]);
        expect(checkpointSnapshot).not.toBeNull();
        const checkpoint = await checkpointStore.persistCheckpoint({
          cfg: { session: { store: target.storePath } },
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          reason: "manual",
          snapshot: checkpointSnapshot!,
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
          postLeafId: leaf?.id,
          postEntryId: leaf?.id,
        });
        expect(checkpoint).toMatchObject({
          sessionId: target.sessionId,
          firstKeptEntryId: leaf?.id,
          postCompaction: { sessionId: target.sessionId, leafId: leaf?.id },
        });
        expect(listSessionCompactionCheckpoints(loadSessionEntry(target))).toEqual([checkpoint]);
        const branch = await checkpointStore.branchCheckpointSession({
          agentId: target.agentId,
          expectedState: { sessionId: target.sessionId },
          storePath: target.storePath,
          sourceKey: target.sessionKey,
          nextKey: "agent:main:summary-only-checkpoint-branch",
          checkpointId: checkpoint!.checkpointId,
        });
        expect(branch.status).toBe("created");
        if (branch.status !== "created") {
          throw new Error("Expected a branch of the retained pre-compaction checkpoint");
        }
        const recovered = await loadTranscriptEvents({
          ...target,
          sessionId: branch.entry.sessionId,
          sessionKey: "agent:main:summary-only-checkpoint-branch",
        });
        expect(JSON.stringify(recovered)).toContain(oldAssistant);
        expect(await loadTranscriptEvents(target)).toEqual(rawAfter);
      } else {
        expect(result.firstKeptEntryId).not.toBe(leaf?.id);
        expect(reopened.buildSessionContext().messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: oldAssistant }],
          }),
        );
      }
      expect(reopened.getSessionId()).toBe(target.sessionId);
    },
  );

  it("keeps before-compaction veto authoritative and does not invoke the model", async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "Task", timestamp: 1 });
    manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "Answer" }]));
    const veto = vi.fn(async (event: unknown) => {
      expect(event).toMatchObject({
        preparation: { historyMode: "summary_only", isSplitTurn: false },
      });
      return { cancel: true };
    });
    const resourceLoader = createResourceLoader();
    const extensions = resourceLoader.getExtensions();
    const eventBus = createEventBus();
    extensions.extensions.push(
      await loadExtensionFromFactory(
        (api) => {
          api.on("session_before_compact", veto);
        },
        manager.getCwd(),
        eventBus,
        extensions.runtime,
      ),
    );
    const { session } = await createTestSession({ sessionManager: manager, resourceLoader });
    const before = structuredClone(manager.getEntries());
    await expect(session.compact("Keep facts.", { historyMode: "summary_only" })).rejects.toThrow(
      "cancelled",
    );
    expect(veto).toHaveBeenCalledOnce();
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
    expect(manager.getEntries()).toEqual(before);
    eventBus.clear();
  });

  it.each([false, true])(
    "retains safeguard quality checks with invalid summary=%s",
    async (invalid) => {
      const manager = SessionManager.inMemory();
      const latestAsk = "Describe assignment /tmp/role-state.log";
      const oldAssistant = "Historical assistant refused repeated capability questions.";
      manager.appendMessage({ role: "user", content: latestAsk, timestamp: 1 });
      manager.appendMessage(createAssistant(testModel, [{ type: "text", text: oldAssistant }]));
      const summary = [
        "## Decisions",
        "Current assignment is setting steward.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Follow the current assignment.",
        "## Pending user asks",
        `Latest user request context: ${JSON.stringify(latestAsk)}`,
        "Latest user request status: answered.",
        "## Exact identifiers",
        "/tmp/role-state.log",
      ].join("\n");
      const summarize = vi.fn(async (_params: Parameters<typeof summarizeInStages>[0]) =>
        invalid ? "No structured facts." : summary,
      );
      testing.setSummarizeInStagesForTest(summarize);
      setCompactionSafeguardRuntime(manager, {
        model: testModel,
        recentTurnsPreserve: 3,
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 1,
        postCompactionSections: [],
      });
      const resourceLoader = createResourceLoader();
      const extensions = resourceLoader.getExtensions();
      const eventBus = createEventBus();
      extensions.extensions.push(
        await loadExtensionFromFactory(
          compactionSafeguardExtension,
          manager.getCwd(),
          eventBus,
          extensions.runtime,
        ),
      );
      const { session } = await createTestSession({ sessionManager: manager, resourceLoader });
      const before = structuredClone(manager.getEntries());
      if (invalid) {
        await expect(
          session.compact("Apply current assignment.", { historyMode: "summary_only" }),
        ).rejects.toThrow("cancelled");
        expect(summarize).toHaveBeenCalledTimes(2);
        expect(manager.getEntries()).toEqual(before);
      } else {
        const result = await session.compact("Apply current assignment.", {
          historyMode: "summary_only",
        });
        expect(summarize).toHaveBeenCalledOnce();
        expect(summarize.mock.calls[0]?.[0]).toMatchObject({
          messages: [
            expect.objectContaining({ role: "user" }),
            expect.objectContaining({ role: "assistant" }),
          ],
        });
        expect(result.summary).toContain("/tmp/role-state.log");
        expect(result.summary).not.toContain("Recent turns preserved verbatim");
        expect(result.summary).not.toContain(oldAssistant);
        expect(manager.buildSessionContext().messages).toHaveLength(1);
      }
      expect(getCompactionSafeguardRuntime(manager)?.recentTurnsPreserve).toBe(3);
      expect(streamMocks.streamSimple).not.toHaveBeenCalled();
      eventBus.clear();
    },
  );
});
