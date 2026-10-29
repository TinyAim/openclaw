import { Value } from "typebox/value";
import {
  ErrorCodes,
  errorShape,
  SessionCompactionCheckpointSchema,
  validateSessionsCompactionListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readSessionCompactionCheckpoint } from "../../config/sessions/session-accessor.sqlite-checkpoint.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
} from "../../config/sessions/store-entry.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadAccessorSessionEntryForGatewayTarget, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionCheckpointQueryHandlers: GatewayRequestHandlers = {
  "sessions.compaction.list": ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionListParams,
        "sessions.compaction.list",
        respond,
      )
    )
      return;
    const key = requireSessionKey(params.key, respond);
    if (!key) return;
    const cfg = context.getRuntimeConfig();
    const requested = resolveRequestedSessionAgentId(cfg, key, params.agentId);
    if (!requested.ok) return respond(false, undefined, requested.error);
    const { entry, canonicalKey } = loadAccessorSessionEntryForGatewayTarget({
      key,
      cfg,
      agentId: requested.agentId,
    });
    const records = entry?.compactionCheckpoints ?? [];
    if (!Array.isArray(records))
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Checkpoint metadata is invalid."),
      );
    const checkpoints = records.map((record) =>
      typeof record?.checkpointId === "string"
        ? readSessionCompactionCheckpoint(entry!, record.checkpointId)
        : undefined,
    );
    const allowedKeys = collectSessionEntryLookupKeys(canonicalKey);
    if (
      checkpoints.some(
        (record) =>
          !record ||
          !Value.Check(SessionCompactionCheckpointSchema, record) ||
          !allowedKeys.includes(normalizeStoreSessionKey(record.sessionKey)),
      )
    ) {
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Checkpoint metadata is invalid."),
      );
    }
    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        checkpoints: checkpoints.toSorted((a, b) => b!.createdAt - a!.createdAt),
      },
      undefined,
    );
  },
};
