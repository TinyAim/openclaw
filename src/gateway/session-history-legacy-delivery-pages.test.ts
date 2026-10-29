import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryDelta } from "./server-methods/chat-history-delta.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";

it("uses the same frozen external publication in a live delta and an anchored history read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "legacy-external-pages",
      sessionKey: "agent:main:legacy-external-pages",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: scope.sessionId, updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: scope.sessionId }]);
    const head = readTranscriptDisplayDelta(scope);
    expect(head.kind).toBe("page");
    if (head.kind !== "page") throw new Error("missing initial cursor");
    const publication = JSON.parse(
      readFileSync("src/gateway/legacy-external-publication.fixture.json", "utf8"),
    );
    await appendTranscriptMessage(scope, { eventId: "legacy-external", message: publication });
    const replay = await appendTranscriptMessage(scope, {
      eventId: "legacy-external",
      message: publication,
    });
    expect(replay).toMatchObject({ appended: false, messageId: "legacy-external" });
    await waitForSessionTranscriptProjection(scope);
    const delta = await readChatHistoryDelta({
      agentId: "main",
      cursor: head.cursor,
      scope,
      sessionKey: scope.sessionKey,
      sessionSnapshot: {},
    });
    expect(delta.kind).toBe("delta");
    if (delta.kind !== "delta") throw new Error("unexpected delta reset");
    expect(JSON.stringify(delta.messages)).toContain("Frozen external publication");
    const page = await readChatHistoryPage({
      entry,
      provider: undefined,
      sessionId: scope.sessionId,
      storePath: scope.storePath,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: 1,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 8000,
      offset: undefined,
      messageId: "legacy-external",
    });
    expect(page.messages).toHaveLength(1);
    expect(JSON.stringify(page.messages)).toContain("Frozen external publication");
    await appendTranscriptMessage(scope, {
      eventId: "second-publication",
      message: { ...publication, idempotencyKey: "another-delivery" },
    });
    await waitForSessionTranscriptProjection(scope);
    const base = {
      entry,
      provider: undefined,
      sessionId: scope.sessionId,
      storePath: scope.storePath,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: 1,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 8000,
      messageId: undefined,
    };
    const newer = await readChatHistoryPage({ ...base, offset: 0 });
    const older = await readChatHistoryPage({ ...base, offset: 1 });
    expect(newer.messages).toHaveLength(1);
    expect(older.messages).toHaveLength(1);
    expect(
      JSON.stringify([...newer.messages, ...older.messages]).match(/Frozen external publication/g),
    ).toHaveLength(2);
  });
});
