import { expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  chatSendOwner,
  setupPersistentSessionCreateTestHarness,
} from "./server.sessions.create.test-support.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupPersistentSessionCreateTestHarness();

test("sessions.create carries trusted fallback restriction only into its initial turn", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:trusted-initial-fence";
  const send = vi
    .spyOn(chatSendOwner, "handleDirectExternalChatSend")
    .mockImplementation(async (options) => {
      expect(options.client?.internal?.disableModelFallbacks).toBe(true);
      options.respond(true, { runId: "initial-run", status: "started" });
    });
  try {
    const client = {
      connect: { scopes: ["operator.admin"] },
      internal: { disableModelFallbacks: true },
    } as never;
    const created = await directSessionReq<{ runStarted: boolean }>(
      "sessions.create",
      { agentId: "main", key, task: "Inspect the task" },
      { client },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.runStarted).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey: key, storePath })).not.toHaveProperty(
      "disableModelFallbacks",
    );
    const spoof = await directSessionReq("sessions.create", {
      agentId: "main",
      key: `${key}-spoof`,
      task: "untrusted",
      disableModelFallbacks: true,
    });
    expect(spoof.ok).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  } finally {
    send.mockRestore();
  }
});
