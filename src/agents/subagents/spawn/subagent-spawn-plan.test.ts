import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSubagentModelAndThinkingPlan } from "./subagent-spawn-plan.js";

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
  ])("selects $expected with source $source", ({ expected, source, ...context }) => {
    const plan = resolveSubagentModelAndThinkingPlan({ cfg, targetAgentId: "worker", ...context });
    expect(plan.status).toBe("ok");
    expect(plan.resolvedModel).toBe(expected);
    if (plan.status === "ok") {
      expect(plan.initialSessionPatch.modelOverrideSource).toBe(source);
    }
  });
});
