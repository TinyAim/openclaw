import crypto from "node:crypto";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSubagentChildSessionOwner } from "../../agents/subagents/registry/subagent-child-session-owner.js";
import { killSubagentRunAdmin } from "../../agents/subagents/registry/subagent-control-kill.js";
import { buildControlledSubagentRunsReadContext } from "../../agents/subagents/registry/subagent-control.js";
import {
  buildSubagentList,
  readSubagentListSessionEntries,
} from "../../agents/subagents/registry/subagent-list.js";
import { resolveSubagentKillTargetState } from "../../agents/subagents/registry/subagent-registry-completion.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { spawnSubagentDirect } from "../../agents/subagents/spawn/subagent-spawn.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  findOperatorSubagentAcceptedTombstone,
  OPERATOR_SUBAGENT_SPAWN_CAPABILITY,
  runIdempotentOperatorSubagentSpawn,
} from "./subagent-spawn-ledger.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const PROJECT_CONTEXT_MAX_CHARS = 18_000;
const TASK_MAX_CHARS = 8_000;
const LABEL_MAX_CHARS = 120;
const MODEL_MAX_CHARS = 512;
const IDEMPOTENCY_KEY_MAX_CHARS = 256;
const DEFAULT_RECENT_MINUTES = 30;
const MAX_RECENT_MINUTES = 24 * 60;
const TASK_CLASSES = new Set(["code-script", "tool-execution", "long-context"]);

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function reject(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function parseSpawnParams(params: Record<string, unknown>, respond: RespondFn) {
  const idempotencyKey = trimmed(params.idempotencyKey);
  const requesterSessionKey = trimmed(params.requesterSessionKey);
  const task = trimmed(params.task);
  const label = trimmed(params.label);
  const taskClass = trimmed(params.taskClass);
  const model = trimmed(params.model);
  const agentId = trimmed(params.agentId);
  const mode: "run" | "session" | undefined =
    params.mode === "session" ? "session" : params.mode === "run" ? "run" : undefined;
  const cleanup: "delete" | "keep" | undefined =
    params.cleanup === "delete" ? "delete" : params.cleanup === "keep" ? "keep" : undefined;
  const hiddenSystemContext = trimmed(params.hiddenSystemContext);
  const runTimeoutSeconds = params.runTimeoutSeconds;
  const threadBinding = params.threadBinding;
  if (!idempotencyKey || idempotencyKey.length > IDEMPOTENCY_KEY_MAX_CHARS) {
    reject(respond, "subagents.spawn requires a bounded idempotencyKey");
    return undefined;
  }
  if (!requesterSessionKey || !parseAgentSessionKey(requesterSessionKey)) {
    reject(respond, "subagents.spawn requires a canonical requesterSessionKey");
    return undefined;
  }
  if (!task || task.length > TASK_MAX_CHARS) {
    reject(respond, "subagents.spawn requires a task of at most 8000 characters");
    return undefined;
  }
  if (label && label.length > LABEL_MAX_CHARS) {
    reject(respond, "subagents.spawn label is too long");
    return undefined;
  }
  if (taskClass && !TASK_CLASSES.has(taskClass)) {
    reject(respond, "subagents.spawn taskClass is unsupported");
    return undefined;
  }
  if (model && model.length > MODEL_MAX_CHARS) {
    reject(respond, "subagents.spawn model is too long");
    return undefined;
  }
  if (agentId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentId)) {
    reject(respond, "subagents.spawn agentId is invalid");
    return undefined;
  }
  if (hiddenSystemContext && hiddenSystemContext.length > PROJECT_CONTEXT_MAX_CHARS) {
    reject(respond, "subagents.spawn hiddenSystemContext is too long");
    return undefined;
  }
  if (
    runTimeoutSeconds !== undefined &&
    (!Number.isSafeInteger(runTimeoutSeconds) ||
      (runTimeoutSeconds as number) < 1 ||
      (runTimeoutSeconds as number) > 86_400)
  ) {
    reject(respond, "subagents.spawn runTimeoutSeconds is invalid");
    return undefined;
  }
  let binding: { kind: "wisclaw_session_binding"; reservationId: string } | undefined;
  if (threadBinding !== undefined) {
    if (!threadBinding || typeof threadBinding !== "object" || Array.isArray(threadBinding)) {
      reject(respond, "subagents.spawn threadBinding is invalid");
      return undefined;
    }
    const record = threadBinding as Record<string, unknown>;
    const reservationId = trimmed(record.reservationId);
    if (
      record.kind !== "wisclaw_session_binding" ||
      !reservationId ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(reservationId)
    ) {
      reject(respond, "subagents.spawn threadBinding reservation is invalid");
      return undefined;
    }
    binding = { kind: "wisclaw_session_binding", reservationId };
  }
  if (mode === "session" && !binding) {
    reject(respond, "subagents.spawn mode=session requires a server-owned threadBinding");
    return undefined;
  }
  if (binding && mode !== "session") {
    reject(respond, "subagents.spawn threadBinding requires mode=session");
    return undefined;
  }
  return {
    idempotencyKey,
    requesterSessionKey,
    task,
    label,
    taskClass,
    model,
    agentId,
    mode,
    cleanup,
    hiddenSystemContext,
    runTimeoutSeconds: runTimeoutSeconds as number | undefined,
    threadBinding: binding,
  };
}

