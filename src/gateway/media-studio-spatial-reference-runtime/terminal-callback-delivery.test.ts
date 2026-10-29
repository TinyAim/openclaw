import { describe, expect, it } from "vitest";
import {
  createTerminalCallbackReplayBackoff,
  readTerminalCallbackResponse,
} from "./terminal-callback-delivery.js";

describe("Spatial terminal callback delivery policy", () => {
  it("accepts a normal Control API success envelope", async () => {
    await expect(
      readTerminalCallbackResponse(
        new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 }),
      ),
    ).resolves.toEqual({ disposition: "accepted" });
  });

  it("keeps an explicitly retryable settlement_busy 409 in the outbox", async () => {
    await expect(
      readTerminalCallbackResponse(
        new Response(
          JSON.stringify({
            success: false,
            code: "SPATIAL_ENV_PANORAMA_CALLBACK_RETRYABLE",
            message: "SPATIAL_ENV_PANORAMA_CALLBACK:settlement_busy",
            details: { retryable: true, callbackDisposition: "retry" },
          }),
          { status: 409 },
        ),
      ),
    ).rejects.toThrow("SPATIAL_ENV_PANORAMA_CALLBACK_RETRYABLE");
  });

  it("returns a terminal disposition for deterministic 409 conflict", async () => {
    await expect(
      readTerminalCallbackResponse(
        new Response(
          JSON.stringify({
            success: false,
            code: "SPATIAL_ENV_DEPTH_MESH_CALLBACK_TERMINAL_REJECTED",
            details: { retryable: false, callbackDisposition: "discard" },
          }),
          { status: 409 },
        ),
      ),
    ).resolves.toEqual({
      disposition: "terminal_rejection",
      code: "SPATIAL_ENV_DEPTH_MESH_CALLBACK_TERMINAL_REJECTED",
    });
  });

  it("keeps an unclassified 409 in the outbox instead of guessing terminal", async () => {
    await expect(
      readTerminalCallbackResponse(
        new Response(
          JSON.stringify({
            success: false,
            code: "SPATIAL_ENV_CALLBACK_CONFLICT",
          }),
          { status: 409 },
        ),
      ),
    ).rejects.toThrow("SPATIAL_ENV_CALLBACK_CONFLICT");
  });

  it("keeps malformed 4xx responses for replay unless Control API says discard", async () => {
    await expect(
      readTerminalCallbackResponse(new Response("not-json", { status: 400 })),
    ).rejects.toThrow("http_400");
  });

  it("backs retryable entries off exponentially with a bounded ceiling", () => {
    let now = 1_000;
    const backoff = createTerminalCallbackReplayBackoff({
      baseDelayMs: 250,
      maxDelayMs: 500,
      now: () => now,
    });
    expect(backoff.isDue("entry")).toBe(true);
    backoff.recordRetry("entry");
    expect(backoff.isDue("entry")).toBe(false);
    now += 250;
    expect(backoff.isDue("entry")).toBe(true);
    backoff.recordRetry("entry");
    now += 499;
    expect(backoff.isDue("entry")).toBe(false);
    now += 1;
    expect(backoff.isDue("entry")).toBe(true);
  });
});
