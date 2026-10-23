import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import { responsesPromptObserver } from "@openclaw/ai/internal/openai";
import { asOptionalRecord, stableStringify } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type ProviderPromptSnapshot = {
  scopeDigest: string;
  digest: string;
  byteWeight: number;
};

export type ProviderPromptState = {
  lastAttempt?: ProviderPromptSnapshot;
  lastRejected?: ProviderPromptSnapshot;
};

const PROVIDER_PROMPT_STATES_KEY = Symbol.for("openclaw.providerPromptStates");
const providerPromptStates = resolveGlobalSingleton(
  PROVIDER_PROMPT_STATES_KEY,
  () => new Map<string, ProviderPromptState>(),
);

const digest = (serialized: string) => crypto.createHash("sha256").update(serialized).digest("hex");

/** Returns run-local retry state; restarts and new run ids intentionally have no baseline. */
export function getProviderPromptState(runId: string): ProviderPromptState {
  const state = providerPromptStates.get(runId) ?? {};
  providerPromptStates.set(runId, state);
  return state;
}

export function clearProviderPromptState(runId: string): void {
  providerPromptStates.delete(runId);
}

/** Captures the final provider request identity without retaining payload content. */
function snapshotProviderPrompt(params: {
  model: Model;
  payload: unknown;
  effectiveContextTokenBudget: number;
}): ProviderPromptSnapshot {
  const scope = stableStringify({
    provider: params.model.provider,
    api: params.model.api,
    model: params.model.id,
    baseUrl: params.model.baseUrl,
    effectiveContextTokenBudget: params.effectiveContextTokenBudget,
  });
  const serialized = stableStringify(params.payload);
  return {
    scopeDigest: digest(scope),
    digest: digest(serialized),
    byteWeight: Buffer.byteLength(serialized),
  };
}

/** Rejects only an exact replay of the last provider-rejected request body. */
function assertProviderPromptRetryProgress(
  state: ProviderPromptState,
  candidate: ProviderPromptSnapshot,
): void {
  const rejected = state.lastRejected;
  if (rejected?.scopeDigest === candidate.scopeDigest && rejected.digest === candidate.digest) {
    throw new Error(
      "Context overflow: refusing to resend the byte-identical provider payload after a " +
        `context rejection (payloadBytes=${candidate.byteWeight}).`,
    );
  }
}

export function markLastProviderPromptContextRejected(
  state: ProviderPromptState,
): ProviderPromptSnapshot | undefined {
  const attempted = state.lastAttempt;
  if (attempted) {
    state.lastRejected = attempted;
  }
  return attempted;
}

function textParts(value: unknown, blockType?: "text" | "input_text"): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (!blockType || !Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const valuePart of value) {
    const part = asOptionalRecord(valuePart);
    if (!part || part.type !== blockType || typeof part.text !== "string") {
      return undefined;
    }
    parts.push(part.text);
  }
  return parts;
}

function messageSystemParts(
  value: unknown,
  blockType?: "text" | "input_text",
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const valueMessage of value) {
    const message = asOptionalRecord(valueMessage);
    if (!message) {
      return undefined;
    }
    if (message.role !== "system" && message.role !== "developer") {
      continue;
    }
    const content = textParts(message.content, blockType);
    if (!content) {
      return undefined;
    }
    parts.push(...content);
  }
  return parts;
}

/** Inspect supported wire text only; never substitute the pre-conversion Context. */
function providerSystemObservation(api: string, payload: unknown, expected?: string) {
  const body = asOptionalRecord(payload);
  let parts: string[] | undefined;
  let shape: "messages" | "responses" | "anthropic_system" | "unknown" = "unknown";
  if (body && (api === "ollama" || api === "openai-completions")) {
    shape = "messages";
    parts = messageSystemParts(body.messages, api === "openai-completions" ? "text" : undefined);
  } else if (
    body &&
    (api === "openai-responses" ||
      api === "openai-codex-responses" ||
      api === "azure-openai-responses")
  ) {
    shape = "responses";
    const instructions = body.instructions === undefined ? [] : textParts(body.instructions);
    const input =
      typeof body.input === "string" ? [] : messageSystemParts(body.input, "input_text");
    if (instructions && (input || (body.input === undefined && body.instructions !== undefined))) {
      parts = [...instructions, ...(input ?? [])];
    }
  } else if (body && api === "anthropic-messages") {
    shape = "anthropic_system";
    parts =
      body.system === undefined
        ? Array.isArray(body.messages)
          ? []
          : undefined
        : textParts(body.system, "text");
  }
  const hasExpected = typeof expected === "string" && expected.length > 0;
  const systemHash = crypto.createHash("sha256");
  let chars = 0;
  let bytes = 0;
  for (const part of parts ?? []) {
    chars += part.length;
    bytes += Buffer.byteLength(part, "utf8");
    // Hash raw UTF-8 text in wire order without fabricated separators.
    systemHash.update(part, "utf8");
  }
  return {
    systemShape: shape,
    systemState: parts === undefined ? "unknown" : chars > 0 ? "present" : "absent",
    systemChars: parts === undefined ? null : chars,
    systemUtf8Bytes: parts === undefined ? null : bytes,
    systemTextPartCount: parts === undefined ? null : parts.length,
    systemDigestSha256: parts === undefined ? null : systemHash.digest("hex"),
    expectedExtraSystemPromptChars: hasExpected ? expected.length : 0,
    expectedExtraSystemPromptUtf8Bytes: hasExpected ? Buffer.byteLength(expected, "utf8") : 0,
    expectedExtraSystemPromptDigestSha256: hasExpected ? digest(expected) : null,
    // A match must occur within an actual wire text part, never across joined blocks.
    wireContainsExpectedExtraSystemPrompt:
      parts === undefined || !hasExpected ? null : parts.some((part) => part.includes(expected)),
  };
}

/** Hashes the post-onPayload body for context-retry admission. */
export function wrapStreamFnWithProviderPromptState(params: {
  streamFn: StreamFn;
  state: ProviderPromptState;
  effectiveContextTokenBudget: number;
  expectedExtraSystemPrompt?: string;
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
}): StreamFn {
  return async (model, context, options) => {
    params.state.lastAttempt = undefined; // Custom transports must not leave a stale candidate.
    const originalOnPayload = options?.onPayload;
    const observedOptions: NonNullable<Parameters<StreamFn>[2]> = {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement === undefined ? payload : replacement;
        const snapshot = snapshotProviderPrompt({
          model: payloadModel,
          payload: finalPayload,
          effectiveContextTokenBudget: params.effectiveContextTokenBudget,
        });
        assertProviderPromptRetryProgress(params.state, snapshot);
        params.state.lastAttempt = snapshot;
        if (params.recordEvent) {
          try {
            params.recordEvent(
              "provider.prompt.system_observed",
              providerSystemObservation(
                payloadModel.api,
                finalPayload,
                params.expectedExtraSystemPrompt,
              ),
            );
          } catch {
            // Best-effort diagnostics cannot change the provider request or its failure.
          }
        }
        return finalPayload;
      },
    };
    if (params.recordEvent) {
      responsesPromptObserver.set(observedOptions, (observation) => {
        try {
          params.recordEvent?.("provider.prompt.observed", { ...observation });
        } catch {
          // Provider acceptance must not depend on the diagnostic sink.
        }
      });
    }
    return params.streamFn(model, context, observedOptions);
  };
}
