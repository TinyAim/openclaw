import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenClawAgentFilesAdapter,
  OpenClawAgentFileWriteConflictError,
} from "../../../../../../../services/openclaw_adapter/src/runtime/agent-files.adapter.ts";
import { agentsHandlers } from "./agents.js";

describe("candidate agents.files and Wisclaw Adapter compatibility", () => {
  it("round-trips null and hash preconditions without leaking the workspace or overwriting a conflict", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openclaw-adapter-files-"));
    try {
      const request = async (method: string, params: unknown) => {
        if (method !== "agents.files.get" && method !== "agents.files.set")
          throw new Error("unexpected method");
        let response:
          | { ok: boolean; payload?: unknown; error?: { message?: string; details?: unknown } }
          | undefined;
        await agentsHandlers[method]!({
          req: { type: "req", id: "fixture", method, params: {} },
          params: params as Record<string, unknown>,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            response = { ok, payload, error };
          },
          context: { getRuntimeConfig: () => ({ agents: { defaults: { workspace } } }) } as never,
        });
        if (!response) throw new Error("gateway returned no response");
        if (!response.ok)
          throw Object.assign(new Error(response.error?.message ?? "gateway error"), {
            details: response.error?.details,
          });
        return response.payload;
      };
      const adapter = createOpenClawAgentFilesAdapter({
        connectionManager: {
          request: request as never,
          subscribe: () => () => {},
          disconnect: async () => {},
        },
      });
      const first = await adapter.setFile({
        agentId: "main",
        name: "MEMORY.md",
        content: "first",
        expectedHash: null,
      });
      const expected = createHash("sha256").update("first").digest("hex");
      expect(first).toMatchObject({ ok: true, contentHash: expected });
      const read = await adapter.getFile({ agentId: "main", name: "MEMORY.md" });
      expect(read).toMatchObject({
        existed: true,
        content: "first",
        contentHash: expected,
        displayRelPath: "MEMORY.md",
      });
      expect(JSON.stringify(read)).not.toContain(workspace);
      await expect(
        adapter.setFile({
          agentId: "main",
          name: "MEMORY.md",
          content: "wrong",
          expectedHash: null,
        }),
      ).rejects.toBeInstanceOf(OpenClawAgentFileWriteConflictError);
      expect(await readFile(path.join(workspace, "MEMORY.md"), "utf8")).toBe("first");
      const second = await adapter.setFile({
        agentId: "main",
        name: "MEMORY.md",
        content: "second",
        expectedHash: expected,
      });
      expect(second).toMatchObject({
        ok: true,
        contentHash: createHash("sha256").update("second").digest("hex"),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
