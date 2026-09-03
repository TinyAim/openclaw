import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  claimDurableChatOutcome,
  markDurableChatRequestStarted,
  releaseDurableChatOutcomeBeforeStart,
  settleDurableChatOutcome,
} from "./chat-send-outcome-ledger.js";

describe("durable chat.send outcome ledger", () => {
  let stateDir = "";
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-outcome-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    __testing.resetMemory();
  });

  afterEach(() => {
    __testing.resetMemory();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists and replays a bounded terminal outcome across memory reset", async () => {
    const idempotencyKey = "task:dispatch:run-1";
    const request = { sessionKey: "agent:main:main", message: "private request body" };
    const claim = await claimDurableChatOutcome({
      idempotencyKey,
      request,
      durableOutcome: true,
    });
    expect(claim).toMatchObject({ kind: "dispatch" });
    if (claim.kind !== "dispatch") throw new Error("expected dispatch claim");

    await markDurableChatRequestStarted({
      idempotencyKey,
      fingerprint: claim.fingerprint,
    });
    await expect(
      claimDurableChatOutcome({ idempotencyKey, request, durableOutcome: true }),
    ).resolves.toMatchObject({ kind: "in_flight" });
    await settleDurableChatOutcome({
      runId: idempotencyKey,
      terminal: {
        status: "ok",
        message: { role: "assistant", text: "x".repeat(140 * 1024) },
      },
    });

    __testing.resetMemory();
    const replay = await claimDurableChatOutcome({
      idempotencyKey,
      request,
      durableOutcome: true,
    });
    expect(replay).toMatchObject({
      kind: "terminal",
      terminal: {
        ok: true,
        payload: { runId: idempotencyKey, status: "ok", outputTruncated: true },
      },
    });
    if (replay.kind !== "terminal") throw new Error("expected terminal replay");
    const content = (replay.terminal.payload.message as { content: Array<{ text: string }> })
      .content;
    expect(content[0]?.text).toHaveLength(128 * 1024);

    const persisted = fs.readFileSync(__testing.ledgerPath(), "utf8");
    expect(persisted).not.toContain(idempotencyKey);
    expect(persisted).not.toContain("private request body");
  });

  it("freezes a crash-left prepared claim as outcome_unknown after restart", async () => {
    const idempotencyKey = "task:dispatch:run-2";
    const request = { sessionKey: "agent:main:main", message: "hello" };
    await expect(
      claimDurableChatOutcome({ idempotencyKey, request, durableOutcome: true }),
    ).resolves.toMatchObject({ kind: "dispatch" });

    __testing.resetMemory();
    await expect(
      claimDurableChatOutcome({ idempotencyKey, request, durableOutcome: true }),
    ).resolves.toMatchObject({
      kind: "outcome_unknown",
      payload: { status: "outcome_unknown", errorCode: "gateway_restart_outcome_unknown" },
    });
  });

  it("freezes a started claim as outcome_unknown after restart", async () => {
    const idempotencyKey = "task:dispatch:run-3";
    const request = { sessionKey: "agent:main:main", message: "hello" };
    const claim = await claimDurableChatOutcome({
      idempotencyKey,
      request,
      durableOutcome: true,
    });
    if (claim.kind !== "dispatch") throw new Error("expected dispatch claim");
    await markDurableChatRequestStarted({
      idempotencyKey,
      fingerprint: claim.fingerprint,
    });

    __testing.resetMemory();
    await expect(
      claimDurableChatOutcome({ idempotencyKey, request, durableOutcome: true }),
    ).resolves.toMatchObject({ kind: "outcome_unknown" });
  });

  it("rejects reuse of a durable key with a different request fingerprint", async () => {
    const idempotencyKey = "task:dispatch:run-4";
    await claimDurableChatOutcome({
      idempotencyKey,
      request: { message: "first" },
      durableOutcome: true,
    });
    await expect(
      claimDurableChatOutcome({
        idempotencyKey,
        request: { message: "different" },
        durableOutcome: true,
      }),
    ).resolves.toMatchObject({
      kind: "idempotency_conflict",
      payload: { status: "idempotency_conflict", errorCode: "idempotency_key_reused" },
    });
  });

  it("can release an unstarted validation claim without leaving a tombstone", async () => {
    const idempotencyKey = "task:dispatch:run-5";
    const request = { message: "retry after validation" };
    const claim = await claimDurableChatOutcome({
      idempotencyKey,
      request,
      durableOutcome: true,
    });
    if (claim.kind !== "dispatch") throw new Error("expected dispatch claim");
    await expect(
      releaseDurableChatOutcomeBeforeStart({
        idempotencyKey,
        fingerprint: claim.fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      claimDurableChatOutcome({ idempotencyKey, request, durableOutcome: true }),
    ).resolves.toMatchObject({ kind: "dispatch" });
  });

  it("keeps opt-out traffic independent from a corrupt durable ledger", async () => {
    fs.mkdirSync(path.dirname(__testing.ledgerPath()), { recursive: true });
    fs.writeFileSync(__testing.ledgerPath(), "not-json", "utf8");

    await expect(
      claimDurableChatOutcome({
        idempotencyKey: "interactive-run",
        request: { message: "ordinary chat" },
        durableOutcome: false,
      }),
    ).resolves.toEqual({ kind: "disabled" });
    await expect(
      claimDurableChatOutcome({
        idempotencyKey: "durable-run",
        request: { message: "task dispatch" },
        durableOutcome: true,
      }),
    ).rejects.toThrow(/unreadable|invalid|shape/u);
  });

  it("bounds multibyte output by UTF-8 bytes and never persists raw error details", async () => {
    const okKey = "task:dispatch:utf8";
    const okRequest = { message: "utf8 output" };
    const okClaim = await claimDurableChatOutcome({
      idempotencyKey: okKey,
      request: okRequest,
      durableOutcome: true,
    });
    if (okClaim.kind !== "dispatch") throw new Error("expected dispatch claim");
    await markDurableChatRequestStarted({
      idempotencyKey: okKey,
      fingerprint: okClaim.fingerprint,
    });
    await settleDurableChatOutcome({
      runId: okKey,
      terminal: { status: "ok", message: { role: "assistant", text: "你".repeat(50_000) } },
    });
    __testing.resetMemory();
    const okReplay = await claimDurableChatOutcome({
      idempotencyKey: okKey,
      request: okRequest,
      durableOutcome: true,
    });
    if (okReplay.kind !== "terminal") throw new Error("expected terminal replay");
    const text = (okReplay.terminal.payload.message as { content: Array<{ text: string }> })
      .content[0]?.text;
    expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(okReplay.terminal.payload).toMatchObject({ outputTruncated: true });

    const errorKey = "task:dispatch:error";
    const errorRequest = { message: "error output" };
    const errorClaim = await claimDurableChatOutcome({
      idempotencyKey: errorKey,
      request: errorRequest,
      durableOutcome: true,
    });
    if (errorClaim.kind !== "dispatch") throw new Error("expected dispatch claim");
    await markDurableChatRequestStarted({
      idempotencyKey: errorKey,
      fingerprint: errorClaim.fingerprint,
    });
    const secret = "provider api_key=sk-secret-value /private/runtime/request.json";
    await settleDurableChatOutcome({
      runId: errorKey,
      terminal: {
        status: "error",
        errorMessage: secret,
        message: { role: "assistant", text: secret, usage: { provider: "raw-provider" } },
      },
    });
    __testing.resetMemory();
    const errorReplay = await claimDurableChatOutcome({
      idempotencyKey: errorKey,
      request: errorRequest,
      durableOutcome: true,
    });
    expect(errorReplay).toMatchObject({
      kind: "terminal",
      terminal: {
        ok: false,
        errorMessage: "chat send failed",
        payload: { status: "error", summary: "chat send failed" },
      },
    });
    const persisted = fs.readFileSync(__testing.ledgerPath(), "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("raw-provider");
  });

  it("fails closed for new keys at capacity while preserving existing replay", async () => {
    const now = Date.now();
    const entries: Record<string, unknown> = {};
    for (let index = 0; index < __testing.maxEntries - 1; index += 1) {
      const idempotencyHash = crypto.createHash("sha256").update(`seed-${index}`).digest("hex");
      entries[idempotencyHash] = {
        idempotencyHash,
        fingerprint: crypto.createHash("sha256").update(`fingerprint-${index}`).digest("hex"),
        state: "terminal",
        terminal: { ok: true, payload: { status: "ok" } },
        createdAt: now,
        updatedAt: now,
      };
    }
    fs.mkdirSync(path.dirname(__testing.ledgerPath()), { recursive: true });
    fs.writeFileSync(__testing.ledgerPath(), JSON.stringify({ version: 1, entries }), "utf8");

    const existingKey = "task:dispatch:last-slot";
    const existingRequest = { message: "last accepted key" };
    const claim = await claimDurableChatOutcome({
      idempotencyKey: existingKey,
      request: existingRequest,
      durableOutcome: true,
    });
    if (claim.kind !== "dispatch") throw new Error("expected final capacity slot");
    await markDurableChatRequestStarted({
      idempotencyKey: existingKey,
      fingerprint: claim.fingerprint,
    });
    await settleDurableChatOutcome({ runId: existingKey, terminal: { status: "ok" } });
    __testing.resetMemory();
    await expect(
      claimDurableChatOutcome({
        idempotencyKey: existingKey,
        request: existingRequest,
        durableOutcome: true,
      }),
    ).resolves.toMatchObject({ kind: "terminal" });
    await expect(
      claimDurableChatOutcome({
        idempotencyKey: "task:dispatch:over-capacity",
        request: { message: "must not dispatch" },
        durableOutcome: true,
      }),
    ).rejects.toThrow(/ledger is full/u);
  });
});
