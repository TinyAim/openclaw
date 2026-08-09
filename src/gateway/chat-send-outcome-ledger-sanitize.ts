const MAX_OUTPUT_TEXT_BYTES = 128 * 1024;
const MAX_CONTENT_PARTS = 32;
const PUBLIC_ERROR_SUMMARY = "chat send failed";

export type DurableChatTerminalInput = {
  status: "ok" | "error" | "aborted";
  message?: unknown;
  stopReason?: string;
  errorMessage?: string;
};

export type SanitizedDurableChatTerminal = {
  ok: boolean;
  payload: Record<string, unknown>;
  errorMessage?: string;
};

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return { value: output, truncated: true };
}

function sanitizeUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["input", "output", "totalTokens", "inputTokens", "outputTokens"]) {
    const item = source[key];
    if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
  }
  for (const key of ["model", "provider"]) {
    const item = boundedString(source[key], 256);
    if (item) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeMessage(value: unknown): {
  message?: Record<string, unknown>;
  truncated: boolean;
} {
  if (!value || typeof value !== "object") return { truncated: false };
  const source = value as Record<string, unknown>;
  let remaining = MAX_OUTPUT_TEXT_BYTES;
  let truncated = false;
  const content = Array.isArray(source.content)
    ? source.content.slice(0, MAX_CONTENT_PARTS).flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const typed = part as Record<string, unknown>;
        if (typed.type !== "text" || typeof typed.text !== "string") return [];
        const bounded = boundedUtf8(typed.text, remaining);
        if (bounded.truncated) truncated = true;
        remaining -= Buffer.byteLength(bounded.value, "utf8");
        return bounded.value ? [{ type: "text", text: bounded.value }] : [];
      })
    : typeof source.text === "string"
      ? (() => {
          const bounded = boundedUtf8(source.text, remaining);
          if (bounded.truncated) truncated = true;
          return bounded.value ? [{ type: "text", text: bounded.value }] : [];
        })()
      : [];
  if (Array.isArray(source.content) && source.content.length > MAX_CONTENT_PARTS) truncated = true;
  const message: Record<string, unknown> = {
    role: "assistant",
    ...(content.length > 0 ? { content } : {}),
  };
  if (typeof source.timestamp === "number" && Number.isFinite(source.timestamp)) {
    message.timestamp = source.timestamp;
  }
  const stopReason = boundedString(source.stopReason, 128);
  if (stopReason) message.stopReason = stopReason;
  const usage = sanitizeUsage(source.usage);
  if (usage) message.usage = usage;
  return { message, truncated };
}

export function sanitizeDurableChatTerminal(
  input: DurableChatTerminalInput,
): SanitizedDurableChatTerminal {
  const sanitized =
    input.status === "error" ? { truncated: false } : sanitizeMessage(input.message);
  const errorMessage = input.status === "error" ? PUBLIC_ERROR_SUMMARY : undefined;
  const stopReason = boundedString(input.stopReason, 128);
  const payload: Record<string, unknown> = {
    status: input.status,
    ...(sanitized.message ? { message: sanitized.message } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { summary: errorMessage } : {}),
    ...(sanitized.truncated ? { outputTruncated: true } : {}),
  };
  return {
    ok: input.status !== "error",
    payload,
    ...(errorMessage ? { errorMessage } : {}),
  };
}
