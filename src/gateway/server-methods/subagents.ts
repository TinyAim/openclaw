// Wisclaw collaboration branches — operator-plane subagent orchestration.
//
// Exposes the in-agent `subagents` tool (list / kill) and the
// `sessions_spawn` subagent runtime (`spawnSubagentDirect`) as SCOPED
// gateway WS methods so the Control API can orchestrate child runs on
// behalf of a parent session. This deliberately does NOT relax the
// gateway HTTP `/tools/invoke` deny list (`sessions_spawn` stays denied
// there — spawning via an unscoped HTTP tool surface is RCE-grade):
// the WS methods below require an authenticated operator connection and
// are classified in `method-scopes.ts` (list → read, spawn/kill → admin).
//
// Reusing the tool executors keeps announce flows, task routing
// (`agents.defaults.subagents.taskRouting.<class>`), depth/children
// caps, and cascade-kill semantics byte-identical with in-agent
// orchestration — no parallel implementation to drift.

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import { createSubagentsTool } from "../../agents/tools/subagents-tool.js";
import {
  ErrorCodes,
  errorShape,
  validateSubagentsKillParams,
  validateSubagentsListParams,
  validateSubagentsSpawnParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function extractToolDetails(result: AgentToolResult<unknown> | undefined): unknown {
  if (result && typeof result === "object" && "details" in result) {
    return (result as { details?: unknown }).details;
  }
  return undefined;
}

async function runSubagentsToolAction(params: {
  requesterSessionKey: string;
  args: Record<string, unknown>;
  respond: RespondFn;
  label: string;
}) {
  const tool = createSubagentsTool({ agentSessionKey: params.requesterSessionKey });
  try {
    const result = (await tool.execute?.(
      `gateway-${params.label}-${Date.now()}`,
      params.args,
    )) as AgentToolResult<unknown> | undefined;
    const details = extractToolDetails(result);
    if (details === undefined) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `${params.label} returned no payload`),
      );
      return;
    }
    params.respond(true, details, undefined);
  } catch (err) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `${params.label} failed: ${String(err)}`),
    );
  }
}

export const subagentsHandlers: GatewayRequestHandlers = {
  "subagents.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSubagentsListParams, "subagents.list", respond)) {
      return;
    }
    await runSubagentsToolAction({
      requesterSessionKey: params.requesterSessionKey as string,
      args: {
        action: "list",
        ...(typeof params.recentMinutes === "number"
          ? { recentMinutes: params.recentMinutes }
          : {}),
      },
      respond,
      label: "subagents.list",
    });
  },
  "subagents.spawn": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSubagentsSpawnParams, "subagents.spawn", respond)) {
      return;
    }
    const p = params as {
      requesterSessionKey: string;
      task: string;
      label?: string;
      taskClass?: string;
      model?: string;
      agentId?: string;
      mode?: "run" | "session";
      cleanup?: "delete" | "keep";
      runTimeoutSeconds?: number;
    };
    try {
      const result = await spawnSubagentDirect(
        {
          task: p.task,
          label: p.label?.trim() || undefined,
          agentId: p.agentId,
          model: p.model,
          taskClass: p.taskClass,
          runTimeoutSeconds: p.runTimeoutSeconds,
          mode: p.mode,
          cleanup: p.cleanup ?? "keep",
          sandbox: "inherit",
          expectsCompletionMessage: true,
        },
        {
          agentSessionKey: p.requesterSessionKey,
        },
      );
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `subagents.spawn failed: ${String(err)}`),
      );
    }
  },
  "subagents.kill": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSubagentsKillParams, "subagents.kill", respond)) {
      return;
    }
    await runSubagentsToolAction({
      requesterSessionKey: params.requesterSessionKey as string,
      args: {
        action: "kill",
        target: params.target,
      },
      respond,
      label: "subagents.kill",
    });
  },
};
