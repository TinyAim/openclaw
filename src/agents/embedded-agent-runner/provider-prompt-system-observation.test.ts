import { createHash } from "node:crypto";
import { responsesPromptObserver } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithProviderPromptState } from "./provider-prompt-state.js";

const expected = "PRIVATE synthetic context 中文";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function observe(params: {
  api: string;
  payload: unknown;
  expectedExtraSystemPrompt?: string;
  onPayload?: NonNullable<Parameters<StreamFn>[2]>["onPayload"];
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
}) {
  const model = { id: "model-1", provider: "test", api: params.api } as Model;
  const recordEvent = params.recordEvent ?? vi.fn();
  let sent: unknown;
  const wrapped = wrapStreamFnWithProviderPromptState({
    streamFn: async (_model, _context, options) => {
      const replacement = await options?.onPayload?.(params.payload, model);
      sent = replacement === undefined ? params.payload : replacement;
      return createAssistantMessageEventStream();
    },
    state: {},
    effectiveContextTokenBudget: 128_000,
    expectedExtraSystemPrompt: params.expectedExtraSystemPrompt,
    recordEvent,
  });
  await wrapped(
    model,
    { systemPrompt: expected, messages: [], tools: [] },
    {
      onPayload: params.onPayload,
    },
  );
  return { recordEvent, sent };
}

