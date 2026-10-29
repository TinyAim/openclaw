import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { sessionCheckpointQueryHandlers } from "./server-methods/sessions-compaction-queries.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

describe("checkpoint list scope", () => {
  it("allows an owned draft and rejects another profile's draft before the handler", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      const reader = roleClient("view", "checkpoint-reader");
      const owner = roleClient("view", "checkpoint-owner");
      reader.connect.scopes = ["operator.sessions.read"];
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      for (const own of [true, false]) {
        const key = `agent:main:checkpoint-${own ? "own" : "foreign"}`;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          {
            sessionId: own ? "own" : "foreign",
            updatedAt: 1,
            visibility: "draft",
            createdActor: {
              type: "human",
              source: "profile",
              id: (own ? reader : owner).authenticatedUserProfile!.profileId,
            },
            compactionCheckpoints: [
              {
                checkpointId: "one",
                sessionKey: key,
                sessionId: own ? "own" : "foreign",
                createdAt: 1,
                reason: "manual",
                preCompaction: { sessionId: own ? "own" : "foreign" },
                postCompaction: { sessionId: own ? "own" : "foreign" },
              },
            ],
          },
        );
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: key,
            method: "sessions.compaction.list",
            params: { key, agentId: "main" },
          },
          client: reader,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionCheckpointQueryHandlers,
        });
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0])).toBe(own);
        if (own)
          expect(respond.mock.calls[0]?.[1]).toMatchObject({
            key,
            checkpoints: [{ checkpointId: "one" }],
          });
        else expect(respond.mock.calls[0]?.[1]).toBeUndefined();
      }
    });
  });
});
