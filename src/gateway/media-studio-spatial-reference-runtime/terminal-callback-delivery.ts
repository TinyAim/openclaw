/** Shared callback acknowledgement and replay policy for Spatial executors. */

export type TerminalCallbackDeliveryResult =
  | { disposition: "accepted" }
  | { disposition: "terminal_rejection"; code: string };

type CallbackEnvelope<T> = {
  data?: T;
  code?: string;
  message?: string;
  details?: { retryable?: boolean; callbackDisposition?: string };
  /** Compatibility with older/non-Wisclaw error envelopes. */
  error?: { code?: string; message?: string };
};

function callbackErrorCode(raw: CallbackEnvelope<unknown> | null, status: number): string {
  return raw?.code?.trim() || raw?.error?.code?.trim() || `http_${status}`;
}

/**
 * Reads the Control API top-level envelope and separates terminal business
 * rejection from retryable transport/settlement failure. Retryable failures
 * throw so the durable outbox entry remains pending.
 */
export async function readTerminalCallbackResponse<T>(
  response: Response,
): Promise<TerminalCallbackDeliveryResult> {
  const raw = (await response.json().catch(() => null)) as CallbackEnvelope<T> | null;
  if (response.ok && raw?.data !== undefined) {
    return { disposition: "accepted" };
  }

  const code = callbackErrorCode(raw, response.status);
  const message = raw?.message ?? raw?.error?.message ?? "";
  const callbackDisposition = raw?.details?.callbackDisposition;
  const explicitlyRetryable =
    raw?.details?.retryable === true ||
    callbackDisposition === "retry" ||
    /_RETRYABLE$/i.test(code) ||
    /settlement_busy/i.test(message);
  // The owning Control API is the only authority that can classify an exact
  // identity/payload/fence conflict as terminal. HTTP status alone is not
  // sufficient: 409 is also used for settlement leases and an older/malformed
  // response must stay in the durable outbox rather than being lost.
  if (!explicitlyRetryable && callbackDisposition === "discard") {
    return { disposition: "terminal_rejection", code };
  }
  throw new Error(code);
}

export function createTerminalCallbackReplayBackoff(options: {
  baseDelayMs: number;
  maxDelayMs?: number;
  now?: () => number;
}) {
  const attempts = new Map<string, { count: number; nextAttemptAt: number }>();
  const now = options.now ?? Date.now;
  const baseDelayMs = Math.max(250, options.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 300_000);
  return {
    isDue(key: string): boolean {
      return (attempts.get(key)?.nextAttemptAt ?? 0) <= now();
    },
    recordRetry(key: string): void {
      const count = (attempts.get(key)?.count ?? 0) + 1;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(count - 1, 10));
      attempts.set(key, { count, nextAttemptAt: now() + delay });
    },
    clear(key: string): void {
      attempts.delete(key);
    },
  };
}
