import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createAssistant,
  testModel,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  confirmGatewaySessionCompactionHistoryMode,
  preflightGatewaySessionCompaction,
  runGatewaySessionCompaction,
  SessionCompactionHistoryModeUnsupportedError,
} from "./sessions-compaction-runner.js";

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  harness: vi.fn(() => ({ agentHarnessId: "openclaw" })),
}));
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: mocks.compact }));
vi.mock("../../agents/session-runtime-compat.js", () => ({
  resolveManualCompactionCliTarget: mocks.harness,
}));
vi.mock("../session-utils.js", () => ({
  resolveSessionModelRef: () => ({ provider: "test-provider", model: "test-model" }),
}));
vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: () => "/offline/workspace",
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  mocks.compact.mockReset();
  mocks.harness.mockReturnValue({ agentHarnessId: "openclaw" });
});

async function fixture() {
  const cwd = tempDirs.make("openclaw-summary-only-readback-");
  const target = {
    agentId: "main",
    sessionId: "summary-only-session",
    sessionKey: "agent:main:summary-only-session",
    storePath: path.join(cwd, "sessions.json"),
  };
  const entry = { sessionId: target.sessionId, updatedAt: 1 };
  await upsertSessionEntryCore(target, entry);
  const manager = SessionManager.open(target, cwd);
  manager.appendMessage({ role: "user", content: "Question", timestamp: 1 });
  manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "Historical refusal" }]));
  manager.flushPendingPersistence();
  return {
    target,
    manager,
    params: {
      ...target,
      sessionStoreKey: target.sessionKey,
      cfg: {} as OpenClawConfig,
      entry,
      historyMode: "summary_only" as const,
    },
  };
}

describe("Gateway summary-only confirmation", () => {
  it("promises the mode only after persistent self-boundary readback and keeps raw rows", async () => {
    const { target, manager, params } = await fixture();
    const before = await loadTranscriptEvents(target);
    mocks.compact.mockImplementationOnce(async (input) => {
      expect(input).toMatchObject({ trigger: "manual", historyMode: "summary_only" });
      manager.appendCompaction("Attributed summary", "new-boundary", 100, undefined, false, {
        itemId: "new-boundary",
      });
      manager.flushPendingPersistence();
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "Attributed summary",
          firstKeptEntryId: "new-boundary",
          tokensBefore: 100,
        },
      };
    });
    const result = await runGatewaySessionCompaction(params);
    expect(result.historyMode).toBe("summary_only");
    const after = await loadTranscriptEvents(target);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });

  it.each([
    "missing result",
    "missing durable boundary",
    "retained assistant",
    "mismatched summary",
  ])("fails closed after %s without replaying the native operation", async (kind) => {
    const { manager, params } = await fixture();
    mocks.compact.mockImplementationOnce(async () => {
      if (kind === "retained assistant") {
        manager.appendCompaction("Attributed summary", manager.getLeafId()!, 100);
        manager.flushPendingPersistence();
      } else if (kind === "mismatched summary") {
        manager.appendCompaction("Other summary", "new-boundary", 100, undefined, false, {
          itemId: "new-boundary",
        });
        manager.flushPendingPersistence();
      }
      return {
        ok: true,
        compacted: true,
        ...(kind === "missing result"
          ? {}
          : {
              result: {
                summary: "Attributed summary",
                firstKeptEntryId: "new-boundary",
                tokensBefore: 100,
              },
            }),
      };
    });
    await expect(runGatewaySessionCompaction(params)).rejects.toThrow(/unconfirmed.*reconcile/);
    expect(mocks.compact).toHaveBeenCalledOnce();
  });

  it("rejects a stale mode promise if active history changes before the terminal readback", async () => {
    const { manager, params } = await fixture();
    manager.appendCompaction("Attributed summary", "new-boundary", 100, undefined, false, {
      itemId: "new-boundary",
    });
    manager.flushPendingPersistence();
    const result = {
      ok: true,
      compacted: true,
      result: {
        summary: "Attributed summary",
        firstKeptEntryId: "new-boundary",
        tokensBefore: 100,
      },
    };
    const confirmed = await confirmGatewaySessionCompactionHistoryMode(params, result);
    expect(confirmed.historyMode).toBe("summary_only");
    manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "Later assistant" }]));
    manager.flushPendingPersistence();
    await expect(confirmGatewaySessionCompactionHistoryMode(params, confirmed)).rejects.toThrow(
      /unconfirmed.*reconcile/,
    );
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it.each(["CLI", "context engine", "compaction provider"])(
    "rejects unsupported %s before native dispatch",
    async (owner) => {
      const { params } = await fixture();
      if (owner === "CLI") {
        mocks.harness.mockReturnValue({ agentHarnessId: "codex" });
      }
      if (owner === "context engine") {
        params.cfg = { plugins: { slots: { contextEngine: "custom" } } };
      }
      if (owner === "compaction provider") {
        params.cfg = { agents: { defaults: { compaction: { provider: "custom" } } } };
      }
      await expect(runGatewaySessionCompaction(params)).rejects.toThrow(/unsupported/);
      await expect(preflightGatewaySessionCompaction(params)).rejects.toBeInstanceOf(
        SessionCompactionHistoryModeUnsupportedError,
      );
      expect(mocks.compact).not.toHaveBeenCalled();
    },
  );
});
