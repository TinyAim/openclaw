import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionRestoreParams,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { clearSessionLifecycleQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions.js";
import {
  branchCompactionCheckpointSession,
  restoreCompactionCheckpointSession,
  readSessionCompactionCheckpoint,
  checkpointStateMatches,
  type SqliteCompactionCheckpointSessionMutationResult,
} from "../../config/sessions/session-accessor.sqlite-checkpoint.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { buildDashboardSessionKey } from "../session-create-key.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { resolveSessionWorkerPlacementMutationError } from "../worker-environments/session-placement-lifecycle.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { waitForTerminalSessionRunSettlement } from "./session-run-settlement.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const LOCKED = "Checkpoint branch and restore are unavailable while model selection is locked.";
function createCheckpointHandler(action: "branch" | "restore"): GatewayRequestHandler {
  return async (options) => {
    const { params, respond, context, client } = options;
    if (
      !assertValidParams(
        params,
        action === "branch"
          ? validateSessionsCompactionBranchParams
          : validateSessionsCompactionRestoreParams,
        `sessions.compaction.${action}`,
        respond,
      )
    )
      return;
    const key = requireSessionKey(params.key, respond);
    if (!key) return;
    const checkpointId = params.checkpointId.trim();
    const fail = (error: ErrorShape | string) =>
      respond(
        false,
        undefined,
        typeof error === "string" ? errorShape(ErrorCodes.INVALID_REQUEST, error) : error,
      );
    if (!checkpointId) return fail("checkpointId required");
    const cfg = context.getRuntimeConfig();
    const requested = resolveRequestedSessionAgentId(cfg, key, params.agentId);
    if (!requested.ok) return fail(requested.error);
    const request = readGatewayRequestMutationAuthority(options);
    const assertCurrent = () => {
      request.assertCurrent();
      options.signal?.throwIfAborted();
    };
    const load = async () => {
      const target = await resolveGatewaySessionStoreTargetInWorker({
        cfg,
        key,
        agentId: requested.agentId,
        assertActive: assertCurrent,
      });
      assertCurrent();
      return {
        target,
        entry: await readSessionEntryReadOnlyInWorker(
          {
            agentId: target.agentId,
            sessionKey: target.canonicalKey,
            storePath: target.storePath,
            readConsistency: "latest",
          },
          assertCurrent,
        ),
      };
    };
    const initial = await load();
    const { target, entry } = initial;
    if (!entry?.sessionId) return fail(`session not found: ${key}`);
    if (!readSessionCompactionCheckpoint(entry, checkpointId))
      return fail(`checkpoint not found: ${checkpointId}`);
    if (entry.modelSelectionLocked === true) return fail(LOCKED);
    if (entry.initializationPending)
      return fail(
        errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is initializing; retry later.`),
      );
    const expectedState = {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      activeWriterRunId: entry.activeWriterRunId,
    };
    const conflict = () =>
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Session ${key} changed before checkpoint ${action}. Retry.`,
        { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
      );
    const complete = (result: SqliteCompactionCheckpointSessionMutationResult) => {
      switch (result.status) {
        case "missing-session":
          return fail(`session not found: ${key}`);
        case "missing-checkpoint":
        case "missing-boundary":
          return fail(`checkpoint not found: ${checkpointId}`);
        case "model-selection-locked":
          return fail(LOCKED);
        case "conflict":
          return fail(conflict());
        case "failed":
          return fail(
            errorShape(ErrorCodes.UNAVAILABLE, `failed to ${action} checkpoint transcript`),
          );
        case "created":
          break;
        default:
          return result satisfies never;
      }
      // Publication is acknowledged before the public response or invalidation event.
      respond(
        true,
        {
          ok: true,
          ...(action === "branch" ? { sourceKey: target.canonicalKey } : {}),
          key: result.key,
          sessionId: result.entry.sessionId,
          checkpoint: result.checkpoint,
          entry: result.entry,
        },
        undefined,
      );
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        reason: `checkpoint-${action}`,
      });
      if (action === "branch")
        emitSessionsChanged(context, {
          sessionKey: result.key,
          agentId: target.agentId,
          reason: "checkpoint-branch",
        });
    };
    if (action === "branch") {
      const assertCreationCurrent = () => {
        assertCurrent();
        const error = authorizeGatewaySessionCreation({
          cfg: context.getRuntimeConfig(),
          client,
          agentId: target.agentId,
        });
        if (error) throw new Error(error.message);
      };
      const creationError = authorizeGatewaySessionCreation({
        cfg,
        client,
        agentId: target.agentId,
      });
      if (creationError) return fail(creationError);
      const creation = resolveOperatorSessionCreation(client);
      const sandbox =
        creation.actor?.id === GATEWAY_OWNER_PROFILE_ID
          ? entry.sandbox
          : resolveCreatorSandbox(cfg, creation);
      return complete(
        await branchCompactionCheckpointSession({
          agentId: target.agentId,
          storePath: target.storePath,
          sourceKey: target.canonicalKey,
          sourceStoreKey: target.canonicalKey,
          nextKey: buildDashboardSessionKey(target.agentId, {
            incognito: isIncognitoSessionKey(target.canonicalKey),
          }),
          checkpointId,
          expectedState,
          commitGuard: assertCreationCurrent,
          ...(creation.actor ? { creation: { ...creation, sandbox } } : {}),
        }),
      );
    }
    const placement = () =>
      resolveSessionWorkerPlacementMutationError({
        action: "restore",
        context,
        key,
        sessionId: entry.sessionId,
      });
    const placementError = placement();
    if (placementError) return fail(placementError.message);
    const identities = [key, target.canonicalKey, entry.sessionId, entry.lifecycleRevision];
    let preparationError: ErrorShape | undefined;
    const assertRestoreCurrent = () => {
      assertCurrent();
      const error = placement();
      if (error) throw new Error(error.message);
    };
    await runExclusiveSessionLifecycleMutation("restore", {
      scope: target.storePath,
      identities,
      signal: options.signal,
      prepare: async () => {
        assertRestoreCurrent();
        const current = await load();
        if (
          !current.entry ||
          !checkpointStateMatches(current.entry, expectedState) ||
          current.target.storePath !== target.storePath ||
          current.target.agentId !== target.agentId ||
          current.target.canonicalKey !== target.canonicalKey
        ) {
          preparationError = conflict();
          return;
        }
        if (current.entry.modelSelectionLocked) {
          preparationError = errorShape(ErrorCodes.INVALID_REQUEST, LOCKED);
          return;
        }
        if (!readSessionCompactionCheckpoint(current.entry, checkpointId)) {
          preparationError = conflict();
          return;
        }
        clearSessionLifecycleQueues({
          assertCurrent: assertRestoreCurrent,
          keys: identities,
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          sessionId: entry.sessionId,
        });
        const drained = await interruptSessionWorkAdmissions({
          scope: target.storePath,
          identities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        assertRestoreCurrent();
        if (
          !drained ||
          !(await waitForTerminalSessionRunSettlement({
            context,
            storePath: target.storePath,
            requestedKey: key,
            canonicalKey: target.canonicalKey,
            sessionId: entry.sessionId,
            agentId: target.agentId,
            signal: options.signal,
          }))
        ) {
          preparationError = errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${key} is still active; try again.`,
          );
        }
      },
      run: async () => {
        assertRestoreCurrent();
        if (preparationError) return fail(preparationError);
        // The worker also compares the exact original writer/revision under its transaction.
        return complete(
          await restoreCompactionCheckpointSession({
            agentId: target.agentId,
            storePath: target.storePath,
            sessionKey: target.canonicalKey,
            sessionStoreKey: target.canonicalKey,
            checkpointId,
            expectedState,
            commitGuard: assertRestoreCurrent,
          }),
        );
      },
    });
  };
}

export const sessionCheckpointHandlers: GatewayRequestHandlers = {
  "sessions.compaction.branch": createCheckpointHandler("branch"),
  "sessions.compaction.restore": createCheckpointHandler("restore"),
};
