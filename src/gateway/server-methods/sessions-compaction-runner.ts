// Model-backed compaction request construction.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import { resolveCompactionInstructions } from "../../agents/agent-hooks/compaction-instructions.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { compactEmbeddedAgentSession } from "../../agents/embedded-agent.js";
import { resolveManualCompactionCliTarget } from "../../agents/session-runtime-compat.js";
import { preflightManualSessionCompaction } from "../../agents/sessions/manual-compaction-preflight.js";
import { isIndexedSessionEntry } from "../../agents/sessions/session-manager-codec.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveCurrentSessionPrimaryConversation } from "../../config/sessions/conversation-registry.js";
import {
  loadTranscriptEvents,
  resolveSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../../config/sessions/transcript-tree.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionModelRef } from "../session-utils.js";

type GatewaySessionCompactionParams = {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  runId?: string;
  sessionId: string;
  sessionKey: string;
  sessionStoreKey: string;
  storePath: string;
  customInstructions?: string;
  historyMode?: "preserve_recent" | "summary_only";
};

export class SessionCompactionHistoryModeUnsupportedError extends Error {
  constructor() {
    super("summary_only compaction is unsupported by the selected runtime or compaction owner.");
  }
}

function usesLegacyOpenClawCompaction(params: GatewaySessionCompactionParams): boolean {
  const resolvedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const persistedRuntime = resolveManualCompactionCliTarget({
    provider: resolvedModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  }).agentHarnessId;
  const contextEngine = params.cfg.plugins?.slots?.contextEngine?.trim();
  return (
    (!persistedRuntime || persistedRuntime === "openclaw") &&
    (!contextEngine || contextEngine === "legacy")
  );
}

function assertGatewayHistoryModeSupported(params: GatewaySessionCompactionParams): void {
  if (
    params.historyMode === "summary_only" &&
    (!usesLegacyOpenClawCompaction(params) || params.cfg.agents?.defaults?.compaction?.provider)
  ) {
    throw new SessionCompactionHistoryModeUnsupportedError();
  }
}

async function resolveGatewayCompactionTranscriptTarget(params: GatewaySessionCompactionParams) {
  return await resolveSessionTranscriptRuntimeTarget({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  });
}

/** Returns only definitive legacy-runtime no-op verdicts; other runtimes decide for themselves. */
export async function preflightGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
): Promise<{ reason: "Already compacted" | "Nothing to compact (session too small)" } | undefined> {
  assertGatewayHistoryModeSupported(params);
  // Full active-window recovery also re-distills an existing summary boundary.
  if (params.historyMode === "summary_only") {
    return undefined;
  }
  if (!usesLegacyOpenClawCompaction(params)) {
    return undefined;
  }
  try {
    const transcriptEvents = await loadTranscriptEvents({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionStoreKey,
      storePath: params.storePath,
    });
    const tree = scanSessionTranscriptTree(transcriptEvents);
    const branch = selectSessionTranscriptTreePathNodes(tree, tree.leafId)
      .map((node) => node.entry)
      .filter(isIndexedSessionEntry);
    const preflight = preflightManualSessionCompaction(branch, {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 0,
    });
    return preflight.compactable ? undefined : { reason: preflight.reason };
  } catch {
    // Preserve the existing compaction error path for malformed or unavailable transcripts.
    return undefined;
  }
}

export async function runGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
  host?: Parameters<typeof compactEmbeddedAgentSession>[1],
): Promise<Awaited<ReturnType<typeof compactEmbeddedAgentSession>>> {
  assertGatewayHistoryModeSupported(params);
  const customInstructions = normalizeOptionalString(params.customInstructions);
  const transcriptTarget = await resolveGatewayCompactionTranscriptTarget(params);
  const resolvedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: params.entry.spawnedBy,
      workspaceDir: params.entry.spawnedWorkspaceDir,
      cwd: params.entry.spawnedCwd,
    }) ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const compactionCliTarget = resolveManualCompactionCliTarget({
    provider: resolvedModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const primaryConversation = resolveCurrentSessionPrimaryConversation(transcriptTarget);
  const result = await compactEmbeddedAgentSession(
    {
      contextEngineAgentId: params.agentId,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      sessionTarget: {
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      allowGatewaySubagentBinding: true,
      sessionFile: transcriptTarget.sessionKey,
      workspaceDir,
      cwd: normalizeOptionalString(params.entry.spawnedCwd),
      config: params.cfg,
      // Current delivery owns the account; origin can retain historical identity.
      // Group session keys do not carry an account themselves.
      agentAccountId:
        params.entry.delivery?.kind === "external"
          ? params.entry.delivery.context?.accountId
          : undefined,
      conversationRoutePeerId: primaryConversation?.routeContext?.peerId,
      chatType: primaryConversation?.kind,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      authProfileId:
        compactionCliTarget.cliSessionBinding?.authProfileId ?? params.entry.authProfileOverride,
      authProfileIdSource: resolveCollapsedSessionAuthPinSource(params.entry),
      agentHarnessId: compactionCliTarget.agentHarnessId,
      cliSessionId: compactionCliTarget.cliSessionId,
      cliSessionBinding: compactionCliTarget.cliSessionBinding,
      sessionEntry: params.entry,
      modelSelectionLocked: params.entry.modelSelectionLocked === true,
      thinkLevel: normalizeThinkLevel(params.entry.thinkingLevel),
      reasoningLevel: normalizeReasoningLevel(params.entry.reasoningLevel),
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      trigger: "manual",
      ...(params.historyMode ? { historyMode: params.historyMode } : {}),
      ...(customInstructions
        ? { customInstructions: resolveCompactionInstructions(customInstructions, undefined) }
        : {}),
    },
    host,
  );
  return await confirmGatewaySessionCompactionHistoryMode(params, result);
}

/** Re-read at the terminal lifecycle fence before promising summary-only context. */
export async function confirmGatewaySessionCompactionHistoryMode(
  params: Pick<
    GatewaySessionCompactionParams,
    "agentId" | "sessionId" | "sessionStoreKey" | "storePath" | "historyMode"
  >,
  result: Awaited<ReturnType<typeof compactEmbeddedAgentSession>>,
): Promise<Awaited<ReturnType<typeof compactEmbeddedAgentSession>>> {
  if (params.historyMode !== "summary_only" || !result.ok || !result.compacted) {
    return result;
  }
  const events = await loadTranscriptEvents({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  });
  const tree = scanSessionTranscriptTree(events);
  const branch = selectSessionTranscriptTreePathNodes(tree, tree.leafId)
    .map((node) => node.entry)
    .filter(isIndexedSessionEntry);
  const leaf = branch.at(-1);
  const messages = buildSessionContext(branch).messages;
  if (
    !result.result?.summary ||
    !result.result.firstKeptEntryId ||
    leaf?.type !== "compaction" ||
    leaf.id !== leaf.firstKeptEntryId ||
    leaf.id !== result.result.firstKeptEntryId ||
    leaf.summary !== result.result.summary ||
    messages.length !== 1 ||
    messages[0]?.role !== "compactionSummary" ||
    (result.result.sessionId && result.result.sessionId !== params.sessionId)
  ) {
    throw new Error(
      "summary_only outcome is unconfirmed; reconcile the retained checkpoint before retry.",
    );
  }
  return { ...result, historyMode: "summary_only" };
}
