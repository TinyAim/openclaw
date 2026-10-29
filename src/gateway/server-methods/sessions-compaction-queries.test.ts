import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDirectSessionReadMethod } from "../session-method-policy.js";
import { resolveDirectSessionTargets } from "../session-sharing-target-input.js";
import { sessionCheckpointQueryHandlers } from "./sessions-compaction-queries.js";
import type { GatewayRequestContext } from "./types.js";

const state = vi.hoisted(() => ({ entry: undefined as unknown, agent: "main" }));
vi.mock("../session-request-agent.js", () => ({
  resolveRequestedSessionAgentId: (_cfg: unknown, _key: string, agentId?: string) => ({
    ok: true,
    agentId: agentId ?? "main",
  }),
}));
vi.mock("./sessions-shared.js", () => ({
  requireSessionKey: (key: string) => key,
  loadAccessorSessionEntryForGatewayTarget: ({ agentId }: { agentId: string }) => {
    state.agent = agentId;
    return { canonicalKey: `agent:${agentId}:main`, entry: state.entry };
  },
}));
const checkpoint = {
  checkpointId: "one",
  sessionKey: "agent:other:main",
  sessionId: "session",
  createdAt: 1,
  reason: "manual",
  preCompaction: { sessionId: "session" },
  postCompaction: { sessionId: "session" },
};
function invoke(params: Record<string, unknown>) {
  const respond = vi.fn();
  sessionCheckpointQueryHandlers["sessions.compaction.list"]!({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
  } as never);
  return respond;
}
describe("checkpoint list read", () => {
  beforeEach(() => {
    state.entry = { compactionCheckpoints: [checkpoint] };
  });
  it("resolves the requested agent and returns the matching validated records", () => {
    const respond = invoke({ key: "main", agentId: "other" });
    expect(state.agent).toBe("other");
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, key: "agent:other:main", checkpoints: [checkpoint] },
      undefined,
    );
  });
  it("rejects corrupt or duplicate records instead of hiding them", () => {
    state.entry = { compactionCheckpoints: [checkpoint, checkpoint] };
    expect(invoke({ key: "main" }).mock.calls[0]?.[0]).toBe(false);
    state.entry = { compactionCheckpoints: [{ ...checkpoint, preCompaction: null }] };
    expect(invoke({ key: "main" }).mock.calls[0]?.[0]).toBe(false);
  });
  it("rejects a stored checkpoint bound to a different session key", () => {
    state.entry = { compactionCheckpoints: [checkpoint] };
    expect(invoke({ key: "main", agentId: "main" }).mock.calls[0]?.[0]).toBe(false);
  });
  it("classifies this method as a direct session-scoped read", () => {
    expect(isDirectSessionReadMethod("sessions.compaction.list")).toBe(true);
    expect(
      resolveDirectSessionTargets("sessions.compaction.list", { key: "main", agentId: "other" }),
    ).toEqual([{ sessionKey: "main", agentId: "other" }]);
  });
});