describe("final provider system observation", () => {
  it.each([
    { api: "ollama", payload: { messages: [{ role: "system", content: expected }] } },
    { api: "openai-completions", payload: { messages: [{ role: "system", content: expected }] } },
    {
      api: "openai-completions",
      payload: { messages: [{ role: "developer", content: [{ type: "text", text: expected }] }] },
    },
    { api: "openai-responses", payload: { instructions: expected, input: "question" } },
    {
      api: "openai-responses",
      payload: {
        input: [{ role: "developer", content: [{ type: "input_text", text: expected }] }],
      },
    },
    { api: "anthropic-messages", payload: { system: expected, messages: [] } },
    {
      api: "anthropic-messages",
      payload: {
        system: [{ type: "text", text: expected, cache_control: { type: "ephemeral" } }],
        messages: [],
      },
    },
  ])("observes $api text without retaining it", async ({ api, payload }) => {
    const { recordEvent, sent } = await observe({
      api,
      payload,
      expectedExtraSystemPrompt: expected,
    });
    expect(recordEvent).toHaveBeenCalledWith(
      "provider.prompt.system_observed",
      expect.objectContaining({
        systemState: "present",
        systemChars: expected.length,
        systemUtf8Bytes: Buffer.byteLength(expected, "utf8"),
        systemDigestSha256: hash(expected),
        systemTextPartCount: 1,
        expectedExtraSystemPromptChars: expected.length,
        expectedExtraSystemPromptUtf8Bytes: Buffer.byteLength(expected, "utf8"),
        expectedExtraSystemPromptDigestSha256: hash(expected),
        wireContainsExpectedExtraSystemPrompt: true,
      }),
    );
    expect(JSON.stringify(vi.mocked(recordEvent).mock.calls)).not.toContain(expected);
    expect(sent).toBe(payload);
  });

  it("preserves text part order without inventing a match across block boundaries", async () => {
    const parts = ["prefix", expected.slice(0, 8), expected.slice(8)];
    const { recordEvent } = await observe({
      api: "anthropic-messages",
      payload: { system: parts.map((text) => ({ type: "text", text })), messages: [] },
      expectedExtraSystemPrompt: expected,
    });
    expect(recordEvent).toHaveBeenCalledWith(
      "provider.prompt.system_observed",
      expect.objectContaining({
        systemState: "present",
        systemDigestSha256: hash(parts.join("")),
        systemTextPartCount: 3,
        wireContainsExpectedExtraSystemPrompt: false,
      }),
    );
  });

  it.each([
    { api: "ollama", payload: { messages: [{ role: "user", content: expected }] } },
    { api: "openai-responses", payload: { input: "question" } },
    { api: "anthropic-messages", payload: { messages: [] } },
  ])(
    "reports absent $api system context without borrowing the pre-conversion context",
    async ({ api, payload }) => {
      const { recordEvent } = await observe({ api, payload, expectedExtraSystemPrompt: expected });
      expect(recordEvent).toHaveBeenCalledWith(
        "provider.prompt.system_observed",
        expect.objectContaining({
          systemState: "absent",
          systemChars: 0,
          systemDigestSha256: hash(""),
          wireContainsExpectedExtraSystemPrompt: false,
        }),
      );
    },
  );

  it.each([
    { api: "custom-api", payload: { messages: [{ role: "system", content: expected }] } },
    { api: "ollama", payload: { unrelated: expected } },
    {
      api: "openai-completions",
      payload: { messages: [{ role: "developer", content: [{ type: "image", text: expected }] }] },
    },
    {
      api: "anthropic-messages",
      payload: {
        system: [
          { type: "text", text: expected },
          { type: "unknown", text: expected },
        ],
        messages: [],
      },
    },
    { api: "openai-responses", payload: { instructions: { text: expected }, input: [] } },
    {
      api: "ollama",
      payload: { messages: [{ role: "system", content: [{ type: "text", text: expected }] }] },
    },
    {
      api: "anthropic-messages",
      payload: { system: [{ type: "input_text", text: expected }], messages: [] },
    },
    {
      api: "openai-responses",
      payload: { instructions: [{ type: "text", text: expected }], input: [] },
    },
    {
      api: "openai-responses",
      payload: { input: [{ role: "developer", content: [{ type: "text", text: expected }] }] },
    },
    {
      api: "openai-completions",
      payload: {
        messages: [{ role: "system", content: [{ type: "input_text", text: expected }] }],
      },
    },
  ])("keeps unsupported $api shapes unknown", async ({ api, payload }) => {
    const { recordEvent } = await observe({ api, payload, expectedExtraSystemPrompt: expected });
    expect(recordEvent).toHaveBeenCalledWith(
      "provider.prompt.system_observed",
      expect.objectContaining({
        systemState: "unknown",
        systemChars: null,
        systemDigestSha256: null,
        wireContainsExpectedExtraSystemPrompt: null,
      }),
    );
  });

  it.each([undefined, ""])(
    "does not treat absent expected context as a successful empty-string match",
    async (value) => {
      const { recordEvent } = await observe({
        api: "ollama",
        payload: { messages: [{ role: "system", content: expected }] },
        expectedExtraSystemPrompt: value,
      });
      expect(recordEvent).toHaveBeenCalledWith(
        "provider.prompt.system_observed",
        expect.objectContaining({
          expectedExtraSystemPromptChars: 0,
          expectedExtraSystemPromptDigestSha256: null,
          wireContainsExpectedExtraSystemPrompt: null,
        }),
      );
    },
  );

  it.each([true, false])(
    "observes the asynchronous replacement body (contains=%s)",
    async (contains) => {
      const replacement = {
        messages: [{ role: "system", content: contains ? expected : "replacement" }],
      };
      const { recordEvent, sent } = await observe({
        api: "ollama",
        payload: { messages: [{ role: "system", content: contains ? "initial" : expected }] },
        expectedExtraSystemPrompt: expected,
        onPayload: async () => replacement,
      });
      expect(recordEvent).toHaveBeenCalledWith(
        "provider.prompt.system_observed",
        expect.objectContaining({
          systemDigestSha256: hash(replacement.messages[0].content),
          wireContainsExpectedExtraSystemPrompt: contains,
        }),
      );
      expect(sent).toBe(replacement);
    },
  );

  it("does not let a diagnostic callback change the final request", async () => {
    const payload = { instructions: expected, input: "question" };
    const recordEvent = vi.fn(() => {
      throw new Error("diagnostics unavailable");
    });
    const { sent } = await observe({
      api: "openai-responses",
      payload,
      recordEvent,
      expectedExtraSystemPrompt: expected,
    });
    expect(recordEvent).toHaveBeenCalled();
    expect(sent).toBe(payload);
  });

  it("preserves a real payload-hook failure instead of swallowing it as diagnostic failure", async () => {
    const failure = new Error("payload hook failed");
    const recordEvent = vi.fn();
    await expect(
      observe({
        api: "ollama",
        payload: { messages: [] },
        recordEvent,
        expectedExtraSystemPrompt: expected,
        onPayload: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("keeps the existing Responses observer best-effort when its diagnostic sink throws", async () => {
    const model = { id: "model-1", provider: "openai", api: "openai-responses" } as Model;
    const recordEvent = vi.fn(() => {
      throw new Error("diagnostics unavailable");
    });
    const payload = { instructions: expected, input: "question" };
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, _context, options) => {
        expect(await options?.onPayload?.(payload, model)).toBe(payload);
        responsesPromptObserver.get(options!)?.({
          egress: "responses-sdk",
          payloadVariant: "initial",
          promptSource: "instructions",
          expectedChars: expected.length,
          observedChars: expected.length,
          matchesAssembledPrompt: true,
        });
        return createAssistantMessageEventStream();
      },
      state: {},
      effectiveContextTokenBudget: 128_000,
      recordEvent,
      expectedExtraSystemPrompt: expected,
    });
    await wrapped(model, { systemPrompt: expected, messages: [] });
    expect(recordEvent).toHaveBeenCalledTimes(2);
  });
});
