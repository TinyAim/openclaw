import type { SpatialReferenceRelayDispatchAck } from "../media-studio-spatial-reference-render-http.js";
import type { SpatialReferenceTerminalCallback } from "./reference-callback.js";
import { referenceTerminal } from "./reference-execution.js";
import {
  applyExclusiveAdmissionClaim,
  applyExclusiveAdmissionRelease,
  isV3Lock,
  lockAdmission,
  quarantineLock,
  releasedLock,
  SPATIAL_REFERENCE_QUALIFICATION_KEY,
  SPATIAL_REFERENCE_RUNTIME_LOCK_KEY as RUNTIME_LOCK_KEY,
} from "./reference-journal-admission.js";
import type {
  SpatialReferenceExclusiveAdmissionClaimInput,
  SpatialReferenceExclusiveAdmissionReleaseInput,
  SpatialReferenceJournal,
  SpatialReferenceJournalAcceptDetails,
  SpatialReferenceJournalAcceptInput,
  SpatialReferenceJournalBackend,
  SpatialReferenceJournalCheckpointInput,
  SpatialReferenceJournalRecordSpawnIntentInput,
  SpatialReferenceJournalRecordWorkerPreparedInput,
  SpatialReferenceJournalAuthorizeWorkerStartInput,
  SpatialReferenceJournalClaimContext,
  SpatialReferenceJournalClaimInput,
  SpatialReferenceJournalClaimResult,
  SpatialReferenceJournalReleaseInput,
  SpatialReferenceJournalArmScopeGuardianInput,
  SpatialReferenceJournalScopeObservationInput,
  SpatialReferenceJournalReconcileScopeInput,
  SpatialReferenceJournalReconcileScopeResult,
} from "./reference-journal-contract.js";
import {
  canonicalJson,
  outputKey,
  sameClaimOwner,
  sameIdentity,
  sameOwner,
  SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
  type SpatialReferenceJournalClaimOwner,
  type SpatialReferenceJournalRow,
  type SpatialReferenceJournalStoredValue,
  type SpatialReferenceRuntimeLock,
  type SpatialReferenceJournalScopeGuardian,
  type SpatialReferenceJournalScopeRecovery,
} from "./reference-journal-record.js";
import {
  appendFinalized,
  asExecution,
  assertAck,
  assertClaim,
  assertExpectedOutputs,
  assertIdentity,
  assertOwner,
  assertPreparedOutput,
  assertWorker,
  cancelledCallback,
  clone,
  createAcceptedRow,
  fail,
  isExecution,
  missingOutputs,
  recomposePreparedCallback,
  sameAck,
} from "./reference-journal-validation.js";

export type {
  SpatialReferenceExclusiveAdmissionClaimInput,
  SpatialReferenceExclusiveAdmissionClaimResult,
  SpatialReferenceExclusiveAdmissionReleaseInput,
  SpatialReferenceExclusiveAdmissionReleaseResult,
  SpatialReferenceJournal,
  SpatialReferenceJournalAcceptDetails,
  SpatialReferenceJournalAcceptInput,
  SpatialReferenceJournalBackend,
  SpatialReferenceJournalCheckpointInput,
  SpatialReferenceJournalRecordSpawnIntentInput,
  SpatialReferenceJournalRecordWorkerPreparedInput,
  SpatialReferenceJournalAuthorizeWorkerStartInput,
  SpatialReferenceJournalClaimContext,
  SpatialReferenceJournalClaimInput,
  SpatialReferenceJournalClaimResult,
  SpatialReferenceJournalReleaseInput,
  SpatialReferenceJournalArmScopeGuardianInput,
  SpatialReferenceJournalScopeObservationInput,
  SpatialReferenceJournalReconcileScopeInput,
  SpatialReferenceJournalReconcileScopeResult,
  SpatialReferenceRuntimeAdmission,
} from "./reference-journal-contract.js";
export {
  SPATIAL_REFERENCE_QUALIFICATION_KEY,
  SPATIAL_REFERENCE_RUNTIME_LOCK_KEY,
} from "./reference-journal-admission.js";

type PairTransaction = {
  lookup(key: string): SpatialReferenceJournalStoredValue | undefined;
  set(key: string, value: SpatialReferenceJournalStoredValue): void;
};

function requirePair(
  transaction: PairTransaction,
  context: SpatialReferenceJournalClaimContext,
  options: { allowCancelledExit?: boolean } = {},
): { lock: SpatialReferenceRuntimeLock; row: SpatialReferenceJournalRow } {
  const rawLock = transaction.lookup(RUNTIME_LOCK_KEY);
  const row = asExecution(transaction.lookup(context.identity.key));
  if (
    !row?.identity ||
    !sameIdentity(row.identity, context.identity) ||
    row.schemaVersion !== SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION
  ) {
    fail("JOURNAL_STALE_CLAIM");
  }
  if (!isV3Lock(rawLock as SpatialReferenceRuntimeLock | undefined)) fail("JOURNAL_STALE_CLAIM");
  const lock = rawLock as SpatialReferenceRuntimeLock;
  if (
    lock.state !== "owned" ||
    lock.executionKey !== context.identity.key ||
    !lock.owner ||
    !row.claim ||
    !sameClaimOwner(lock.owner as SpatialReferenceJournalClaimOwner, row.claim) ||
    !sameOwner(row.claim, context.owner)
  ) {
    fail("JOURNAL_STALE_CLAIM");
  }
  if (!options.allowCancelledExit) assertClaim(row, context);
  return { lock, row };
}