async function scopedRun(
  requesterSessionKey: string,
  runId: string,
  cfg: OpenClawConfig,
): Promise<SubagentRunRecord | undefined> {
  const context = await buildControlledSubagentRunsReadContext(requesterSessionKey, undefined, cfg);
  return context.runs.find((entry) => entry.runId === runId);
}

const subagentHandlerDeps = {
  spawnSubagentDirect,
  runIdempotentOperatorSubagentSpawn,
  findOperatorSubagentAcceptedTombstone,
};

export const subagentsHandlers: GatewayRequestHandlers = {
  "subagents.capabilities": ({ respond }) => {
    respond(true, { spawn: OPERATOR_SUBAGENT_SPAWN_CAPABILITY });
  },

  "subagents.spawn": async ({ params, respond }) => {
    const parsed = parseSpawnParams(params, respond);
    if (!parsed) return;
    const contextFingerprint = parsed.hiddenSystemContext
      ? sha256(parsed.hiddenSystemContext)
      : undefined;
    const result = await subagentHandlerDeps.runIdempotentOperatorSubagentSpawn({
      idempotencyKey: parsed.idempotencyKey,
      request: {
        requesterSessionKey: parsed.requesterSessionKey,
        taskFingerprint: sha256(parsed.task),
        label: parsed.label,
        taskClass: parsed.taskClass,
        model: parsed.model,
        agentId: parsed.agentId,
        mode: parsed.mode,
        cleanup: parsed.cleanup,
        runTimeoutSeconds: parsed.runTimeoutSeconds,
        threadBinding: parsed.threadBinding,
        hiddenSystemContextFingerprint: contextFingerprint,
      },
      spawn: () =>
        subagentHandlerDeps.spawnSubagentDirect(
          {
            task: parsed.task,
            label: parsed.label,
            model: parsed.model,
            agentId: parsed.agentId,
            mode: parsed.mode,
            cleanup: parsed.cleanup,
            runTimeoutSeconds: parsed.runTimeoutSeconds,
            operatorExtraSystemPrompt: parsed.hiddenSystemContext,
            operatorSessionBinding: parsed.threadBinding,
          },
          {
            agentSessionKey: parsed.requesterSessionKey,
            completionOwnerKey: parsed.requesterSessionKey,
          },
        ),
    });
    respond(true, {
      ...result,
      ...(result.status === "accepted" && parsed.threadBinding
        ? {
            threadBinding: {
              ...parsed.threadBinding,
              status: "reserved" as const,
            },
          }
        : {}),
      ...(result.status === "accepted" && contextFingerprint
        ? {
            hiddenSystemContextReceipt: {
              delivery: "agent.extraSystemPrompt" as const,
              contentFingerprint: contextFingerprint,
            },
          }
        : {}),
    });
  },

  "subagents.list": async ({ params, respond, context }) => {
    const requesterSessionKey = trimmed(params.requesterSessionKey);
    const recentMinutes = params.recentMinutes ?? DEFAULT_RECENT_MINUTES;
    if (
      !requesterSessionKey ||
      !parseAgentSessionKey(requesterSessionKey) ||
      !Number.isSafeInteger(recentMinutes) ||
      (recentMinutes as number) < 1 ||
      (recentMinutes as number) > MAX_RECENT_MINUTES
    ) {
      reject(respond, "subagents.list params are invalid");
      return;
    }
    const cfg = context.getRuntimeConfig();
    const controlled = await buildControlledSubagentRunsReadContext(
      requesterSessionKey,
      undefined,
      cfg,
      recentMinutes as number,
    );
    const list = buildSubagentList({
      context: controlled.list,
      sessionEntries: await readSubagentListSessionEntries(cfg, controlled.list),
    });
    respond(true, {
      status: "ok",
      requesterSessionKey,
      active: list.active,
      recent: list.recent,
    });
  },

  "subagents.get": async ({ params, respond, context }) => {
    const requesterSessionKey = trimmed(params.requesterSessionKey);
    const runId = trimmed(params.runId);
    if (!requesterSessionKey || !parseAgentSessionKey(requesterSessionKey) || !runId) {
      reject(respond, "subagents.get params are invalid");
      return;
    }
    const tombstone = await subagentHandlerDeps.findOperatorSubagentAcceptedTombstone({
      requesterSessionKey,
      runId,
    });
    if (!tombstone) {
      respond(true, { status: "not_found", terminal: false, requesterSessionKey, runId });
      return;
    }
    const base = {
      requesterSessionKey,
      runId,
      childSessionKey: tombstone.childSessionKey,
      acceptedAt: tombstone.acceptedAt,
    };
    const entry = await scopedRun(requesterSessionKey, runId, context.getRuntimeConfig());
    if (!entry) {
      respond(true, {
        ...base,
        status: "needs_reconcile",
        terminal: false,
        reason: "gateway_restart_outcome_unknown",
      });
      return;
    }
    if (entry.childSessionKey !== tombstone.childSessionKey) {
      respond(true, {
        ...base,
        status: "needs_reconcile",
        terminal: false,
        reason: "registry_run_ref_mismatch",
      });
      return;
    }
    const parsedChild = parseAgentSessionKey(entry.childSessionKey);
    if (!parsedChild || (entry.childAgentId && entry.childAgentId !== parsedChild.agentId)) {
      respond(true, {
        ...base,
        status: "needs_reconcile",
        terminal: false,
        reason: "session_identity_missing",
      });
      return;
    }
    try {
      const owner = resolveSubagentChildSessionOwner(entry, context.getRuntimeConfig());
      const selected = await readSessionEntriesFromStoreInWorker({
        ...owner,
        sessionKeys: [entry.childSessionKey],
        projection: "list",
      });
      const session = selected.entries.find(
        (item) => item.sessionKey === entry.childSessionKey,
      )?.entry;
      if (!session) {
        respond(true, {
          ...base,
          status: "needs_reconcile",
          terminal: false,
          reason: "session_missing",
        });
        return;
      }
    } catch {
      respond(true, {
        ...base,
        status: "needs_reconcile",
        terminal: false,
        reason: "session_unavailable",
      });
      return;
    }
    const startedAt = entry.execution.startedAt;
    if (typeof entry.execution.endedAt !== "number") {
      respond(true, {
        ...base,
        ...(typeof startedAt === "number" ? { startedAt } : {}),
        status: "running",
        terminal: false,
      });
      return;
    }
    const state = resolveSubagentKillTargetState(entry);
    if (!state || state.state !== "terminal") {
      respond(true, {
        ...base,
        ...(typeof startedAt === "number" ? { startedAt } : {}),
        endedAt: entry.execution.endedAt,
        status: "needs_reconcile",
        terminal: false,
        reason: "terminal_outcome_unknown",
      });
      return;
    }
    const terminal = state.task;
    const status =
      terminal.status === "succeeded"
        ? "succeeded"
        : terminal.status === "timed_out"
          ? "timeout"
          : terminal.status === "cancelled"
            ? "killed"
            : "failed";
    respond(true, {
      ...base,
      ...(typeof startedAt === "number" ? { startedAt } : {}),
      endedAt: terminal.endedAt,
      status,
      terminal: true,
      ...(terminal.error ? { error: terminal.error } : {}),
    });
  },

  "subagents.kill": async ({ params, respond, context }) => {
    const requesterSessionKey = trimmed(params.requesterSessionKey);
    const target = trimmed(params.target);
    if (
      !requesterSessionKey ||
      !parseAgentSessionKey(requesterSessionKey) ||
      !target ||
      target === "all"
    ) {
      reject(respond, "subagents.kill requires one scoped target");
      return;
    }
    const runs = (
      await buildControlledSubagentRunsReadContext(
        requesterSessionKey,
        undefined,
        context.getRuntimeConfig(),
      )
    ).runs;
    const entry = runs.find(
      (candidate) =>
        candidate.runId === target ||
        candidate.childSessionKey === target ||
        candidate.label === target,
    );
    if (!entry) {
      respond(true, { status: "done", killed: 0 });
      return;
    }
    const result = await killSubagentRunAdmin({
      cfg: context.getRuntimeConfig(),
      sessionKey: entry.childSessionKey,
      expectedRunId: entry.runId,
      agentId: parseAgentSessionKey(requesterSessionKey)?.agentId,
    });
    respond(true, {
      status: result.killed ? "ok" : "done",
      killed: result.killed ? 1 : 0,
      found: result.found,
    });
  },
};

export const testing = {
  setDepsForTest(overrides?: Partial<typeof subagentHandlerDeps>) {
    subagentHandlerDeps.spawnSubagentDirect = overrides?.spawnSubagentDirect ?? spawnSubagentDirect;
    subagentHandlerDeps.runIdempotentOperatorSubagentSpawn =
      overrides?.runIdempotentOperatorSubagentSpawn ?? runIdempotentOperatorSubagentSpawn;
    subagentHandlerDeps.findOperatorSubagentAcceptedTombstone =
      overrides?.findOperatorSubagentAcceptedTombstone ?? findOperatorSubagentAcceptedTombstone;
  },
};
export { testing as __testing };
