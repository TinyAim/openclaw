import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createSessionActionMethods } from "../../../../../../../services/openclaw_adapter/src/runtime/session-client/session-actions.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { SYNC_REBUILD_MAX_BYTES } from "../../config/sessions/session-transcript-index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import * as historyPageOwner from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import {
  cfg,
  messageCutContext,
  seedMessageCutSource,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();
it.each([false, true])(
  "switches the public branch and directly reads the frozen legacy publication (large=%s)",
  async (large) => {
    await withOpenClawTestState({ label: "legacy-public-branch-switch" }, async (state) => {
      await state.writeConfig(cfg);
      const scope = await seedMessageCutSource(false, {
        sessionKey: "agent:main:webchat:dm:legacy-media",
        sessionId: "legacy-source",
      });
      const publication = JSON.parse(
        readFileSync("src/gateway/legacy-external-publication.fixture.json", "utf8"),
      );
      await appendTranscriptMessage(scope, {
        eventId: "legacy-publication",
        parentId: "alternate-user",
        message: publication,
      });
      const media = JSON.parse(
        readFileSync("src/gateway/legacy-private-media-publication.fixture.json", "utf8"),
      );
      await appendTranscriptMessage(scope, {
        eventId: "legacy-media",
        parentId: "legacy-publication",
        message: media,
      });
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "select-original",
        parentId: "legacy-media",
        targetId: "user-2",
      });
      if (large)
        await appendTranscriptEvent(scope, {
          type: "oversized-padding",
          padding: "x".repeat(SYNC_REBUILD_MAX_BYTES),
        });
      const params = { sessionKey: scope.sessionKey, leafEntryId: "legacy-media" };
      const respond = vi.fn();
      await sessionRewindHandlers["sessions.branches.switch"]!({
        req: {
          type: "req",
          id: "legacy-public-switch",
          method: "sessions.branches.switch",
          params,
        },
        params,
        respond,
        context: messageCutContext(),
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(true, {}, undefined);
      const entry = loadSessionEntry(scope);
      expect(entry?.sessionId).toBeTruthy();
      expect(entry?.sessionId).not.toBe(scope.sessionId);
      const historyContext = await createHistoryReadContext();
      const historyParams = { sessionKey: scope.sessionKey, limit: 10 };
      const readHistory = async () => {
        for (let attempt = 0; attempt < (large ? 8 : 1); attempt++) {
          const historyRespond = vi.fn();
          await chatHistoryHandlers["chat.history"]!({
            params: historyParams,
            context: historyContext,
            req: {
              type: "req",
              id: `history-${attempt}`,
              method: "chat.history",
              params: historyParams,
            },
            client: null,
            isWebchatConnect: () => false,
            respond: historyRespond,
          });
          const [ok, result, error] = historyRespond.mock.calls[0] ?? [];
          if (ok) return result as Record<string, unknown>;
          expect(error).toMatchObject({
            code: "UNAVAILABLE",
            message: expect.stringContaining("rebuilding"),
          });
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error("ordinary public history did not reach the selected branch");
      };
      const payload = await readHistory();
      expect(payload.sessionId).toBe(entry!.sessionId);
      expect(JSON.stringify(payload.messages)).toContain("Frozen external publication");
      expect(JSON.stringify(payload.messages)).toContain("Frozen media publication");
      expect(JSON.stringify(payload.messages)).toContain("artifact_managed_image_");
      expect(JSON.stringify(payload.messages)).not.toContain("What did I say?");
      expect(
        (payload.messages as unknown[]).filter((row) =>
          JSON.stringify(row).includes("Frozen external publication"),
        ),
      ).toHaveLength(1);
      if (!large) {
        // Exercise the real Adapter request/mapping with a local handler bridge, not a network connection.
        const adapter = createSessionActionMethods({
          connectionManager: {
            request: async (method: string, params: Record<string, unknown>) => {
              if (method !== "chat.history") throw new Error("unexpected adapter method");
              const responded = vi.fn();
              await chatHistoryHandlers["chat.history"]!({
                params,
                context: historyContext,
                req: { type: "req", id: "adapter-history", method, params },
                client: null,
                isWebchatConnect: () => false,
                respond: responded,
              });
              const [ok, result, error] = responded.mock.calls[0] ?? [];
              if (!ok) throw new Error(JSON.stringify(error));
              return result;
            },
          },
        } as never);
        const adapterHistory = await adapter.getChatHistory(scope.sessionKey, 10);
        expect(adapterHistory.sessionId).toBe(entry!.sessionId);
        expect(JSON.stringify(adapterHistory.messages)).toContain("Frozen external publication");
        expect(JSON.stringify(adapterHistory.messages)).toContain("Frozen media publication");

        const entered = createDeferredCore();
        const unblock = createDeferredCore();
        const realRead = historyPageOwner.readChatHistoryPage;
        const spy = vi
          .spyOn(historyPageOwner, "readChatHistoryPage")
          .mockImplementationOnce(async (...args) => {
            const page = await realRead(...args);
            entered.resolve();
            await unblock.promise;
            return page;
          });
        let revoked = false;
        const denied = new Error("history authority revoked");
        const denyRespond = vi.fn();
        const deniedRead = chatHistoryHandlers["chat.history"]!({
          params: historyParams,
          context: historyContext,
          req: {
            type: "req",
            id: "history-before-revocation",
            method: "chat.history",
            params: historyParams,
          },
          client: null,
          isWebchatConnect: () => false,
          respond: denyRespond,
          sessionMutationAuthorization: {
            assertCurrent: () => {
              if (revoked) throw denied;
            },
          },
        });
        await entered.promise;
        revoked = true;
        unblock.resolve();
        await expect(deniedRead).rejects.toBe(denied);
        expect(denyRespond.mock.calls.some(([ok]) => ok === true)).toBe(false);
        expect(JSON.stringify(denyRespond.mock.calls)).not.toContain("Frozen external publication");
        spy.mockRestore();
      }
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const originalRead = historyPageOwner.readChatHistoryPage;
      const pageSpy = vi
        .spyOn(historyPageOwner, "readChatHistoryPage")
        .mockImplementationOnce(async (...args) => {
          const page = await originalRead(...args);
          reached.resolve();
          await release.promise;
          return page;
        });
      const staleRespond = vi.fn();
      const pending = chatHistoryHandlers["chat.history"]!({
        params: historyParams,
        context: historyContext,
        req: {
          type: "req",
          id: "history-before-switch-back",
          method: "chat.history",
          params: historyParams,
        },
        client: null,
        isWebchatConnect: () => false,
        respond: staleRespond,
      });
      await reached.promise;
      const backParams = { sessionKey: scope.sessionKey, leafEntryId: "user-2" };
      const back = vi.fn();
      await sessionRewindHandlers["sessions.branches.switch"]!({
        req: {
          type: "req",
          id: "legacy-switch-back",
          method: "sessions.branches.switch",
          params: backParams,
        },
        params: backParams,
        respond: back,
        context: messageCutContext(),
        client: null,
        isWebchatConnect: () => false,
      });
      expect(back).toHaveBeenCalledWith(true, {}, undefined);
      release.resolve();
      await pending;
      pageSpy.mockRestore();
      expect(staleRespond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(JSON.stringify(staleRespond.mock.calls)).not.toContain("Frozen external publication");
      const backEntry = loadSessionEntry(scope);
      expect(backEntry?.sessionId).not.toBe(entry!.sessionId);
      const backHistory = await readHistory();
      expect(backHistory.sessionId).toBe(backEntry!.sessionId);
      expect(JSON.stringify(backHistory.messages)).toContain("What did I say?");
      expect(JSON.stringify(backHistory.messages)).not.toContain("Frozen external publication");
      expect(JSON.stringify(backHistory.messages)).not.toContain("Frozen media publication");
    });
  },
);