function claimOwner(
  input: SpatialReferenceJournalClaimInput,
  current?: SpatialReferenceJournalClaimOwner,
): SpatialReferenceJournalClaimOwner {
  const heartbeat = current && sameOwner(current, input.owner);
  const claimVersion = heartbeat ? current.claimVersion : (current?.claimVersion ?? 0) + 1;
  const scopeKey =
    input.scopeKey ??
    (heartbeat
      ? current.scopeKey
      : `spatial-reference:${input.identity.runtimeId}:${input.identity.executionId}:${input.owner.epoch}`);
  const runId =
    input.runId ??
    (heartbeat
      ? current.runId
      : `spatial-reference:${input.identity.runtimeId}:${input.identity.executionId}:${input.owner.epoch}`);
  return {
    ...clone(input.owner),
    leaseExpiresAtMs: input.leaseExpiresAtMs,
    claimVersion,
    scopeKey,
    runId,
  };
}

function sameGuardian(
  left: SpatialReferenceJournalScopeGuardian,
  right: SpatialReferenceJournalScopeGuardian,
): boolean {
  return (
    left.protocol === right.protocol &&
    left.guardianId === right.guardianId &&
    left.generation === right.generation &&
    left.pid === right.pid &&
    left.pidStartTimeMs === right.pidStartTimeMs &&
    left.guardianBuildDigest === right.guardianBuildDigest
  );
}

function assertGuardian(guardian: SpatialReferenceJournalScopeGuardian): void {
  if (
    guardian.protocol !== "spatial_guardian/v1" ||
    !guardian.guardianId ||
    !guardian.generation ||
    !guardian.guardianBuildDigest ||
    !Number.isSafeInteger(guardian.pid) ||
    guardian.pid < 1 ||
    !Number.isSafeInteger(guardian.pidStartTimeMs) ||
    guardian.pidStartTimeMs < 0 ||
    !Number.isSafeInteger(guardian.armedAtMs) ||
    guardian.armedAtMs < 0
  ) {
    fail("JOURNAL_SCOPE_GUARDIAN_INVALID");
  }
}

function recoveryMatchesClaim(
  recovery: SpatialReferenceJournalScopeRecovery | undefined,
  claim: SpatialReferenceJournalClaimOwner | undefined,
): boolean {
  return Boolean(
    recovery &&
    claim &&
    recovery.claimVersion === claim.claimVersion &&
    sameOwner(recovery.owner, claim) &&
    (!recovery.worker ||
      (recovery.worker.scopeId === claim.scopeKey && recovery.worker.runId === claim.runId)),
  );
}

function isExactScopeExtinct(
  row: SpatialReferenceJournalRow,
  claim: SpatialReferenceJournalClaimOwner | undefined,
  expected: "extinct" | "never_spawned" | undefined,
): boolean {
  const recovery = row.scopeRecovery;
  if (!expected || !recovery || !claim || !recoveryMatchesClaim(recovery, claim)) {
    return false;
  }
  if (recovery.state !== expected) {
    return false;
  }
  if (expected === "never_spawned") {
    return !row.worker && row.launchState === "armed";
  }
  if (
    recovery.guardian.pid === claim.pid &&
    recovery.guardian.pidStartTimeMs === claim.pidStartTimeMs
  )
    return false;
  return Boolean(
    recovery.worker &&
    recovery.proof &&
    exactScopeProof(recovery.worker, recovery.proof, row.worker),
  );
}

function exactScopeProof(
  observedWorker: Pick<SpatialReferenceJournalWorker, "pid" | "startTime">,
  proof: NonNullable<SpatialReferenceJournalScopeRecovery["proof"]>,
  rowWorker?: SpatialReferenceJournalWorker,
): boolean {
  if (
    !rowWorker ||
    rowWorker.pid !== observedWorker.pid ||
    rowWorker.startTime !== observedWorker.startTime
  )
    return false;
  if (proof.protocol === "windows_job_v1") {
    return (
      proof.activeProcessCount === 0 &&
      proof.workerPid === observedWorker.pid &&
      proof.workerStartTime === observedWorker.startTime
    );
  }
  return (
    proof.processGroupId === observedWorker.pid &&
    (proof.rootState === "dead" || proof.rootState === "reused")
  );
}

function scopeExitIsSafe(
  row: SpatialReferenceJournalRow,
  claim: SpatialReferenceJournalClaimOwner | undefined,
  evidence: "extinct" | "never_spawned" | undefined,
): boolean {
  if (isExactScopeExtinct(row, claim, evidence)) {
    return true;
  }
  // v1 has no supervised child scope.  A v2 execution cannot use the old
  // no-worker shortcut: after a crash it needs the independently durable
  // guardian receipt, even when the child never reached a checkpoint.
  return (
    evidence === "never_spawned" &&
    !row.worker &&
    (row.identity?.contractVersion !== "spatial_reference_render/v2" ||
      (!row.scopeRecovery && row.launchState === undefined))
  );
}

