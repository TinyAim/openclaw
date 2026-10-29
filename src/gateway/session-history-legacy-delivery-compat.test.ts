import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  appendTranscriptEvent,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  projectChatDisplayMessage,
  projectChatDisplayMessages,
} from "./chat-display-projection.core.js";
import { readSessionHistorySnapshotAsync } from "./session-history-state.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

it("reads a legacy stored publication only in its active session and does not revive it after reset", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "legacy-delivery",
      sessionKey: "agent:main:legacy-delivery",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: scope.sessionId, updatedAt: 1 };
    const text = "Frozen owner publication";
    // Captured from the frozen old private source-reply owner in isolated test state.
    const publication = JSON.parse(
      readFileSync("src/gateway/legacy-private-publication.fixture.json", "utf8"),
    );
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      { type: "message", id: "legacy-row", parentId: null, message: publication },
    ]);
    await waitForSessionTranscriptProjection(scope);
    const history = await readSessionHistorySnapshotAsync({
      target: { ...scope, sessionEntry: entry },
      limit: 10,
    });
    expect(projectChatDisplayMessages(history.history.messages)).toContainEqual(
      expect.objectContaining({ content: [{ type: "text", text }] }),
    );
    const single = await readSessionMessageByIdAsync(scope, "legacy-row", { currentOnly: true });
    expect(single.found && projectChatDisplayMessage(single.message)).toMatchObject({
      content: [{ type: "text", text }],
    });
    const other = {
      ...scope,
      sessionId: "other-delivery",
      sessionKey: "agent:main:other-delivery",
    };
    expect(
      await readSessionMessageByIdAsync(other, "legacy-row", { currentOnly: true }),
    ).toMatchObject({ found: false });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-legacy",
      parentId: "legacy-row",
      reason: "new",
      timestamp: "2026-10-28T00:00:00.000Z",
    });
    await waitForSessionTranscriptProjection(scope);
    const reset = await readSessionHistorySnapshotAsync({
      target: { ...scope, sessionEntry: entry },
      limit: 10,
    });
    expect(JSON.stringify(reset.history.messages)).not.toContain(text);
    expect(
      await readSessionMessageByIdAsync(scope, "legacy-row", { currentOnly: true }),
    ).toMatchObject({ found: false });
  });
});
