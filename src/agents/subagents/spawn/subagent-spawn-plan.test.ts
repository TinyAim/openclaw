import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSubagentModelAndThinkingPlan } from "./subagent-spawn-plan.js";
import { prepareModelChoice } from "./subagent-spawn.runtime.js";

vi.mock("./subagent-spawn.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-spawn.runtime.js")>()),
  prepareModelChoice: vi.fn(
    async (input: { raw: string; resolvedRef?: { provider: string; model: string } }) => {
      const [provider, ...model] = input.raw.split("/");
      return {
        kind: "resolved",
        ref: input.resolvedRef ?? { provider, model: model.join("/") },
        model: {},
      };
    },
  ),
}));

const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-sol" },
      subagents: { model: "openai/gpt-5.6-luna" },
    },
    entries: { worker: { subagents: { model: "anthropic/claude-sonnet-4-6" } } },
  },
};

describe("native subagent model intent", () => {
  it.each([
    {
      requesterModelRef: "openai/gpt-5.4",
      modelOverride: undefined,
      expected: "openai/gpt-5.4",
      source: "auto",
    },
    {
      requesterModelRef: "openai/gpt-5.4",
      modelOverride: "openai/gpt-5.6-luna",
      expected: "openai/gpt-5.6-luna",
      source: "user",
    },
    {
      requesterModelRef: "anthropic/claude-opus-4-6",
      modelOverride: undefined,
      expected: "anthropic/claude-opus-4-6",
      source: "auto",
    },
    {
      requesterModelRef: undefined,
      modelOverride: undefined,
      expected: "anthropic/claude-sonnet-4-6",
      source: "auto",
    },
  ])("selects $expected with source $source", async ({ expected, source, ...context }) => {
    const plan = await resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentId: "worker",
      ...context,
    });
    expect(plan.status).toBe("ok");
    expect(plan.resolvedModel).toBe(expected);
    if (plan.status === "ok") {
      expect(plan.initialSessionPatch.modelOverrideSource).toBe(source);
    }
    if (context.requesterModelRef && !context.modelOverride) {
      expect(vi.mocked(prepareModelChoice).mock.lastCall?.[0].fallbacks).toEqual([]);
    }
  });

  it("rejects malformed inherited identities before model preparation", async () => {
    vi.mocked(prepareModelChoice).mockClear();
    const plan = await resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentId: "worker",
      requesterModelRef: "missing-provider",
    });
    expect(plan.status).toBe("error");
    expect(prepareModelChoice).not.toHaveBeenCalled();
  });

  it("keeps an explicit model independent of a stale inherited identity", async () => {
    const plan = await resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentId: "worker",
      requesterModelRef: "missing-provider",
      modelOverride: "openai/gpt-5.6-luna",
    });
    expect(plan.status).toBe("ok");
    expect(plan.resolvedModel).toBe("openai/gpt-5.6-luna");
  });
});
