/** Durable rendering, upload and callback delivery with exact execution fences. */
import { createHash, randomUUID } from "node:crypto";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "../../node-host/node-worker-process-identity.js";
import type {
  MediaStudioSpatialReferenceRenderHttpExecutor,
  SpatialReferenceRelayDispatch,
  SpatialReferenceRelayDispatchAck,
} from "../media-studio-spatial-reference-render-http.js";
import type { UploadReceipt } from "./reference-callback.js";
import {
  callbackFromFinalizedReceipts,
  callbackWithFinalizedReceipts,
  parseReferenceReadback,
  referenceGrant,
  referenceIdentity,
  referenceTerminal,
} from "./reference-execution.js";
import {
  outputKey,
  type SpatialReferenceJournalRow,
  type SpatialReferenceJournalOwner,
  type SpatialReferenceJournalWorker,
  type SpatialReferenceFinalizedOutput,
  type SpatialReferenceJournalScopeGuardian,
} from "./reference-journal-record.js";
import {
  createSpatialReferenceJournal,
  type SpatialReferenceJournal,
} from "./reference-journal.js";
import {
  prepareReferenceRender,
  prepareMissingReferenceRender,
  type ReferenceLifecycle,
} from "./reference-render.js";
import {
  readTerminalCallbackResponse,
  createTerminalCallbackReplayBackoff,
} from "./terminal-callback-delivery.js";
import type { SpatialReferenceV2Renderer } from "./v2-renderer.js";

const UPLOAD_PATH = "/v1/control/media-gen/runtime/spatial-reference/upload";
const CALLBACK_PATH = "/v1/control/media-gen/runtime/spatial-reference/callback";
const TOKEN_HEADER = "x-wisclaw-media-gen-runtime-token";
const LEASE_MS = 10_000;