export function createSpatialReferenceJournalStore(params: {
  authority: "memory" | "sqlite";
  backend: SpatialReferenceJournalBackend;
}): SpatialReferenceJournal {
  const read = (key: string): SpatialReferenceJournalRow | undefined =>
    asExecution(params.backend.lookup(key));
  const write = (
    key: string,
    update: (row: SpatialReferenceJournalRow | undefined) => SpatialReferenceJournalRow,
  ): SpatialReferenceJournalRow => {
    let written: SpatialReferenceJournalRow | undefined;
    params.backend.update(key, (current) => {
      written = update(asExecution(current));
      return clone(written);
    });
    if (!written) fail("JOURNAL_WRITE_FAILED");
    return clone(written);
  };
  const pair = <T>(key: string, mutate: (transaction: PairTransaction) => T): T =>
    params.backend.transaction([RUNTIME_LOCK_KEY, key], mutate);
  const runtimeLock = (): SpatialReferenceRuntimeLock | undefined => {
    const value = params.backend.lookup(RUNTIME_LOCK_KEY);
    if (!value) return undefined;
    if (
      value.recordType !== "runtime_lock" ||
      (value.schemaVersion !== 2 &&
        value.schemaVersion !== 3 &&
        value.schemaVersion !== SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION)
    )
      fail("JOURNAL_INVALID");
    return clone(value);
  };

  async function accept(
    inputOrKey: SpatialReferenceJournalAcceptInput | string,
    ack?: SpatialReferenceRelayDispatchAck,
    requestDigest?: string,
    details?: SpatialReferenceJournalAcceptDetails,
  ): Promise<{ replay: boolean; row: SpatialReferenceJournalRow; requiresRecovery?: boolean }> {
    if (typeof inputOrKey === "string") {
      if (details) {
        if (!ack || details.identity.key !== inputOrKey) fail("JOURNAL_IDENTITY_KEY_CONFLICT");
        return accept({ ...details, ack, requestDigest: requestDigest ?? "" });
      }
      if (params.authority !== "memory" || !ack) fail("JOURNAL_EXACT_IDENTITY_REQUIRED");
      const replay = Boolean(read(inputOrKey)?.ack);
      const row = write(
        inputOrKey,
        (current) =>
          current ?? {
            recordType: "execution",
            schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
            key: inputOrKey,
            dispatchAttemptId: ack.dispatchAttemptId,
            cancelled: false,
            phase: "legacy_nonresumable",
            ack: clone(ack),
            requestDigest,
          },
      );
      return { replay, row };
    }
    const input = inputOrKey;
    assertIdentity(input.identity);
    assertAck(input.identity, input.ack);
    assertExpectedOutputs(input.expectedOutputs);
    return pair(input.identity.key, (transaction) => {
      const lock = transaction.lookup(RUNTIME_LOCK_KEY) as SpatialReferenceRuntimeLock | undefined;
      const existing = asExecution(transaction.lookup(input.identity.key));
      if (lock && lock.recordType !== "runtime_lock") fail("JOURNAL_INVALID");
      const legacyActiveLock = Boolean(
        lock && lock.schemaVersion === 2 && lock.executionKey !== "@released",
      );
      const replay = Boolean(existing?.ack);
      if (existing?.identity && !sameIdentity(existing.identity, input.identity))
        fail("IDEMPOTENCY_CONFLICT");
      if (
        existing?.ack &&
        (!sameAck(existing.ack, input.ack) || existing.requestDigest !== input.requestDigest)
      )
        fail("IDEMPOTENCY_CONFLICT");
      if (
        existing?.expectedOutputs &&
        canonicalJson(existing.expectedOutputs) !== canonicalJson(input.expectedOutputs)
      )
        fail("JOURNAL_EXPECTED_OUTPUT_CONFLICT");
      const row: SpatialReferenceJournalRow = existing
        ? {
            ...existing,
            schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
            identity: clone(input.identity),
            ack: clone(input.ack),
            requestDigest: input.requestDigest,
            expectedOutputs: clone([...input.expectedOutputs]),
            acceptedAtMs: existing.acceptedAtMs ?? Date.now(),
            phase: existing.phase === "legacy_nonresumable" ? "accepted" : existing.phase,
          }
        : createAcceptedRow(input);
      appendFinalized(row, input.knownFinalizedReceipts ?? [], false);
      transaction.set(input.identity.key, clone(row));
      if (!lock || (lock.schemaVersion === 2 && lock.executionKey === "@released"))
        transaction.set(RUNTIME_LOCK_KEY, releasedLock(input.identity.runtimeId));
      return {
        replay,
        row: clone(row),
        requiresRecovery: legacyActiveLock || row.phase !== "terminal",
      };
    });
  }

  async function claim(
    input: SpatialReferenceJournalClaimInput,
  ): Promise<SpatialReferenceJournalClaimResult> {
    assertIdentity(input.identity);
    assertOwner(input.owner);
    assertExpectedOutputs(input.expectedOutputs);
    if (!Number.isSafeInteger(input.nowMs) || input.leaseExpiresAtMs < input.nowMs)
      fail("JOURNAL_CLAIM_INVALID");
    return pair(input.identity.key, (transaction) => {
      const lock = transaction.lookup(RUNTIME_LOCK_KEY) as SpatialReferenceRuntimeLock | undefined;
      const row = asExecution(transaction.lookup(input.identity.key));
      if (!row) fail("JOURNAL_ACCEPT_REQUIRED");
      if (!row.identity || !sameIdentity(row.identity, input.identity))
        return { claimed: false, reason: "identity_conflict", row };
      if ((row.cancelled || row.cancelFence) && input.mode !== "stop_only")
        return { claimed: false, reason: "cancelled", row };
      if (row.phase === "terminal") return { claimed: false, reason: "terminal", row };
      const admission = lockAdmission(lock);
      if (admission.state === "quarantined")
        return { claimed: false, reason: "runtime_quarantined", row };
      if (admission.state === "requires_reconciliation" || row.schemaVersion === 2) {
        const legacyLock = lock?.owner;
        const legacyRow = row.claim;
        const probes = Math.min(3, (row.reconciliation?.probes ?? 0) + 1);
        const { claim: _legacyClaim, ...unclaimed } = row;
        transaction.set(input.identity.key, {
          ...unclaimed,
          schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
          phase: "legacy_reconciling",
          reconciliation: {
            kind:
              lock?.executionKey === input.identity.key
                ? "legacy_torn_pair"
                : "legacy_lock_unmapped",
            observedAtMs: input.nowMs,
            probes,
            ...(legacyLock ? { legacyLockOwner: clone(legacyLock) } : {}),
            ...(legacyRow ? { legacyRowOwner: clone(legacyRow) } : {}),
          },
        });
        transaction.set(
          RUNTIME_LOCK_KEY,
          quarantineLock({
            runtimeId: input.identity.runtimeId,
            sourceExecutionKey: input.identity.key,
            lockOwner: legacyLock,
            rowOwner: legacyRow,
            reason:
              legacyRow?.scopeKey && legacyRow.runId
                ? "legacy_scope_unproven"
                : "legacy_owner_unproven",
          }),
        );
        return {
          claimed: false,
          reason: "runtime_quarantined",
          row: { ...unclaimed, phase: "legacy_reconciling" },
        };
      }
      const existing = admission.state === "owned" ? admission.owner : undefined;
      const existingExecutionKey = admission.state === "owned" ? admission.executionKey : undefined;
      if (existing && existingExecutionKey !== input.identity.key)
        return { claimed: false, reason: "active_owner", row };
      if (existing && !sameOwner(existing, input.owner)) {
        const recovery = input.previousOwner;
        const exactOldPair = Boolean(
          row.claim &&
          recovery &&
          sameClaimOwner(existing, row.claim) &&
          recovery.pid === existing.pid &&
          recovery.pidStartTimeMs === existing.pidStartTimeMs,
        );
        const guardianExtinct =
          isExactScopeExtinct(row, existing, "extinct") ||
          isExactScopeExtinct(row, existing, "never_spawned");
        const legacyExtinct = Boolean(
          recovery &&
          exactOldPair &&
          recovery.scopeExtinct &&
          recovery.scopeId === existing.scopeKey &&
          recovery.runId === existing.runId,
        );
        if (existing.leaseExpiresAtMs > input.nowMs || (!guardianExtinct && !legacyExtinct)) {
          return {
            claimed: false,
            reason: input.previousOwner ? "prior_worker_unproven" : "active_owner",
            row,
          };
        }
        if ((row.recoveryCount ?? 0) >= (input.recoveryBudget ?? 1))
          return { claimed: false, reason: "recovery_exhausted", row };
      }
      const owner = claimOwner(input, existing);
      const next = clone(row);
      if (canonicalJson(next.expectedOutputs) !== canonicalJson(input.expectedOutputs))
        fail("JOURNAL_EXPECTED_OUTPUT_CONFLICT");
      appendFinalized(next, input.knownFinalizedReceipts ?? [], false);
      const reclaimed = Boolean(existing && !sameOwner(existing, input.owner));
      next.schemaVersion = SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION;
      next.claim = owner;
      // A completed guardian receipt belongs to the superseded claim version;
      // never let it authorize this new epoch. Lease heartbeats keep the same
      // incarnation and must not drop the armed guardian.
      if (
        !existing ||
        !sameOwner(owner, existing) ||
        owner.claimVersion !== existing.claimVersion ||
        owner.scopeKey !== existing.scopeKey ||
        owner.runId !== existing.runId
      ) {
        delete next.scopeRecovery;
      }
      next.recoveryCount = reclaimed ? (next.recoveryCount ?? 0) + 1 : (next.recoveryCount ?? 0);
      next.phase = "claimed";
      transaction.set(input.identity.key, next);
      transaction.set(RUNTIME_LOCK_KEY, {
        recordType: "runtime_lock",
        schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
        runtimeId: input.identity.runtimeId,
        state: "owned",
        executionKey: input.identity.key,
        owner: clone(owner),
        claimVersion: owner.claimVersion,
      });
      return { claimed: true, row: clone(next), missingOutputs: missingOutputs(next) };
    });
  }

  async function checkClaim(
    context: SpatialReferenceJournalClaimContext,
  ): Promise<SpatialReferenceJournalRow> {
    assertIdentity(context.identity);
    assertOwner(context.owner);
    return pair(context.identity.key, (transaction) =>
      clone(requirePair(transaction, context).row),
    );
  }

  async function checkpoint(
    input: SpatialReferenceJournalCheckpointInput,
  ): Promise<SpatialReferenceJournalRow> {
    const allowsCancelledExit = input.phase === "worker_exited";
    return pair(input.identity.key, (transaction) => {
      const { lock, row: current } = requirePair(transaction, input, {
        allowCancelledExit: allowsCancelledExit,
      });
      const row = clone(current);
      if (input.phase === "worker_started") {
        if (
          !input.worker ||
          input.worker.exited ||
          !row.claim ||
          input.worker.scopeId !== row.claim.scopeKey
        )
          fail("JOURNAL_WORKER_INVALID");
        if (
          row.identity?.contractVersion === "spatial_reference_render/v2" &&
          (!row.scopeRecovery ||
            !recoveryMatchesClaim(row.scopeRecovery, row.claim) ||
            row.scopeRecovery.state !== "armed")
        ) {
          fail("JOURNAL_SCOPE_GUARDIAN_REQUIRED");
        }
        assertWorker(input.worker);
        row.worker = clone({ ...input.worker, runId: row.claim.runId });
      } else if (input.phase === "worker_exited") {
        if (
          !input.worker?.exited ||
          !row.worker ||
          row.worker.pid !== input.worker.pid ||
          row.worker.startTime !== input.worker.startTime ||
          row.worker.scopeId !== input.worker.scopeId
        )
          fail("JOURNAL_WORKER_INVALID");
        assertWorker(input.worker);
        row.worker = clone({ ...input.worker, runId: row.worker.runId });
      } else if (input.phase === "render_proof") {
        if (
          !input.renderProof ||
          input.renderProof.rendererBuildDigest !== input.identity.rendererBuildDigest ||
          !Number.isSafeInteger(input.renderProof.completedAtMs)
        )
          fail("JOURNAL_RENDER_PROOF_INVALID");
        if (row.renderProof && canonicalJson(row.renderProof) !== canonicalJson(input.renderProof))
          fail("JOURNAL_RENDER_PROOF_CONFLICT");
        row.renderProof = clone(input.renderProof);
        row.phase = "render_proven";
      } else if (input.phase === "prepared") {
        if (!input.prepared || input.prepared.callback.status !== "succeeded")
          fail("JOURNAL_PREPARED_CALLBACK_INVALID");
        const keys = new Set<string>();
        for (const output of input.prepared.outputs) {
          assertPreparedOutput(row, output);
          if (keys.has(outputKey(output))) fail("JOURNAL_PREPARED_OUTPUT_DUPLICATE");
          keys.add(outputKey(output));
        }
        if (
          row.prepared &&
          canonicalJson(row.prepared.callback) !== canonicalJson(input.prepared.callback)
        )
          fail("JOURNAL_PREPARED_CALLBACK_CONFLICT");
        const outputs = new Map(
          (row.prepared?.outputs ?? []).map((output) => [outputKey(output), output]),
        );
        for (const output of input.prepared.outputs) outputs.set(outputKey(output), clone(output));
        row.prepared = { callback: clone(input.prepared.callback), outputs: [...outputs.values()] };
        row.phase = "prepared";
      } else {
        if (!input.finalizedOutput) fail("JOURNAL_FINALIZED_OUTPUT_INVALID");
        appendFinalized(row, [input.finalizedOutput]);
        row.phase = "uploading";
      }
      transaction.set(input.identity.key, row);
      transaction.set(RUNTIME_LOCK_KEY, lock);
      return clone(row);
    });
  }

  async function cancel(
    key: string,
    dispatchAttemptId: string,
    claimContext?: SpatialReferenceJournalClaimContext,
  ): Promise<SpatialReferenceJournalRow> {
    return write(key, (current) => {
      if (current && current.dispatchAttemptId !== dispatchAttemptId)
        fail("CANCEL_IDENTITY_CONFLICT");
      if (!current)
        return {
          recordType: "execution",
          schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
          key,
          dispatchAttemptId,
          cancelled: true,
          phase: "legacy_nonresumable",
        };
      if (
        claimContext &&
        current.identity &&
        !sameIdentity(current.identity, claimContext.identity)
      )
        fail("JOURNAL_STALE_CLAIM");
      if (current.callback) return current;
      return {
        ...current,
        cancelled: true,
        cancelFence: {
          dispatchAttemptId,
          fenceEpoch: current.claim?.epoch ?? "preclaim",
          requestedAtMs: claimContext?.nowMs ?? Date.now(),
        },
      };
    });
  }

  async function finish(
    key: string,
    callback: SpatialReferenceTerminalCallback,
    claimContext?: SpatialReferenceJournalClaimContext,
  ): Promise<SpatialReferenceTerminalCallback> {
    if (!claimContext) {
      const row = write(key, (current) => {
        if (
          !current?.ack ||
          current.ack.executionFingerprint !== callback.executionFingerprint ||
          current.dispatchAttemptId !== callback.dispatchAttemptId
        )
          fail("RECEIPT_IDENTITY_CONFLICT");
        if (current.callback) return current;
        return {
          ...current,
          callback:
            current.cancelled && callback.status !== "failed"
              ? cancelledCallback(callback)
              : clone(callback),
          delivered: false,
          phase: "terminal",
        };
      });
      return clone(row.callback!);
    }
    return pair(key, (transaction) => {
      const { row: current } = requirePair(transaction, claimContext, {
        allowCancelledExit: callback.status !== "succeeded",
      });
      if (
        !current.ack ||
        current.ack.executionFingerprint !== callback.executionFingerprint ||
        current.dispatchAttemptId !== callback.dispatchAttemptId
      )
        fail("RECEIPT_IDENTITY_CONFLICT");
      if (current.callback) return clone(current.callback);
      const safe = scopeExitIsSafe(current, current.claim, claimContext.scopeEvidence);
      if (safe && callback.status === "succeeded") {
        const recomposed = recomposePreparedCallback(current);
        if (canonicalJson(recomposed) !== canonicalJson(callback))
          fail("JOURNAL_TERMINAL_CALLBACK_CONFLICT");
      }
      const { claim, ...unclaimed } = current;
      const terminal = safe
        ? current.cancelled && callback.status !== "failed"
          ? cancelledCallback(callback)
          : clone(callback)
        : referenceTerminal(claimContext.identity, "failed", "spatial_scope_stop_unconfirmed");
      const row: SpatialReferenceJournalRow = {
        ...unclaimed,
        callback: terminal,
        delivered: false,
        phase: "terminal",
      };
      transaction.set(key, row);
      transaction.set(
        RUNTIME_LOCK_KEY,
        safe
          ? releasedLock(claimContext.identity.runtimeId, claim?.claimVersion ?? 0)
          : quarantineLock({
              runtimeId: claimContext.identity.runtimeId,
              sourceExecutionKey: key,
              rowOwner: claim,
              scope: claim ? { scopeKey: claim.scopeKey, runId: claim.runId } : undefined,
              reason: "scope_stop_unconfirmed",
            }),
      );
      return clone(terminal);
    });
  }

  async function delivered(key: string, callback: SpatialReferenceTerminalCallback): Promise<void> {
    write(key, (current) => {
      if (!current?.callback || canonicalJson(current.callback) !== canonicalJson(callback))
        fail("RECEIPT_DELIVERY_CONFLICT");
      return { ...current, delivered: true };
    });
  }

  async function release(
    input: SpatialReferenceJournalReleaseInput,
  ): Promise<SpatialReferenceJournalRow> {
    return pair(input.identity.key, (transaction) => {
      const { row: current } = requirePair(transaction, input, { allowCancelledExit: true });
      if (input.worker) {
        if (!input.worker.exited) fail("JOURNAL_WORKER_INVALID");
        assertWorker(input.worker);
      }
      const { claim, ...unclaimed } = current;
      const safe = scopeExitIsSafe(current, current.claim, input.scopeEvidence);
      const row: SpatialReferenceJournalRow = safe
        ? { ...unclaimed, ...(input.worker ? { worker: clone(input.worker) } : {}) }
        : {
            ...unclaimed,
            ...(input.worker ? { worker: clone(input.worker) } : {}),
            callback: referenceTerminal(input.identity, "failed", "spatial_scope_stop_unconfirmed"),
            delivered: false,
            phase: "terminal",
          };
      transaction.set(input.identity.key, row);
      transaction.set(
        RUNTIME_LOCK_KEY,
        safe
          ? releasedLock(input.identity.runtimeId, claim?.claimVersion ?? 0)
          : quarantineLock({
              runtimeId: input.identity.runtimeId,
              sourceExecutionKey: input.identity.key,
              rowOwner: claim,
              scope: claim ? { scopeKey: claim.scopeKey, runId: claim.runId } : undefined,
              reason: "scope_stop_unconfirmed",
            }),
      );
      return clone(row);
    });
  }

  async function armScopeGuardian(
    input: SpatialReferenceJournalArmScopeGuardianInput,
  ): Promise<SpatialReferenceJournalRow> {
    assertIdentity(input.identity);
    assertOwner(input.owner);
    assertGuardian(input.guardian);
    if (
      input.guardian.pid === input.owner.pid &&
      input.guardian.pidStartTimeMs === input.owner.pidStartTimeMs
    ) {
      fail("JOURNAL_SCOPE_GUARDIAN_INVALID");
    }
    return pair(input.identity.key, (transaction) => {
      const { lock, row: current } = requirePair(transaction, input);
      if (!current.claim) fail("JOURNAL_STALE_CLAIM");
      if (current.scopeRecovery) {
        if (
          recoveryMatchesClaim(current.scopeRecovery, current.claim) &&
          sameGuardian(current.scopeRecovery.guardian, input.guardian)
        ) {
          return clone(current);
        }
        fail("JOURNAL_SCOPE_GUARDIAN_CONFLICT");
      }
      const row = clone(current);
      row.scopeRecovery = {
        guardian: clone(input.guardian),
        claimVersion: current.claim.claimVersion,
        owner: clone(input.owner),
        state: "armed",
        observedAtMs: input.nowMs,
        probes: 0,
        firstObservedAtMs: input.nowMs,
      };
      row.launchState = "armed";
      transaction.set(input.identity.key, row);
      transaction.set(RUNTIME_LOCK_KEY, lock);
      return clone(row);
    });
  }

  async function recordSpawnIntent(
    input: SpatialReferenceJournalRecordSpawnIntentInput,
  ): Promise<SpatialReferenceJournalRow> {
    assertIdentity(input.identity);
    assertOwner(input.owner);
    assertGuardian(input.guardian);
    return pair(input.identity.key, (transaction) => {
      const { lock, row: current } = requirePair(transaction, input);
      if (
        !current.scopeRecovery ||
        !current.claim ||
        !recoveryMatchesClaim(current.scopeRecovery, current.claim) ||
        !sameGuardian(current.scopeRecovery.guardian, input.guardian) ||
        current.worker
      ) {
        fail("JOURNAL_GUARDIAN_SPAWN_INTENT_INVALID");
      }
      if (current.launchState === "spawn_intent") return clone(current);
      if (current.launchState !== "armed") fail("JOURNAL_GUARDIAN_SPAWN_INTENT_INVALID");
      const row = { ...clone(current), launchState: "spawn_intent" as const };
      transaction.set(input.identity.key, row);
      transaction.set(RUNTIME_LOCK_KEY, lock);
      return clone(row);
    });
  }

  async function recordWorkerPrepared(
    input: SpatialReferenceJournalRecordWorkerPreparedInput,
  ): Promise<SpatialReferenceJournalRow> {
    assertIdentity(input.identity);
    assertOwner(input.owner);
    assertGuardian(input.guardian);
    assertWorker(input.worker);
    return pair(input.identity.key, (transaction) => {
      const { lock, row: current } = requirePair(transaction, input);
      if (
        !current.scopeRecovery ||
        !current.claim ||
        !recoveryMatchesClaim(current.scopeRecovery, current.claim) ||
        !sameGuardian(current.scopeRecovery.guardian, input.guardian) ||
        input.worker.exited ||
        input.worker.scopeId !== current.claim.scopeKey ||
        input.worker.runId !== current.claim.runId
      ) {
        fail("JOURNAL_GUARDIAN_WORKER_PREPARED_INVALID");
      }
      if (current.launchState === "worker_prepared") {
        if (
          current.worker?.pid === input.worker.pid &&
          current.worker.startTime === input.worker.startTime &&
          current.worker.scopeId === input.worker.scopeId &&
          current.worker.runId === input.worker.runId
        )
          return clone(current);
        fail("JOURNAL_GUARDIAN_WORKER_PREPARED_INVALID");
      }
      if (current.launchState !== "spawn_intent") fail("JOURNAL_GUARDIAN_WORKER_PREPARED_INVALID");
      const worker = clone({ ...input.worker, runId: current.claim.runId });
      const row = { ...clone(current), worker, launchState: "worker_prepared" as const };
      transaction.set(input.identity.key, row);
      transaction.set(RUNTIME_LOCK_KEY, lock);
      return clone(row);
    });
  }

  async function authorizeWorkerStart(
    input: SpatialReferenceJournalAuthorizeWorkerStartInput,
  ): Promise<SpatialReferenceJournalRow> {
    assertIdentity(input.identity);
    assertOwner(input.owner);
    assertGuardian(input.guardian);
    return pair(input.identity.key, (transaction) => {
      const { lock, row: current } = requirePair(transaction, input);
      if (
        !current.scopeRecovery ||
        !current.claim ||
        !current.worker ||
        !recoveryMatchesClaim(current.scopeRecovery, current.claim) ||
        !sameGuardian(current.scopeRecovery.guardian, input.guardian) ||
        input.worker.pid !== current.worker.pid ||
        input.worker.startTime !== current.worker.startTime ||
        input.worker.scopeId !== current.worker.scopeId ||
        input.worker.runId !== current.worker.runId
      ) {
        fail("JOURNAL_GUARDIAN_START_AUTHORIZATION_INVALID");
      }
      if (current.launchState === "start_authorized") return clone(current);
      if (current.launchState !== "worker_prepared")
        fail("JOURNAL_GUARDIAN_START_AUTHORIZATION_INVALID");
      const row = { ...clone(current), launchState: "start_authorized" as const };
      transaction.set(input.identity.key, row);
      transaction.set(RUNTIME_LOCK_KEY, lock);
      return clone(row);
    });
  }

  async function recordScopeObservation(
    input: SpatialReferenceJournalScopeObservationInput,
  ): Promise<SpatialReferenceJournalRow> {
    assertIdentity(input.identity);
    assertOwner(input.owner);
    assertGuardian(input.guardian);
    if (
      !Number.isSafeInteger(input.observation.observedAtMs) ||
      input.observation.observedAtMs < 0
    ) {
      fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
    }
    return pair(input.identity.key, (transaction) => {
      const { lock, row: current } = requirePair(transaction, input, { allowCancelledExit: true });
      const recovery = current.scopeRecovery;
      if (
        !current.claim ||
        !recovery ||
        !recoveryMatchesClaim(recovery, current.claim) ||
        !sameGuardian(recovery.guardian, input.guardian)
      ) {
        fail("JOURNAL_SCOPE_GUARDIAN_STALE");
      }
      const requested = input.observation.state;
      if (recovery.probes >= 3 && requested !== "unknown") {
        fail("JOURNAL_SCOPE_OBSERVATION_EXPIRED");
      }
      if (requested === "armed") fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
      if (
        recovery.state === "extinct" ||
        recovery.state === "never_spawned" ||
        recovery.state === "unknown"
      ) {
        if (recovery.state !== requested) fail("JOURNAL_SCOPE_OBSERVATION_STALE");
        return clone(current);
      }
      if (
        input.observation.observedAtMs - recovery.firstObservedAtMs > 180_000 &&
        requested !== "unknown"
      ) {
        fail("JOURNAL_SCOPE_OBSERVATION_EXPIRED");
      }
      const worker = input.observation.worker;
      if (requested === "never_spawned") {
        if (current.worker || worker || input.observation.proof || current.launchState !== "armed")
          fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
      } else if (requested === "watching" || requested === "extinct") {
        if (
          !worker ||
          !current.worker ||
          worker.pid !== current.worker.pid ||
          worker.startTime !== current.worker.startTime ||
          worker.scopeId !== current.claim.scopeKey ||
          worker.runId !== current.claim.runId
        ) {
          fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
        }
        if (requested === "extinct") {
          if (
            input.guardian.pid === current.claim.pid &&
            input.guardian.pidStartTimeMs === current.claim.pidStartTimeMs
          ) {
            fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
          }
          const proof = input.observation.proof;
          if (!proof || !exactScopeProof(worker, proof, current.worker)) {
            fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
          }
        } else if (input.observation.proof) {
          fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
        }
      } else if (requested === "unknown" && !input.observation.reason) {
        fail("JOURNAL_SCOPE_OBSERVATION_INVALID");
      }
      const row = clone(current);
      row.scopeRecovery = {
        ...recovery,
        state: requested,
        observedAtMs: input.observation.observedAtMs,
        probes: Math.min(3, recovery.probes + 1),
        ...(worker ? { worker: clone(worker) } : {}),
        ...(input.observation.proof ? { proof: clone(input.observation.proof) } : {}),
        ...(input.observation.reason ? { reason: input.observation.reason } : {}),
      };
      transaction.set(input.identity.key, row);
      transaction.set(RUNTIME_LOCK_KEY, lock);
      return clone(row);
    });
  }

  async function reconcileScope(
    input: SpatialReferenceJournalReconcileScopeInput,
  ): Promise<SpatialReferenceJournalReconcileScopeResult> {
    assertIdentity(input.identity);
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
      fail("JOURNAL_SCOPE_RECONCILE_INVALID");
    return pair(input.identity.key, (transaction) => {
      const row = asExecution(transaction.lookup(input.identity.key));
      const lock = transaction.lookup(RUNTIME_LOCK_KEY) as SpatialReferenceRuntimeLock | undefined;
      if (!row?.identity || !sameIdentity(row.identity, input.identity) || !isV3Lock(lock)) {
        return {
          state: "unavailable",
          row: clone(
            row ?? {
              recordType: "execution",
              schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
              key: input.identity.key,
              dispatchAttemptId: input.identity.dispatchAttemptId,
              cancelled: false,
              phase: "legacy_nonresumable",
            },
          ),
        };
      }
      const recovery = row.scopeRecovery;
      if (!recovery) return { state: "unavailable", row: clone(row) };
      if (recovery.state === "watching" || recovery.state === "armed")
        return { state: "live", row: clone(row) };
      if (recovery.state === "unknown") return { state: "unknown", row: clone(row) };
      const exactScope =
        recovery.state === "never_spawned"
          ? !row.worker
          : Boolean(
              recovery.worker &&
              recovery.proof &&
              !(
                recovery.guardian.pid === recovery.owner.pid &&
                recovery.guardian.pidStartTimeMs === recovery.owner.pidStartTimeMs
              ) &&
              exactScopeProof(recovery.worker, recovery.proof, row.worker),
            );
      if (!exactScope) return { state: "unknown", row: clone(row) };
      if (
        lock?.state === "quarantined" &&
        lock.quarantine?.sourceExecutionKey === input.identity.key &&
        lock.quarantine.legacyRowOwner &&
        sameOwner(lock.quarantine.legacyRowOwner, recovery.owner) &&
        "claimVersion" in lock.quarantine.legacyRowOwner &&
        lock.quarantine.legacyRowOwner.claimVersion === recovery.claimVersion &&
        lock.quarantine.scope.state === "exact" &&
        (recovery.state === "never_spawned" ||
          (recovery.worker &&
            lock.quarantine.scope.scopeKey === recovery.worker.scopeId &&
            lock.quarantine.scope.runId === recovery.worker.runId))
      ) {
        transaction.set(
          RUNTIME_LOCK_KEY,
          releasedLock(input.identity.runtimeId, recovery.claimVersion),
        );
      }
      transaction.set(input.identity.key, clone(row));
      return { state: recovery.state, row: clone(row) };
    });
  }

  return {
    authority: params.authority,
    accept: accept as SpatialReferenceJournal["accept"],
    cancel,
    finish,
    list: async () =>
      params.backend
        .entries()
        .filter(isExecution)
        .filter((row) => row.key !== SPATIAL_REFERENCE_QUALIFICATION_KEY)
        .map(clone)
        .sort((a, b) => a.key.localeCompare(b.key)),
    get: async (key) => read(key),
    getRuntimeAdmission: async () => lockAdmission(runtimeLock()),
    claimExclusiveAdmission: async (input: SpatialReferenceExclusiveAdmissionClaimInput) => {
      assertOwner(input.owner);
      if (!input.runtimeId || !input.scopeKey || !input.runId) fail("JOURNAL_CLAIM_INVALID");
      if (!Number.isSafeInteger(input.nowMs) || input.leaseExpiresAtMs < input.nowMs)
        fail("JOURNAL_CLAIM_INVALID");
      return pair(SPATIAL_REFERENCE_QUALIFICATION_KEY, (transaction) =>
        applyExclusiveAdmissionClaim({ transaction, input }),
      );
    },
    releaseExclusiveAdmission: async (input: SpatialReferenceExclusiveAdmissionReleaseInput) => {
      assertOwner(input.owner);
      if (
        !Number.isSafeInteger(input.nowMs) ||
        (input.scopeEvidence !== "never_spawned" && input.scopeEvidence !== "extinct")
      ) {
        fail("JOURNAL_CLAIM_INVALID");
      }
      return pair(SPATIAL_REFERENCE_QUALIFICATION_KEY, (transaction) =>
        applyExclusiveAdmissionRelease({ transaction, input }),
      );
    },
    delivered,
    claim,
    checkClaim,
    checkpoint,
    release,
    armScopeGuardian,
    recordSpawnIntent,
    recordWorkerPrepared,
    authorizeWorkerStart,
    recordScopeObservation,
    reconcileScope,
  };
}
