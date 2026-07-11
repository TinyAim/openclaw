import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { subagentsHandlers } from "./subagents.js";

const executeMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("../../agents/tools/subagents-tool.js", () => ({
  createSubagentsTool: vi.fn((opts?: { agentSessionKey?: string }) => ({
    name: "subagents",
    execute: (toolCallId: string, args: Record<string, unknown>) =>
      executeMock(opts?.agentSessionKey, toolCallId, args),
  })),
}));

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (
    params: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => spawnMock(params, ctx),
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvoke(method: keyof typeof subagentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await subagentsHandlers[method]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method: method as string },
        isWebchatConnect: () => false,
      }),
  };
}

describe("subagents gateway handlers", () => {
  beforeEach(() => {
    executeMock.mockReset();
    spawnMock.mockReset();
  });

  it("subagents.list rejects missing requesterSessionKey", async () => {
    const { respond, invoke } = createInvoke("subagents.list", {});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("subagents.list delegates to the subagents tool scoped to the requester", async () => {
    executeMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      details: { status: "ok", action: "list", active: [], recent: [] },
    });
    const { respond, invoke } = createInvoke("subagents.list", {
      requesterSessionKey: "agent:main:main",
      recentMinutes: 45,
    });
    await invoke();
    expect(executeMock).toHaveBeenCalledWith(
      "agent:main:main",
      expect.any(String),
      { action: "list", recentMinutes: 45 },
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ status: "ok", action: "list" });
  });

  it("subagents.kill delegates target resolution to the subagents tool", async () => {
    executeMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      details: { status: "ok", action: "kill", target: "run-1" },
    });
    const { respond, invoke } = createInvoke("subagents.kill", {
      requesterSessionKey: "agent:main:main",
      target: "run-1",
    });
    await invoke();
    expect(executeMock).toHaveBeenCalledWith(
      "agent:main:main",
      expect.any(String),
      { action: "kill", target: "run-1" },
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ status: "ok", action: "kill" });
  });

  it("subagents.spawn forwards explicit taskClass and requester context", async () => {
    spawnMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:abc",
      runId: "run-abc",
      mode: "run",
    });
    const { respond, invoke } = createInvoke("subagents.spawn", {
      requesterSessionKey: "agent:main:main",
      task: "review the diff",
      label: "代码检查",
      taskClass: "code-script",
    });
    await invoke();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "review the diff",
        label: "代码检查",
        taskClass: "code-script",
        cleanup: "keep",
        sandbox: "inherit",
        expectsCompletionMessage: true,
      }),
      { agentSessionKey: "agent:main:main" },
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:subagent:abc",
    });
  });

  it("subagents.spawn surfaces spawn failures as gateway errors", async () => {
    spawnMock.mockRejectedValue(new Error("boom"));
    const { respond, invoke } = createInvoke("subagents.spawn", {
      requesterSessionKey: "agent:main:main",
      task: "review the diff",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toContain("subagents.spawn failed");
  });
});
