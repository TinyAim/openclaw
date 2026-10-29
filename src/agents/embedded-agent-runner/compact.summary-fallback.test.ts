import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  createSessionEntryWithTranscript,
} from "../../config/sessions/session-accessor.js";
import { resolveCheckpointBoundaryPath } from "../../config/sessions/session-checkpoint-boundary.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { writePlugin } from "../../plugins/loader.test-fixtures.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { SessionManager } from "../sessions/session-manager.js";
import { compactEmbeddedAgentSessionDirect } from "./compact.js";
import { compactEmbeddedAgentSession } from "./compact.queued.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  compactEmbeddedRunForRecovery,
  createEmbeddedRunCompactionRuntime,
} from "./run/compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { claimAgentSessionWriter } from "./run/session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

// Real queued compaction, native delegate, AgentSession, and SQLite transcript; only the
// provider is a local OpenAI-compatible endpoint whose summary requests stall, fail, or answer.
type SummaryMode =
  | "stall"
  | "provider-timeout"
  | "bare-408"
  | "server-error"
  | "auth-error"
  | "error"
  | "ok";
type SessionTarget = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
type Fixture = { state: OpenClawTestState; config: OpenClawConfig; target: SessionTarget };

let summaryMode: SummaryMode = "stall";
let summaryRequests: string[] = [];
let summaryArrived = createDeferred();
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      summaryRequests.push(body);
      summaryArrived.resolve();
      const mode: SummaryMode = body.includes('"model":"fallback-model"') ? "ok" : summaryMode;
      if (mode === "stall") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      if (mode === "provider-timeout") {
        res.writeHead(408, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream request timed out" } }));
        return;
      }
      if (mode === "bare-408") {
        res.writeHead(408);
        res.end();
        return;
      }
      if (mode === "server-error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Internal Server Error" } }));
        return;
      }
      if (mode === "auth-error") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "summary model authentication failed" } }));
        return;
      }
      if (mode === "error") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "summary model rejected the request" } }));
        return;
      }
      const chunk = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "summary",
          object: "chat.completion.chunk",
          created: 1,
          model: "model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        chunk({ role: "assistant", content: "## Goal\nModel summary after recovery." }, null) +
          `${chunk({}, "stop")}data: [DONE]\n\n`,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  summaryRequests = [];
  summaryArrived = createDeferred();
});

const FILLER = "older context ".repeat(200);

/** Appends user -> assistant tool call -> tool result turns and returns their entry ids. */
function appendToolTurns(fixture: Fixture, first: number, count: number): string[] {
  const manager = SessionManager.open(fixture.target, fixture.state.workspaceDir);
  const ids: string[] = [];
  for (let turn = first; turn < first + count; turn += 1) {
    ids.push(
      manager.appendMessage({
        role: "user",
        content: `ask ${turn}: ${FILLER}`,
        timestamp: turn * 10 + 1,
      }),
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: {} }],
        api: "openai-completions",
        provider: "fixture",
        model: "model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: turn * 10 + 2,
      }),
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "read",
        content: [{ type: "text", text: `result ${turn}: ${FILLER}` }],
        isError: false,
        timestamp: turn * 10 + 3,
      }),
    );
  }
  return ids;
}

async function withSession(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    modelFallback?: boolean;
    safeguard?: boolean;
    incognito?: boolean;
  } = {},
) {
  const state = await createOpenClawTestState({ prefix: "openclaw-summary-fallback-" });
  try {
    const model = (id: string) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 1024,
    });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: {
            primary: "fixture/model",
            ...(options.modelFallback ? { fallbacks: ["fixture/fallback-model"] } : {}),
          },
          compaction: {
            timeoutSeconds: 60,
            keepRecentTokens: 300,
            ...(options.safeguard ? { mode: "safeguard" as const } : {}),
          },
        },
      },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "synthetic-fixture",
            baseUrl,
            models: [model("model"), model("fallback-model")],
          },
        },
      },
      plugins: { enabled: false, slots: { memory: "none" } },
    };
    await state.writeConfig(config);
    const target = {
      agentId: "main",
      sessionId: "summary-fallback",
      sessionKey: options.incognito
        ? "agent:main:dashboard:incognito-summary-fallback"
        : "agent:main:summary-fallback",
      storePath: options.incognito
        ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
        : state.path("sessions.sqlite"),
    };
    if (options.incognito) {
      expect(
        await createSessionEntryWithTranscript(target, () => ({
          ok: true,
          entry: { sessionId: target.sessionId, updatedAt: 1, incognito: true },
        })),
      ).toMatchObject({ ok: true });
    } else await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await run({ state, config, target });
  } finally {
    await closePreparedModelRuntimeSnapshots();
    await state.cleanup();
  }
}