function buildAck(input: SpatialReferenceRelayDispatch): SpatialReferenceRelayDispatchAck {
  const digest = createHash("sha256")
    .update(`${input.runtimeId}:${input.runtimeIdempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return {
    ok: true,
    accepted: true,
    deferredSettlement: true,
    runtimeId: input.runtimeId,
    executionId: `spatial_${digest}`,
    taskId: input.taskId,
    materializationId: input.materializationId,
    attempt: input.attempt,
    dispatchAttemptId: input.dispatchAttemptId,
    sequence: input.sequence,
    leaseExpiresAt: input.leaseExpiresAt,
    intentFingerprint: input.intentFingerprint,
    executionFingerprint: input.executionFingerprint,
    blueprintDigest: input.blueprint.blueprintDigest,
    ...(input.environmentRevisionId ? { environmentRevisionId: input.environmentRevisionId } : {}),
    ...(input.environmentRevisionChecksum
      ? { environmentRevisionChecksum: input.environmentRevisionChecksum }
      : {}),
  };
}

async function readData<T>(response: Response): Promise<T> {
  const raw = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string };
  } | null;
  if (!response.ok || !raw?.data)
    throw new Error(`spatial_control_api_rejected:${raw?.error?.code ?? response.status}`);
  return raw.data;
}

export function createMediaStudioSpatialReferenceRuntimeExecutor(options: {
  controlApiUrl: string;
  runtimeId: string;
  token: string;
  fetchImpl?: typeof fetch;
  log?: { warn?: (message: string) => void };
  v2Renderer?: SpatialReferenceV2Renderer;
  journal?: SpatialReferenceJournal;
  /** Credential-free locator for the guardian's narrow writer; factory-owned only. */
  guardianJournal?: { stateDir: string; namespace: string };
}): MediaStudioSpatialReferenceRenderHttpExecutor & {
  stop(): void;
  flushCallbacksOnce(): Promise<void>;
} {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.controlApiUrl.replace(/\/+$/, "");
  const journal = options.journal ?? createSpatialReferenceJournal();
  const ownerInstanceId = randomUUID();
  const parent = requireNodeWorkerProcessIdentity(process.pid);
  const active = new Map<string, AbortController>();
  const scheduled = new Set<string>();
  const pendingInputs = new Map<string, SpatialReferenceRelayDispatch>();
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  let flushing: Promise<void> | undefined;
  const backoff = createTerminalCallbackReplayBackoff({ baseDelayMs: 5000 });
  const warn = (error: unknown) =>
    options.log?.warn?.(`spatial reference recovery pending: ${String(error)}`);

  const readback = async (row: SpatialReferenceJournalRow) => {
    if (!row.identity || !row.expectedOutputs)
      throw new Error("spatial_recovery_frozen_identity_missing");
    const url = new URL(`${base}${UPLOAD_PATH}`);
    for (const key of [
      "workspaceId",
      "runtimeId",
      "taskId",
      "materializationId",
      "dispatchAttemptId",
      "executionFingerprint",
      "intentFingerprint",
      "sequence",
      "attempt",
    ] as const)
      url.searchParams.set(key, String(row.identity[key]));
    const data = await readData<unknown>(
      await fetchImpl(url, {
        method: "GET",
        headers: { [TOKEN_HEADER]: options.token },
        signal: AbortSignal.timeout(15_000),
      }),
    );
    return parseReferenceReadback(data, row.identity, row.expectedOutputs, row.prepared?.outputs);
  };

  const flushCallbacks = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const row of await journal.list()) {
        if (!row.callback || row.delivered || !backoff.isDue(row.key)) continue;
        try {
          const response = await fetchImpl(`${base}${CALLBACK_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", [TOKEN_HEADER]: options.token },
            body: JSON.stringify(row.callback),
            signal: AbortSignal.timeout(15_000),
          });
          await readTerminalCallbackResponse(response);
          await journal.delivered(row.key, row.callback);
          backoff.clear(row.key);
          pendingInputs.delete(row.key);
        } catch (error) {
          backoff.recordRetry(row.key);
          warn(error);
        }
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  const run = async (key: string, input?: SpatialReferenceRelayDispatch): Promise<void> => {
    let row = await journal.get(key);
    if (!row?.identity || !row.expectedOutputs || row.callback) return;
    const identity = row.identity;
    const owner: SpatialReferenceJournalOwner = {
      epoch: randomUUID(),
      pid: parent.pid,
      pidStartTimeMs: parent.startTime,
      ownerInstanceId,
    };
    const scopeKey = `spatial-reference:${identity.runtimeId}:${identity.executionId}:${owner.epoch}`;
    const runId = `spatial-reference:${identity.runtimeId}:${identity.executionId}:${owner.epoch}`;
    const context = (scopeEvidence?: "extinct" | "never_spawned") => ({
      identity,
      owner,
      nowMs: Date.now(),
      ...(scopeEvidence ? { scopeEvidence } : {}),
    });
    let previousOwner;
    if (row.claim) {
      const observed = inspectNodeWorkerProcessIdentity({
        pid: row.claim.pid,
        startTime: row.claim.pidStartTimeMs,
      });
      if (observed !== "dead" && observed !== "reused") return;
      if (row.worker && !row.worker.exited) {
        const state = inspectNodeWorkerProcessIdentity({
          pid: row.worker.pid,
          startTime: row.worker.startTime,
        });
        if (state !== "dead" && state !== "reused") return;
      }
      if (row.claim.leaseExpiresAtMs > Date.now()) return;
      previousOwner = {
        pid: row.claim.pid,
        pidStartTimeMs: row.claim.pidStartTimeMs,
        scopeId: row.claim.scopeKey,
        runId: row.claim.runId,
        observed,
        observedAtMs: Date.now(),
        // A root exit is not descendant-scope extinction. The journal alone
        // checks an independently persisted exact-scope receipt for recovery.
        scopeExtinct: false,
      };
    }
    const isRecovery = Boolean(row.prepared || row.claim);
    const recoveryExpired = Date.now() - (row.acceptedAtMs ?? Date.now()) > 180_000;
    let recoveryFailure: string | undefined;
    let recovered: Awaited<ReturnType<typeof readback>> | undefined;
    if (isRecovery && row.prepared && !row.cancelled) {
      try {
        recovered = await readback(row);
        if (recovered.cancelled) row = await journal.cancel(key, identity.dispatchAttemptId);
        if (recovered.pendingSlots.length) {
          if (!recoveryExpired) return;
          recoveryFailure = "spatial_recovery_upload_pending_timeout";
        }
        if (!input && recovered.receipts.length !== row.expectedOutputs!.length && !row.cancelled) {
          if (!recoveryExpired) return;
          recoveryFailure = "spatial_recovery_dispatch_missing";
        }
      } catch (error) {
        if (!recoveryExpired) throw error;
        recoveryFailure = "spatial_recovery_readback_unavailable";
      }
    } else if (!input && !row.cancelled) {
      if (!recoveryExpired) return;
      recoveryFailure = "spatial_recovery_dispatch_missing";
    }
    const claimed = await journal.claim({
      identity,
      owner,
      expectedOutputs: row.expectedOutputs!,
      scopeKey,
      runId,
      knownFinalizedReceipts: recovered?.receipts,
      nowMs: Date.now(),
      leaseExpiresAtMs: Date.now() + LEASE_MS,
      previousOwner,
      ...(row.cancelled ? { mode: "stop_only" as const } : {}),
    });
    if (!claimed.claimed) {
      warn(new Error(`spatial_recovery_claim_rejected:${claimed.reason}`));
      return;
    }
    row = claimed.row;
    const controller = new AbortController();
    active.set(key, controller);
    let worker: SpatialReferenceJournalWorker | undefined;
    let spawnIntentRecorded = false;
    let guardian: SpatialReferenceJournalScopeGuardian | undefined;
    const fixtureRenderer = Boolean(options.v2Renderer && !options.guardianJournal);
    // The guardian, not this parent, persists either `never_spawned` or
    // `unknown`. The parent only consumes that exact durable result on finish.
    const observeNeverSpawned = async () => undefined;
    const terminalScopeEvidence = (): "extinct" | "never_spawned" | undefined =>
      fixtureRenderer
        ? "never_spawned"
        : worker?.exited
          ? "extinct"
          : !spawnIntentRecorded || input?.contractVersion !== "spatial_reference_render/v2"
            ? "never_spawned"
            : undefined;
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void journal
        .claim({
          identity,
          owner,
          expectedOutputs: row!.expectedOutputs!,
          nowMs: Date.now(),
          leaseExpiresAtMs: Date.now() + LEASE_MS,
        })
        .then((result) => {
          if (!result.claimed) controller.abort(new Error(`spatial_reference_${result.reason}`));
        })
        .catch((error) => controller.abort(error))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 2000);
    heartbeat.unref?.();
    const lifecycle: ReferenceLifecycle = {
      ...(row.claim
        ? { executionScope: { scopeKey: row.claim.scopeKey, runId: row.claim.runId } }
        : {}),
      ...(options.guardianJournal
        ? {
            guardianJournal: {
              ...options.guardianJournal,
              identity,
              owner,
              guardianFor: (receipt) =>
                guardian &&
                guardian.pid === receipt.pid &&
                guardian.pidStartTimeMs === receipt.startTime &&
                guardian.generation === receipt.generation
                  ? guardian
                  : undefined,
            },
          }
        : {}),
      onGuardianLaunched: async (receipt) => {
        guardian = {
          protocol: "spatial_guardian/v1",
          guardianId: `spatial-guardian:${owner.epoch}:${receipt.pid}`,
          generation: receipt.generation,
          pid: receipt.pid,
          pidStartTimeMs: receipt.startTime,
          guardianBuildDigest: identity.rendererBuildDigest,
          armedAtMs: Date.now(),
        };
        await journal.armScopeGuardian({ ...context(), guardian });
      },
      onSpawnIntent: async () => {
        if (!guardian) throw new Error("spatial_guardian_identity_missing");
        spawnIntentRecorded = true;
      },
      onLaunched: async (receipt) => {
        worker = {
          pid: receipt.pid,
          startTime: receipt.startTime,
          scopeId: receipt.scopeKey,
          runId: receipt.runId,
          workerTokenDigest: createHash("sha256").update(receipt.runId).digest("hex"),
        };
        // The injected renderer is a fixture-only seam. Production factory
        // construction always supplies guardianJournal and therefore must
        // have observed onGuardianLaunched before accepting a worker.
        if (!guardian && (options.guardianJournal || !options.v2Renderer))
          throw new Error("spatial_guardian_identity_missing");
        if (!fixtureRenderer)
          await journal.checkpoint({ ...context(), phase: "worker_started", worker });
      },
      onStartAuthorized: async (_guardian, receipt) => {
        if (
          !guardian ||
          !worker ||
          receipt.pid !== worker.pid ||
          receipt.startTime !== worker.startTime
        ) {
          throw new Error("spatial_guardian_start_authorization_invalid");
        }
      },
      onScopeObservation: async (observation) => {
        if (
          !guardian ||
          observation.guardian.pid !== guardian.pid ||
          observation.guardian.startTime !== guardian.pidStartTimeMs ||
          observation.guardian.generation !== guardian.generation ||
          !worker ||
          observation.worker.pid !== worker.pid ||
          observation.worker.startTime !== worker.startTime
        ) {
          throw new Error("spatial_guardian_scope_observation_invalid");
        }
      },
      onExited: async (receipt) => {
        if (
          !worker ||
          receipt.pid !== worker.pid ||
          receipt.startTime !== worker.startTime ||
          receipt.scopeKey !== worker.scopeId
        ) {
          throw new Error("spatial_v2_stop_unconfirmed");
        }
        worker = {
          ...worker,
          exited: {
            atMs: Date.now(),
            reason: controller.signal.aborted ? "cancelled" : "completed",
          },
        };
        if (!fixtureRenderer)
          await journal.checkpoint({ ...context(), phase: "worker_exited", worker });
      },
    };
    try {
      if (recoveryFailure) {
        await observeNeverSpawned();
        await journal.finish(
          key,
          referenceTerminal(identity, "failed", recoveryFailure),
          context("never_spawned"),
        );
        return;
      }
      if (row.cancelled) {
        await observeNeverSpawned();
        await journal.finish(
          key,
          referenceTerminal(identity, "cancelled"),
          context("never_spawned"),
        );
        return;
      }
      let prepared = row.prepared;
      const finalized = [...(row.knownFinalizedReceipts ?? [])];
      const missing = row.expectedOutputs!.filter(
        (e) => !finalized.some((r) => outputKey(e) === outputKey(r)),
      );
      if (missing.length) {
        if (!input || !row.ack) throw new Error("spatial_recovery_dispatch_required");
        await journal.checkClaim(context());
        const result = prepared
          ? await prepareMissingReferenceRender(
              input,
              row.expectedOutputs!,
              missing,
              prepared,
              controller.signal,
              options.v2Renderer,
              lifecycle,
            )
          : await prepareReferenceRender(
              input,
              row.ack,
              row.expectedOutputs!,
              controller.signal,
              options.v2Renderer,
              lifecycle,
            );
        if (!prepared) {
          await journal.checkpoint({
            ...context(),
            phase: "render_proof",
            renderProof: {
              rendererBuildDigest: identity.rendererBuildDigest,
              completedAtMs: Date.now(),
            },
          });
          prepared = {
            callback: result.callback,
            outputs: result.outputs.map(({ bytes: _bytes, ...proof }) => proof),
          };
          await journal.checkpoint({ ...context(), phase: "prepared", prepared });
        }
        if (input.contractVersion === "spatial_reference_render/v2") {
          const handoffSize = Buffer.from(JSON.stringify(prepared.callback)).toString(
            "base64url",
          ).length;
          const transportSize =
            handoffSize +
            Buffer.byteLength(options.token) +
            Buffer.byteLength(base) +
            Buffer.byteLength(identity.workspaceId) +
            Buffer.byteLength(identity.runtimeId);
          if (handoffSize > 12_288 || transportSize > 15_360)
            throw new Error("spatial_terminal_handoff_header_limit");
        }
        for (const output of result.outputs) {
          await journal.checkClaim(context());
          if (controller.signal.aborted) throw controller.signal.reason;
          const grant = referenceGrant(input, output);
          if (!grant?.grantToken || grant.artifactId !== output.artifactId)
            throw new Error("output_upload_grant_required");
          const uploadUrl = new URL(`${base}${UPLOAD_PATH}`);
          uploadUrl.searchParams.set("workspaceId", identity.workspaceId);
          uploadUrl.searchParams.set("runtimeId", identity.runtimeId);
          const { bytes: _pendingBytes, ...pendingProof } = output;
          const terminal =
            input.contractVersion === "spatial_reference_render/v2" &&
            finalized.length + 1 === row.expectedOutputs!.length
              ? callbackWithFinalizedReceipts(prepared.callback, [
                  ...finalized,
                  { ...pendingProof, storageKey: "" },
                ])
              : undefined;
          // The upload owner replaces the last, not-yet-known storageKey from its finalized receipt.
          if (terminal?.receipt) delete terminal.receipt.storageKey;
          if (terminal?.motionReferenceReceipt) delete terminal.motionReferenceReceipt.storageKey;
          for (const receipt of terminal?.referenceFileReceipts ?? []) delete receipt.storageKey;
          const response = await fetchImpl(uploadUrl, {
            method: "POST",
            headers: {
              "content-type": output.mimeType,
              [TOKEN_HEADER]: options.token,
              "x-wisclaw-spatial-upload-grant": grant.grantToken,
              ...(terminal
                ? {
                    "x-wisclaw-spatial-terminal-callback": Buffer.from(
                      JSON.stringify(terminal),
                    ).toString("base64url"),
                  }
                : {}),
            },
            body: output.bytes as unknown as BodyInit,
            signal: controller.signal,
          });
          const receipt = await readData<UploadReceipt>(response);
          if (
            receipt.artifactId !== output.artifactId ||
            receipt.size !== output.size ||
            receipt.sha256Hex !== output.sha256Hex ||
            receipt.mimeType !== output.mimeType ||
            !receipt.storageKey
          ) {
            throw new Error("upload_receipt_integrity_mismatch");
          }
          const { bytes: _bytes, ...proof } = output;
          const uploaded: SpatialReferenceFinalizedOutput = {
            ...proof,
            storageKey: receipt.storageKey,
          };
          await journal.checkpoint({
            ...context(),
            phase: "output_finalized",
            finalizedOutput: uploaded,
          });
          finalized.push(uploaded);
        }
      }
      if (!prepared) {
        if (input?.contractVersion === "spatial_reference_render/v2") {
          if (!spawnIntentRecorded) await observeNeverSpawned();
          const terminal = callbackFromFinalizedReceipts({
            dispatch: input,
            ack: row.ack!,
            expectedOutputs: row.expectedOutputs!,
            finalized,
          });
          const callback = structuredClone(terminal);
          if (callback.receipt) delete callback.receipt.storageKey;
          if (callback.motionReferenceReceipt) delete callback.motionReferenceReceipt.storageKey;
          for (const receipt of callback.referenceFileReceipts ?? []) delete receipt.storageKey;
          await journal.checkpoint({
            ...context(),
            phase: "prepared",
            prepared: {
              callback,
              outputs: finalized.map(({ storageKey: _storageKey, ...output }) => output),
            },
          });
          await journal.finish(
            key,
            callbackWithFinalizedReceipts(callback, finalized),
            context(terminalScopeEvidence()),
          );
          return;
        }
        throw new Error("spatial_recovery_render_proof_missing");
      }
      if (!spawnIntentRecorded) await observeNeverSpawned();
      await journal.finish(
        key,
        callbackWithFinalizedReceipts(prepared.callback, finalized),
        context(terminalScopeEvidence()),
      );
    } catch (error) {
      const latest = await journal.get(key);
      const message = error instanceof Error ? error.message : String(error);
      if (latest?.prepared && !latest.cancelled) {
        try {
          const proof = await readback(latest);
          if (
            !proof.cancelled &&
            proof.pendingSlots.length === 0 &&
            proof.receipts.length === latest.expectedOutputs?.length
          ) {
            for (const receipt of proof.receipts)
              await journal.checkpoint({
                ...context(),
                phase: "output_finalized",
                finalizedOutput: receipt,
              });
            await journal.finish(
              key,
              callbackWithFinalizedReceipts(latest.prepared.callback, proof.receipts),
              context(terminalScopeEvidence()),
            );
            return;
          }
        } catch (recoveryError) {
          warn(recoveryError);
        }
      }
      const cancelled =
        latest?.cancelled === true &&
        !message.startsWith("spatial_v2_stop_unconfirmed") &&
        (!worker || Boolean(worker.exited));
      await journal
        .finish(
          key,
          referenceTerminal(
            identity,
            cancelled ? "cancelled" : "failed",
            cancelled ? undefined : message.split(":", 1)[0]?.slice(0, 160),
          ),
          context(terminalScopeEvidence()),
        )
        .catch(warn);
    } finally {
      clearInterval(heartbeat);
      active.delete(key);
      const latest = await journal.get(key);
      if (latest?.claim?.epoch === owner.epoch)
        await journal
          .release({ ...context(terminalScopeEvidence()), ...(worker?.exited ? { worker } : {}) })
          .catch(warn);
      await flushCallbacks();
    }
  };

  const schedule = (key: string, input?: SpatialReferenceRelayDispatch) => {
    if (scheduled.has(key) || stopped) return;
    scheduled.add(key);
    queue = queue
      .then(() => run(key, input))
      .catch(warn)
      .finally(() => scheduled.delete(key));
  };
  const recover = async () => {
    await flushCallbacks();
    for (const row of await journal.list()) {
      if (row.identity && !row.callback && !active.has(row.key))
        schedule(row.key, pendingInputs.get(row.key));
    }
  };
  void recover().catch(warn);
  const timer = setInterval(() => {
    if (!stopped) void recover().catch(warn);
  }, 5000);
  timer.unref?.();
  return {
    async dispatch(input) {
      if (stopped) throw new Error("SPATIAL_REFERENCE_EXECUTOR_STOPPED");
      if (input.runtimeId !== options.runtimeId) throw new Error("runtime_id_mismatch");
      const ack = buildAck(input);
      const { identity, expectedOutputs } = referenceIdentity(input, ack);
      const accepted = await journal.accept(
        input.runtimeIdempotencyKey,
        ack,
        identity.frozenDispatchDigest,
        {
          identity,
          expectedOutputs,
          ...(input.contractVersion === "spatial_reference_render/v2" &&
          input.knownFinalizedReceipts
            ? {
                knownFinalizedReceipts: input.knownFinalizedReceipts.map((receipt) => ({
                  slot: receipt.slot,
                  ordinal: receipt.ordinal,
                  artifactId: receipt.artifactId,
                  size: receipt.size,
                  sha256Hex: receipt.sha256Hex,
                  mimeType: receipt.mimeType,
                  storageKey: receipt.storageKey,
                })),
              }
            : {}),
        },
      );
      if (!accepted.row.callback) {
        pendingInputs.set(identity.key, input);
        schedule(identity.key, input);
      }
      return accepted.row.ack!;
    },
    async cancel(input) {
      const row = await journal.cancel(input.runtimeIdempotencyKey, input.dispatchAttemptId);
      if (row.cancelled) {
        active.get(row.key)?.abort(new Error("spatial_v2_cancel_requested"));
        schedule(row.key, pendingInputs.get(row.key));
      }
      return { acknowledged: true, terminal: row.callback?.status === "cancelled" };
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const controller of active.values())
        controller.abort(new Error("spatial_executor_stopped"));
    },
    flushCallbacksOnce: recover,
  };
}
