import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

it("keeps the frozen legacy publication inside its process-held incognito session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "legacy-incognito",
      sessionKey: "agent:main:dashboard:legacy-incognito",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    };
    const publication = JSON.parse(
      readFileSync("src/gateway/legacy-private-publication.fixture.json", "utf8"),
    );
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1, incognito: true });
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId },
      { type: "message", id: "legacy-private", parentId: null, message: publication },
    ]);
    const privateRead = await readSessionMessageByIdAsync(scope, "legacy-private");
    expect(privateRead.found && projectChatDisplayMessage(privateRead.message)).toMatchObject({
      content: [{ type: "text", text: "Frozen owner publication" }],
    });
    const ordinary = {
      agentId: "main",
      sessionId: "other",
      sessionKey: "agent:main:other",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    expect(
      await readSessionMessageByIdAsync(ordinary, "legacy-private", { currentOnly: true }),
    ).toMatchObject({ found: false });
  });
});