function compactSession(
  fixture: Fixture,
  options: {
    trigger?: "budget" | "manual";
    abortSignal?: AbortSignal;
    historyMode?: "summary_only";
  } = {},
) {
  return compactEmbeddedAgentSession(
    {
      ...fixture.target,
      sessionTarget: fixture.target,
      sessionFile: fixture.target.sessionKey,
      workspaceDir: fixture.state.workspaceDir,
      agentDir: fixture.state.agentDir(),
      config: fixture.config,
      provider: "fixture",
      model: "model",
      trigger: options.trigger ?? "budget",
      force: true,
      historyMode: options.historyMode,
      abortSignal: options.abortSignal,
      enqueue: async (task) => await task(),
    },
    { sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined } },
  );
}

function openSession(fixture: Fixture) {
  return SessionManager.open(fixture.target, fixture.state.workspaceDir);
}

async function compactForegroundRecovery(
  fixture: Fixture,
  options: { detached?: boolean; summaryOnly?: boolean } = {},
) {
  const runId = "checkpoint-foreground";
  const admission = prepareSystemAgentRunAdmission(
    fixture.config,
    runId,
    "main",
    "checkpoint-recovery-test",
  );
  try {
    const runParams = {
      ...fixture.target,
      sessionTarget: fixture.target,
      sessionFile: fixture.target.sessionKey,
      runId,
      prompt: "continue",
      timeoutMs: 60_000,
      workspaceDir: fixture.state.workspaceDir,
      config: fixture.config,
      admittedRunContext: await admission.admit("embedded"),
      ...(options.detached ? { sessionPersistence: "detached" as const } : {}),
    };
    const fence = await claimAgentSessionWriter(runParams);
    const preparedParams = { ...runParams, sessionTarget: { ...fixture.target, ...fence } };
    await using prompt = await createEmbeddedRunSessionPromptState({
      runParams: preparedParams,
      sessionAgentId: "main",
      resolvedSessionKey: fixture.target.sessionKey,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      onInterrupt: () => {},
    });
    const engine: ContextEngine = {
      info: { id: "legacy", name: "Real embedded compactor" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async (params) =>
        compactEmbeddedAgentSessionDirect({
          ...fixture.target,
          sessionTarget: preparedParams.sessionTarget,
          sessionFile: fixture.target.sessionKey,
          workspaceDir: fixture.state.workspaceDir,
          agentDir: fixture.state.agentDir(),
          config: fixture.config,
          provider: "fixture",
          model: "model",
          trigger: "overflow",
          force: true,
          abortSignal: params.abortSignal,
          contextEngineRuntimeContext: params.runtimeContext,
          ...(options.summaryOnly ? { historyMode: "summary_only" as const } : {}),
        }),
    };
    const runtime = createEmbeddedRunCompactionRuntime({
      runParams: preparedParams,
      contextEngine: engine,
      hookRunner: null,
      hookContext: {
        agentId: "main",
        sessionId: fixture.target.sessionId,
        sessionKey: fixture.target.sessionKey,
        workspaceDir: fixture.state.workspaceDir,
      },
      sessionPromptState: prompt,
    });
    return await compactEmbeddedRunForRecovery(
      {
        ...runtime,
        runParams: preparedParams,
        state: createEmbeddedRunContextRecoveryState(),
        contextEngine: engine,
        genericCompactionRecoveryAllowed: true,
        attempt: makeAttemptResult(),
        runtimeAuthPlan: undefined,
        resolvedSessionKey: fixture.target.sessionKey,
        sessionAgentId: "main",
        agentDir: fixture.state.agentDir(),
        workspaceDir: fixture.state.workspaceDir,
        modelSelection: { provider: "fixture", model: "model", authProfileIdSource: "auto" },
        harnessRuntime: "openclaw",
        thinkLevel: "off",
        resolveContextEnginePluginId: () => undefined,
        buildRuntimeSettings: ({ tokenBudget }) =>
          buildContextEngineRuntimeSettings({
            contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
            promptTokenBudget: tokenBudget,
          }),
        getActiveSession: () => ({
          id: prompt.sessionId,
          file: prompt.sessionFile,
          target: prompt.sessionTarget,
        }),
        prepareCompactedTranscriptRetry: async () => {},
        armPostCompactionGuard: () => {},
        usageAccumulator: createUsageAccumulator(),
      },
      {
        tokenBudget: 2_000,
        trigger: "overflow",
        diagId: "native-checkpoint",
        attempt: 1,
        maxAttempts: 1,
      },
    );
  } finally {
    admission.close();
  }
}

describe("automatic compaction summary failure", () => {
  it("retains native incognito recovery after the real foreground writer frame and Host acceptance", async () => {
    await withSession(
      async (fixture) => {
        const seeded = appendToolTurns(fixture, 0, 8);
        summaryMode = "ok";
        const { result } = await compactForegroundRecovery(fixture);
        expect(result).toMatchObject({ ok: true, compacted: true });
        const entry = loadSessionEntry({ ...fixture.target, readConsistency: "latest" });
        expect(entry?.compactionCheckpoints).toHaveLength(1);
        const checkpoint = entry!.compactionCheckpoints![0]!;
        const before = resolveCheckpointBoundaryPath(
          await loadTranscriptEvents(fixture.target),
          checkpoint.preCompaction.leafId!,
        );
        expect(
          before
            ?.map((event) => (event as { id?: string }).id)
            .filter((id) => id && seeded.includes(id)),
        ).toEqual(seeded);
        expect(checkpoint.postCompaction.leafId).toBe(openSession(fixture).getLeafId());
        await expect(fs.stat(fixture.target.storePath)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { incognito: true },
    );
  });

  it("rejects foreground retention failure after a real commit without promoting its receipt", async () => {
    await withSession(
      async (fixture) => {
        appendToolTurns(fixture, 0, 8);
        summaryMode = "ok";
        const checkpoints =
          await import("../../config/sessions/session-accessor.sqlite-checkpoint.js");
        using persist = vi
          .spyOn(checkpoints, "persistSqliteCompactionCheckpoint")
          .mockResolvedValue({ status: "conflict" });
        await expect(compactForegroundRecovery(fixture)).rejects.toThrow(
          "retention is unconfirmed",
        );
        expect(persist).toHaveBeenCalledOnce();
        expect(loadSessionEntry(fixture.target)?.compactionCheckpoints).toBeUndefined();
        expect(openSession(fixture).getBranch().at(-1)).toMatchObject({ type: "compaction" });
      },
      { incognito: true },
    );
  });

  it("does not give detached recovery a native checkpoint or a summary_only terminal receipt", async () => {
    await withSession(
      async (fixture) => {
        appendToolTurns(fixture, 0, 8);
        const originalLeaf = openSession(fixture).getLeafId();
        summaryMode = "ok";
        const checkpoints =
          await import("../../config/sessions/session-accessor.sqlite-checkpoint.js");
        using persist = vi.spyOn(checkpoints, "persistSqliteCompactionCheckpoint");
        const { result } = await compactForegroundRecovery(fixture, {
          detached: true,
          summaryOnly: true,
        });
        expect(result).toMatchObject({ ok: false, compacted: false });
        expect(persist).not.toHaveBeenCalled();
        expect(openSession(fixture).getLeafId()).toBe(originalLeaf);
        expect(loadSessionEntry(fixture.target)?.compactionCheckpoints).toBeUndefined();
      },
      { incognito: true },
    );
  });
  it.each([false, true])(
    "does not promote a summary_only receipt when checkpoint retention conflicts (native incognito=%s)",
    async (incognito) => {
      await withSession(
        async (fixture) => {
          appendToolTurns(fixture, 0, 8);
          summaryMode = "ok";
          const checkpoints =
            await import("../../config/sessions/session-accessor.sqlite-checkpoint.js");
          using persist = vi
            .spyOn(checkpoints, "persistSqliteCompactionCheckpoint")
            .mockResolvedValue({ status: "conflict" });
          const result = await compactSession(fixture, {
            trigger: "manual",
            historyMode: "summary_only",
          });
          expect(persist).toHaveBeenCalledOnce();
          expect(result).toMatchObject({ ok: false, compacted: false });
          expect(result.reason).toContain("checkpoint retention is unconfirmed");
          expect(
            loadSessionEntry({ ...fixture.target, readConsistency: "latest" })
              ?.compactionCheckpoints,
          ).toBeUndefined();
          // The transcript did commit. Refusal cannot invite an automatic replay or erase its receipt.
          const manager = await SessionManager.openAsync(
            fixture.target,
            fixture.state.workspaceDir,
          );
          expect(manager.buildSessionContext().messages).toHaveLength(1);
        },
        { incognito },
      );
    },
  );
  it.each([false, true])(
    "confirms summary_only only with a retained original boundary and one summary leaf (native incognito=%s)",
    async (incognito) => {
      await withSession(
        async (fixture) => {
          const seeded = appendToolTurns(fixture, 0, 8);
          summaryMode = "ok";
          const result = await compactSession(fixture, {
            trigger: "manual",
            historyMode: "summary_only",
          });
          expect(result).toMatchObject({ ok: true, compacted: true });
          const entry = loadSessionEntry({ ...fixture.target, readConsistency: "latest" });
          expect(entry?.compactionCheckpoints).toHaveLength(1);
          const events = await loadTranscriptEvents(fixture.target);
          const checkpoint = entry!.compactionCheckpoints![0]!;
          const before = resolveCheckpointBoundaryPath(events, checkpoint.preCompaction.leafId!);
          expect(
            before
              ?.map((event) => (event as { id?: string }).id)
              .filter((id) => id && seeded.includes(id)),
          ).toEqual(seeded);
          const manager = await SessionManager.openAsync(
            fixture.target,
            fixture.state.workspaceDir,
          );
          const active = manager.buildSessionContext().messages;
          expect(active).toHaveLength(1);
          expect(active[0]).toMatchObject({
            role: "compactionSummary",
            summary: expect.any(String),
          });
          const leaf = manager.getBranch().at(-1);
          expect(leaf).toMatchObject({ type: "compaction", firstKeptEntryId: manager.getLeafId() });
          expect(result.result?.firstKeptEntryId).toBe(manager.getLeafId());
          const { confirmGatewaySessionCompactionHistoryMode } =
            await import("../../gateway/server-methods/sessions-compaction-runner.js");
          expect(
            await confirmGatewaySessionCompactionHistoryMode(
              {
                ...fixture.target,
                sessionStoreKey: fixture.target.sessionKey,
                historyMode: "summary_only",
              },
              result,
            ),
          ).toMatchObject({ historyMode: "summary_only" });
          expect(checkpoint.postCompaction.leafId).toBe(manager.getLeafId());
          if (incognito)
            await expect(fs.stat(fixture.target.storePath)).rejects.toMatchObject({
              code: "ENOENT",
            });
        },
        { incognito },
      );
    },
  );
  it("records pre- and post-compaction checkpoint boundaries for an ordinary session", async () => {
    await withSession(async (fixture) => {
      const seeded = appendToolTurns(fixture, 0, 8);
      summaryMode = "ok";
      expect(await compactSession(fixture)).toMatchObject({ ok: true, compacted: true });
      const entry = loadSessionEntry({ ...fixture.target, readConsistency: "latest" });
      expect(entry?.compactionCheckpoints).toHaveLength(1);
      expect(entry?.compactionCheckpoints?.[0]).toMatchObject({
        sessionId: fixture.target.sessionId,
        preCompaction: { sessionId: fixture.target.sessionId, leafId: expect.any(String) },
        postCompaction: { sessionId: fixture.target.sessionId },
      });
      const checkpoint = entry!.compactionCheckpoints![0]!;
      const events = await loadTranscriptEvents(fixture.target);
      const before = resolveCheckpointBoundaryPath(events, checkpoint.preCompaction.leafId!);
      expect(
        before
          ?.map((event) => (event as { id?: string }).id)
          .filter((id) => id && seeded.includes(id)),
      ).toEqual(seeded);
      const after = resolveCheckpointBoundaryPath(events, checkpoint.postCompaction.leafId!);
      expect(after?.some((event) => (event as { type?: string }).type === "compaction")).toBe(true);
    });
  });
  it.each([false, true])(
    "uses the fallback model's runtime only for unlocked native sessions (locked=%s)",
    async (locked) => {
      await withSession(async (fixture) => {
        const seeded = appendToolTurns(fixture, 0, 8);
        summaryMode = "auth-error";
        const plugin = writePlugin({
          id: "summary-native",
          dir: fixture.state.path("summary-native"),
          registration: `api.registerAgentHarness({
          id: "summary-native",
          label: "Primary summary runtime",
          authBootstrap: "harness",
          supports: (context) => context.requestedRuntime === "summary-native" && context.provider === "fixture"
            ? { supported: true }
            : { supported: false, reason: "Primary runtime cannot run the fallback provider" },
          runAttempt: async () => { throw new Error("Compaction must not run an agent turn"); },
        });`,
        });
        await fs.writeFile(
          fixture.state.path("summary-native", "openclaw.plugin.json"),
          JSON.stringify({
            id: plugin.id,
            activation: { onStartup: false, onAgentHarnesses: ["summary-native"] },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          }),
        );
        const primary = fixture.config.models!.providers!.fixture!;
        fixture.config.models!.providers!.backup = {
          ...primary,
          models: primary.models.filter(({ id }) => id === "fallback-model"),
        };
        delete primary.apiKey;
        fixture.config.agents!.defaults!.model = {
          primary: "fixture/model",
          fallbacks: ["backup/fallback-model"],
        };
        fixture.config.plugins = {
          allow: [plugin.id],
          load: { paths: [plugin.dir] },
          slots: { memory: "none" },
        };
        await fixture.state.writeConfig(fixture.config);
        await loadAndActivateRootPluginRegistry({
          config: fixture.config,
          workspaceDir: fixture.state.workspaceDir,
          onlyPluginIds: [plugin.id],
          cache: false,
        });
        const scope = new AsyncWorkScope();
        let result;
        try {
          result = await scope.run(() =>
            compactEmbeddedAgentSessionDirect({
              ...fixture.target,
              sessionTarget: fixture.target,
              sessionFile: fixture.target.sessionKey,
              workspaceDir: fixture.state.workspaceDir,
              agentDir: fixture.state.agentDir(),
              config: fixture.config,
              provider: "fixture",
              model: "model",
              agentHarnessId: "summary-native",
              modelSelectionLocked: locked,
              trigger: "budget",
              force: true,
            }),
          );
        } finally {
          await AsyncWorkScope.runWhenAllIdle(
            () => [scope],
            () => scope.drain(),
          );
        }

        expect(JSON.parse(summaryRequests[0]!).model).toBe("model");
        const compactions = () =>
          openSession(fixture)
            .getBranch()
            .filter((entry) => entry.type === "compaction");
        if (locked) {
          expect(result).toMatchObject({ ok: false, compacted: false });
          expect(summaryRequests.map((request) => JSON.parse(request).model)).not.toContain(
            "fallback-model",
          );
          expect(compactions()).toHaveLength(0);
          return;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
        expect(summaryRequests.map((request) => JSON.parse(request).model)).toContain(
          "fallback-model",
        );
        expect(compactions().at(-1)?.summary).toContain("Model summary after recovery.");
        const session = openSession(fixture);
        expect(
          session
            .getBranch()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.id),
        ).toEqual(seeded);
        expect(session.buildSessionContext().messages.at(-1)).toMatchObject({
          role: "toolResult",
          toolCallId: "call-7",
        });
      });
    },
  );

  it("commits a deterministic reduction after a bodyless 408 summary timeout", async () => {
    await withSession(async (fixture) => {
      const seeded = appendToolTurns(fixture, 0, 8);
      summaryMode = "bare-408";
      const result = await compactSession(fixture);

      expect(result).toMatchObject({ ok: true, compacted: true });
      expect(summaryRequests.length).toBeGreaterThan(0);
      const branch = openSession(fixture).getBranch();
      const compactions = branch.filter((entry) => entry.type === "compaction");
      expect(compactions).toHaveLength(1);
      expect(compactions[0]?.summary).toContain("removed without a summary");
      // Durable history is untouched; the boundary keeps a verbatim tool-call/result suffix.
      expect(branch.filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual(
        seeded,
      );
      const firstKept = seeded.indexOf(compactions[0]!.firstKeptEntryId);
      expect(firstKept).toBeGreaterThan(0);
      expect(firstKept % 3).not.toBe(2);
      const context = openSession(fixture).buildSessionContext().messages;
      expect(context[0]?.role).toBe("compactionSummary");
      expect(context.slice(1)).toHaveLength(seeded.length - firstKept);
      expect(context.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call-7" });

      // A later turn's model compaction still works and carries the fallback summary forward.
      appendToolTurns(fixture, 8, 4);
      summaryMode = "ok";
      summaryRequests = [];
      expect(await compactSession(fixture)).toMatchObject({ ok: true, compacted: true });
      expect(summaryRequests.join("\n")).toContain("removed without a summary");
      expect(
        openSession(fixture)
          .getBranch()
          .findLast((entry) => entry.type === "compaction")?.summary,
      ).toContain("Model summary after recovery.");
    });
  });

  it("commits the reduction without trying a configured fallback model", async () => {
    await withSession(
      async (fixture) => {
        appendToolTurns(fixture, 0, 8);
        summaryMode = "provider-timeout";

        expect(await compactSession(fixture)).toMatchObject({ ok: true, compacted: true });
        // Each extra candidate could cost another full summary window.
        expect(summaryRequests.some((body) => body.includes('"model":"fallback-model"'))).toBe(
          false,
        );
        expect(
          openSession(fixture)
            .getBranch()
            .filter((entry) => entry.type === "compaction")
            .map((entry) => entry.summary),
        ).toEqual([expect.stringContaining("removed without a summary")]);
      },
      { modelFallback: true },
    );
  });

  it("commits the reduction after a provider-returned timeout in safeguard mode", async () => {
    await withSession(
      async (fixture) => {
        appendToolTurns(fixture, 0, 8);
        summaryMode = "bare-408";

        expect(await compactSession(fixture)).toMatchObject({ ok: true, compacted: true });
        expect(summaryRequests.length).toBeGreaterThan(0);
        expect(
          openSession(fixture)
            .getBranch()
            .filter((entry) => entry.type === "compaction")
            .map((entry) => entry.summary),
        ).toEqual([expect.stringContaining("removed without a summary")]);
      },
      { safeguard: true },
    );
  });

  it.each([
    { failure: "a caller Stop", mode: "stall", trigger: "budget", stop: true },
    { failure: "a non-timeout summary error", mode: "error", trigger: "budget", stop: false },
    // Wrapped summary text reads "…failed: 500 Internal Server Error"; it is not a timeout.
    { failure: "a fast 500 summary error", mode: "server-error", trigger: "budget", stop: false },
  ] as const)("keeps $failure as a failed compaction", async ({ mode, trigger, stop }) => {
    await withSession(async (fixture) => {
      appendToolTurns(fixture, 0, 8);
      summaryMode = mode;
      const caller = new AbortController();
      const pending = compactSession(fixture, { trigger, abortSignal: caller.signal });
      if (stop) {
        await summaryArrived.promise;
        caller.abort(new Error("user stop"));
      }

      expect(await pending).toMatchObject({ ok: false, compacted: false });
      expect(summaryRequests.length).toBeGreaterThan(0);
      expect(
        openSession(fixture)
          .getBranch()
          .some((entry) => entry.type === "compaction"),
      ).toBe(false);
    });
  });
});
