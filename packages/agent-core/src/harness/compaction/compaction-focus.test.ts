import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { compact } from "./compaction.js";
import { createFileOps } from "./utils.js";

function createSummaryModel(reasoning = false): Model {
  return {
    id: "summary-model",
    name: "Summary Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
}

function createUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextUsage: { state: "available", promptTokens: totalTokens, totalTokens },
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(text: string, usage: Usage, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp,
  };
}

describe("split-turn compaction with previous history", () => {
  const operatorFocus = "Preserve API decisions.";
  it.each([
    { name: "explicit focus", focus: operatorFocus, refreshHistory: true },
    { name: "omitted focus", focus: undefined, refreshHistory: false },
    { name: "empty focus", focus: "", refreshHistory: false },
    { name: "blank focus", focus: " \n\t ", refreshHistory: false },
  ])(
    "applies $name to a previous summary with only a split-turn prefix",
    async ({ focus, refreshHistory }) => {
      const previousSummary = "Earlier assistant claimed a generic assignment.";
      const prefixMessages: AgentMessage[] = [
        { role: "user", content: "Describe the current assignment.", timestamp: 2 },
      ];
      const preparation = {
        firstKeptEntryId: "retained-assistant-entry",
        messagesToSummarize: [],
        turnPrefixMessages: prefixMessages,
        isSplitTurn: true,
        previousSummary,
        tokensBefore: 100,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      };
      const originalPreparation = structuredClone(preparation);
      const prompts: string[] = [];
      const streamFn = vi.fn<StreamFn>((_model, context) => {
        prompts.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        const text = refreshHistory && prompts.length === 1 ? "Updated history." : "Turn context.";
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistant(text, createUsage(1), 3),
        });
        stream.end();
        return stream;
      });
      const result = await compact(
        preparation,
        createSummaryModel(),
        undefined,
        undefined,
        focus,
        undefined,
        undefined,
        streamFn,
      );

      expect(result.ok).toBe(true);
      expect(prompts).toHaveLength(refreshHistory ? 2 : 1);
      expect(preparation).toEqual(originalPreparation);
      if (refreshHistory) {
        expect(prompts[0]).toContain(previousSummary);
        expect(prompts[0]).toContain("<previous-summary>");
        expect(prompts[0]).toContain(operatorFocus);
        expect(prompts[1]).toContain(operatorFocus);
      } else {
        expect(prompts[0]).not.toContain(previousSummary);
      }
      if (result.ok) {
        expect(result.value.firstKeptEntryId).toBe("retained-assistant-entry");
        expect(result.value.summary).toContain(
          refreshHistory ? "Updated history." : previousSummary,
        );
        expect(result.value.summary).toContain("Turn context.");
      }
    },
  );
});
