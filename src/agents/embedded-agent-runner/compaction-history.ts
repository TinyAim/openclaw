// Per-call selection of the existing manual compaction history window.
import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentMessage } from "../runtime/index.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";

/** Full-summary recovery includes the entire active window in its summarizer. */
export function limitCompactionHistory(
  messages: AgentMessage[],
  params: {
    historyMode?: "preserve_recent" | "summary_only";
    sessionKey?: string;
    config?: OpenClawConfig;
    agentAccountId?: string;
    conversationRoutePeerId?: string;
    chatType?: ChatType;
  },
  model: Parameters<typeof preserveCompactionReplayWindow>[2],
  replay: Parameters<typeof preserveCompactionReplayWindow>[3],
): AgentMessage[] {
  if (params.historyMode === "summary_only") {
    return messages;
  }
  return preserveCompactionReplayWindow(
    messages,
    limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey(params.sessionKey, params.config, {
        accountId: params.agentAccountId,
        peerId: params.conversationRoutePeerId,
        chatType: params.chatType,
      }),
    ),
    model,
    replay,
  );
}
