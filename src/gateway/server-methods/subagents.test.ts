import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, subagentsHandlers } from "./subagents.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function options(
  method: string,
  params: Record<string, unknown>,
  respond = vi.fn(),
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as GatewayRequestHandlerOptions;
}

describe("operator subagents gateway methods", () => {
  afterEach(() => {
    __testing.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("advertises atomic hidden-context delivery and a digest receipt", async () => {
    const respond = vi.fn();

    await subagentsHandlers["subagents.capabilities"](
      options("subagents.capabilities", {}, respond),
    );

    expect(respond).toHaveBeenCalledWith(true, {
      spawn: expect.objectContaining({
        schemaVersion: "openclaw-subagent-spawn-capability/v3",
        hiddenSystemContextAtSpawn: true,
        hiddenSystemContextReceipt: "sha256",
      }),
    });
  });

  it("injects Project Context only into the initial child system prompt", async () => {
    const context = "# Project Context\n\nApproved facts only.";
    const spawnSubagentDirect = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:reviewer:subagent:child-1",
      runId: "run-child-1",
      mode: "session",
    });
    const runIdempotentOperatorSubagentSpawn = vi.fn(async (input) => input.spawn());
    __testing.setDepsForTest({
      spawnSubagentDirect,
      runIdempotentOperatorSubagentSpawn,
    });
    const respond = vi.fn();

    await subagentsHandlers["subagents.spawn"](
      options(
        "subagents.spawn",
        {
          idempotencyKey: "corr-project-context-spawn",
          requesterSessionKey: "agent:main:main",
          task: "Review the implementation",
          mode: "session",
          cleanup: "keep",
          hiddenSystemContext: context,
          threadBinding: {
            kind: "wisclaw_session_binding",
            reservationId: "reservation-1234567890",
          },
        },
        respond,
      ),
    );

    expect(spawnSubagentDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Review the implementation",
        operatorExtraSystemPrompt: context,
        operatorSessionBinding: {
          kind: "wisclaw_session_binding",
          reservationId: "reservation-1234567890",
        },
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    const payload = respond.mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      status: "accepted",
      hiddenSystemContextReceipt: {
        delivery: "agent.extraSystemPrompt",
        contentFingerprint: crypto.createHash("sha256").update(context).digest("hex"),
      },
    });
    expect(JSON.stringify(payload)).not.toContain("Approved facts only");
  });

  it("rejects an oversized hidden context before preparing or spawning", async () => {
    const spawnSubagentDirect = vi.fn();
    const runIdempotentOperatorSubagentSpawn = vi.fn();
    __testing.setDepsForTest({
      spawnSubagentDirect,
      runIdempotentOperatorSubagentSpawn,
    });
    const respond = vi.fn();

    await subagentsHandlers["subagents.spawn"](
      options(
        "subagents.spawn",
        {
          idempotencyKey: "corr-project-context-too-large",
          requesterSessionKey: "agent:main:main",
          task: "Review",
          hiddenSystemContext: "x".repeat(18_001),
        },
        respond,
      ),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/too long/i) }),
    );
    expect(runIdempotentOperatorSubagentSpawn).not.toHaveBeenCalled();
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });
});
