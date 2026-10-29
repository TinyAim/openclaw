/** Exclusive qualification admission on the existing schema-v4 lock/row pair. */
import { randomUUID } from "node:crypto";
import type {
  SpatialReferenceExclusiveAdmissionClaimInput,
  SpatialReferenceExclusiveAdmissionClaimResult,
  SpatialReferenceExclusiveAdmissionReleaseInput,
  SpatialReferenceExclusiveAdmissionReleaseResult,
  SpatialReferenceRuntimeAdmission,
} from "./reference-journal-contract.js";
import {
  sameOwner,
  sameClaimOwner,
  SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
  type SpatialReferenceJournalClaimOwner,
  type SpatialReferenceJournalIdentity,
  type SpatialReferenceJournalOwner,
  type SpatialReferenceJournalRow,
  type SpatialReferenceJournalStoredValue,
  type SpatialReferenceRuntimeLock,
} from "./reference-journal-record.js";
import { asExecution, clone, fail } from "./reference-journal-validation.js";

export const SPATIAL_REFERENCE_RUNTIME_LOCK_KEY = "@runtime-lock";
export const SPATIAL_REFERENCE_QUALIFICATION_KEY = "@qualification";

export type SpatialReferenceJournalPairTransaction = {
  lookup(key: string): SpatialReferenceJournalStoredValue | undefined;
  set(key: string, value: SpatialReferenceJournalStoredValue): void;
};

export function releasedLock(runtimeId: string, claimVersion = 0): SpatialReferenceRuntimeLock {
  return {
    recordType: "runtime_lock",
    schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
    runtimeId,
    state: "released",
    claimVersion,
  };
}

export function isV3Lock(lock: SpatialReferenceRuntimeLock | undefined): boolean {
  return lock?.schemaVersion === SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION;
}

export function lockAdmission(
  lock: SpatialReferenceRuntimeLock | undefined,
): SpatialReferenceRuntimeAdmission {
  if (!lock || (lock.schemaVersion === 2 && lock.executionKey === "@released"))
    return { state: "released" };
  if (!isV3Lock(lock)) return { state: "requires_reconciliation" };
  if (lock.state === "released") return { state: "released" };
  if (lock.state === "quarantined" && lock.quarantine) {
    return {
      state: "quarantined",
      fenceId: lock.quarantine.fenceId,
      reason: lock.quarantine.reason,
      scope: lock.quarantine.scope.state,
    };
  }
  if (lock.state === "owned" && lock.executionKey && lock.owner && "claimVersion" in lock.owner) {
    return {
      state: "owned",
      executionKey: lock.executionKey,
      owner: clone(lock.owner) as SpatialReferenceJournalClaimOwner,
    };
  }
  return { state: "requires_reconciliation" };
}

export function quarantineLock(params: {
  runtimeId: string;
  sourceExecutionKey?: string;
  lockOwner?: SpatialReferenceRuntimeLock["owner"];
  rowOwner?: SpatialReferenceJournalRow["claim"];
  scope?: { scopeKey: string; runId: string };
  reason: "legacy_owner_unproven" | "legacy_scope_unproven" | "scope_stop_unconfirmed";
}): SpatialReferenceRuntimeLock {
  return {
    recordType: "runtime_lock",
    schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
    runtimeId: params.runtimeId,
    state: "quarantined",
    claimVersion: 0,
    quarantine: {
      fenceId: randomUUID(),
      ...(params.sourceExecutionKey ? { sourceExecutionKey: params.sourceExecutionKey } : {}),
      reason: params.reason,
      enteredAtMs: Date.now(),
      ...(params.rowOwner ? { legacyRowOwner: clone(params.rowOwner) } : {}),
      ...(params.lockOwner ? { legacyLockOwner: clone(params.lockOwner) } : {}),
      scope: params.scope ? { state: "exact", ...params.scope } : { state: "unavailable" },
    },
  };
}

export function spatialReferenceQualificationIdentity(
  runtimeId: string,
): SpatialReferenceJournalIdentity {
  return {
    key: SPATIAL_REFERENCE_QUALIFICATION_KEY,
    runtimeIdempotencyKey: SPATIAL_REFERENCE_QUALIFICATION_KEY,
    runtimeId,
    executionId: "qualification",
    workspaceId: "qualification",
    taskId: "qualification",
    materializationId: "qualification",
    dispatchAttemptId: "qualification",
    sequence: 1,
    attempt: 1,
    intentFingerprint: "qualification",
    executionFingerprint: "qualification",
    blueprintDigest: "qualification",
    contractVersion: "spatial_reference_render/v2",
    rendererBuildDigest: "qualification",
    frozenDispatchDigest: "qualification",
  };
}

function qualificationReleaseIsSafe(
  row: SpatialReferenceJournalRow,
  claim: SpatialReferenceJournalClaimOwner | undefined,
  evidence: "never_spawned" | "extinct",
  spawned: boolean,
): boolean {
  if (evidence === "never_spawned") {
    return Boolean(
      claim &&
      !row.worker &&
      ((!spawned &&
        !row.scopeRecovery &&
        !row.guardianReservation &&
        row.launchState === undefined) ||
        qualificationNeverSpawnedWitnessMatches(row, claim)),
    );
  }
  const recovery = row.scopeRecovery;
  if (!claim || !recovery || recovery.state !== "extinct") return false;
  if (
    recovery.guardian.pid === claim.pid &&
    recovery.guardian.pidStartTimeMs === claim.pidStartTimeMs
  )
    return false;
  if (recovery.claimVersion !== claim.claimVersion || !sameOwner(recovery.owner, claim))
    return false;
  if (recovery.worker?.scopeId !== claim.scopeKey || recovery.worker?.runId !== claim.runId)
    return false;
  return Boolean(
    recovery.worker &&
    recovery.proof &&
    row.worker &&
    recovery.worker.pid === row.worker.pid &&
    recovery.worker.startTime === row.worker.startTime &&
    (recovery.proof.protocol === "windows_job_v1"
      ? recovery.proof.activeProcessCount === 0 &&
        recovery.proof.workerPid === recovery.worker.pid &&
        recovery.proof.workerStartTime === recovery.worker.startTime
      : recovery.proof.processGroupId === recovery.worker.pid &&
        (recovery.proof.rootState === "dead" || recovery.proof.rootState === "reused")),
  );
}

function qualificationNeverSpawnedWitnessMatches(
  row: SpatialReferenceJournalRow,
  claim: SpatialReferenceJournalClaimOwner,
): boolean {
  const reservation = row.guardianReservation;
  if (
    !reservation ||
    reservation.protocol !== "spatial_guardian_reservation/v1" ||
    reservation.claimVersion !== claim.claimVersion ||
    !sameOwner(reservation.owner, claim) ||
    reservation.scopeKey !== claim.scopeKey ||
    reservation.runId !== claim.runId
  ) {
    return false;
  }
  const recovery = row.scopeRecovery;
  if (
    recovery?.state === "never_spawned" &&
    row.launchState === "armed" &&
    recovery.claimVersion === claim.claimVersion &&
    sameOwner(recovery.owner, claim) &&
    (recovery.guardian.pid !== claim.pid ||
      recovery.guardian.pidStartTimeMs !== claim.pidStartTimeMs) &&
    recovery.guardian.generation === reservation.generation &&
    recovery.guardian.guardianBuildDigest === reservation.guardianBuildDigest
  ) {
    return true;
  }
  const witness = row.prearmGuardianExitWitness;
  return Boolean(
    row.launchState === "guardian_reserved" &&
    !recovery &&
    witness?.protocol === "spatial_guardian_prearm_exit/v1" &&
    (witness.guardian.pid !== claim.pid ||
      witness.guardian.pidStartTimeMs !== claim.pidStartTimeMs) &&
    witness.reservation.generation === reservation.generation &&
    witness.reservation.claimVersion === reservation.claimVersion &&
    sameOwner(witness.reservation.owner, reservation.owner) &&
    witness.reservation.scopeKey === reservation.scopeKey &&
    witness.reservation.runId === reservation.runId &&
    witness.reservation.guardianBuildDigest === reservation.guardianBuildDigest &&
    witness.guardian.generation === reservation.generation &&
    witness.guardian.guardianBuildDigest === reservation.guardianBuildDigest &&
    witness.observedAtMs >= reservation.reservedAtMs,
  );
}

function exactQuarantinedNeverSpawnedRecovery(
  row: SpatialReferenceJournalRow | undefined,
  lock: SpatialReferenceRuntimeLock | undefined,
  runtimeId: string,
): SpatialReferenceJournalClaimOwner | undefined {
  const quarantine = lock?.quarantine;
  const previous = quarantine?.legacyRowOwner;
  if (
    lock?.state !== "quarantined" ||
    lock.runtimeId !== runtimeId ||
    quarantine?.reason !== "scope_stop_unconfirmed" ||
    quarantine.sourceExecutionKey !== SPATIAL_REFERENCE_QUALIFICATION_KEY ||
    quarantine.scope.state !== "exact" ||
    !previous ||
    !("claimVersion" in previous) ||
    !row ||
    row.claim ||
    row.identity?.runtimeId !== runtimeId ||
    row.key !== SPATIAL_REFERENCE_QUALIFICATION_KEY ||
    row.identity.contractVersion !== "spatial_reference_render/v2" ||
    row.worker ||
    quarantine.scope.scopeKey !== (previous as SpatialReferenceJournalClaimOwner).scopeKey ||
    quarantine.scope.runId !== (previous as SpatialReferenceJournalClaimOwner).runId ||
    !qualificationNeverSpawnedWitnessMatches(row, previous as SpatialReferenceJournalClaimOwner)
  ) {
    return undefined;
  }
  return previous as SpatialReferenceJournalClaimOwner;
}

function exactOwnedNeverSpawnedRecovery(
  row: SpatialReferenceJournalRow | undefined,
  lock: SpatialReferenceRuntimeLock | undefined,
  runtimeId: string,
  nowMs: number,
  nextOwner: SpatialReferenceJournalOwner,
): SpatialReferenceJournalClaimOwner | undefined {
  const previous = lock?.owner;
  if (
    lock?.state !== "owned" ||
    lock.executionKey !== SPATIAL_REFERENCE_QUALIFICATION_KEY ||
    lock.runtimeId !== runtimeId ||
    !previous ||
    !("claimVersion" in previous) ||
    sameOwner(previous, nextOwner) ||
    previous.leaseExpiresAtMs > nowMs ||
    !row ||
    !row.claim ||
    !sameClaimOwner(row.claim, previous) ||
    row.identity?.runtimeId !== runtimeId ||
    row.key !== SPATIAL_REFERENCE_QUALIFICATION_KEY ||
    row.identity?.contractVersion !== "spatial_reference_render/v2" ||
    row.worker ||
    !qualificationNeverSpawnedWitnessMatches(row, previous)
  ) {
    return undefined;
  }
  return previous;
}

export function applyExclusiveAdmissionClaim(params: {
  transaction: SpatialReferenceJournalPairTransaction;
  input: SpatialReferenceExclusiveAdmissionClaimInput;
}): SpatialReferenceExclusiveAdmissionClaimResult {
  const storedLock = params.transaction.lookup(SPATIAL_REFERENCE_RUNTIME_LOCK_KEY) as
    | SpatialReferenceRuntimeLock
    | undefined;
  const existingRow = asExecution(params.transaction.lookup(SPATIAL_REFERENCE_QUALIFICATION_KEY));
  const recoverableQuarantine = exactQuarantinedNeverSpawnedRecovery(
    existingRow,
    storedLock,
    params.input.runtimeId,
  );
  const recoverableOwner = exactOwnedNeverSpawnedRecovery(
    existingRow,
    storedLock,
    params.input.runtimeId,
    params.input.nowMs,
    params.input.owner,
  );
  const lock =
    recoverableQuarantine || recoverableOwner
      ? releasedLock(
          params.input.runtimeId,
          (recoverableQuarantine ?? recoverableOwner)!.claimVersion,
        )
      : storedLock;
  const admission = lockAdmission(lock);
  if (admission.state === "quarantined") {
    return { claimed: false, reason: "runtime_quarantined" };
  }
  if (admission.state === "requires_reconciliation") {
    return { claimed: false, reason: "requires_reconciliation" };
  }
  if (
    existingRow?.identity?.runtimeId &&
    existingRow.identity.runtimeId !== params.input.runtimeId
  ) {
    return { claimed: false, reason: "requires_reconciliation" };
  }
  const heartbeat = Boolean(
    admission.state === "owned" &&
    admission.executionKey === SPATIAL_REFERENCE_QUALIFICATION_KEY &&
    sameOwner(admission.owner, params.input.owner),
  );
  if (admission.state === "owned" && !heartbeat) {
    return { claimed: false, reason: "active_owner" };
  }
  if (
    heartbeat &&
    (admission.state !== "owned" ||
      !existingRow?.claim ||
      !sameClaimOwner(existingRow.claim, admission.owner))
  ) {
    return { claimed: false, reason: "requires_reconciliation" };
  }
  if (
    admission.state === "released" &&
    existingRow?.claim &&
    !recoverableOwner &&
    !recoverableQuarantine
  ) {
    return { claimed: false, reason: "requires_reconciliation" };
  }
  const current = heartbeat ? existingRow?.claim : undefined;
  const owner: SpatialReferenceJournalClaimOwner = {
    ...clone(params.input.owner),
    leaseExpiresAtMs: params.input.leaseExpiresAtMs,
    claimVersion: heartbeat && current ? current.claimVersion : (lock?.claimVersion ?? 0) + 1,
    scopeKey: heartbeat && current ? current.scopeKey : params.input.scopeKey,
    runId: heartbeat && current ? current.runId : params.input.runId,
  };
  const identity =
    existingRow?.identity ?? spatialReferenceQualificationIdentity(params.input.runtimeId);
  const row: SpatialReferenceJournalRow = {
    recordType: "execution",
    schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
    key: SPATIAL_REFERENCE_QUALIFICATION_KEY,
    dispatchAttemptId: identity.dispatchAttemptId,
    cancelled: false,
    phase: "claimed",
    identity,
    claim: owner,
    ...(existingRow?.worker && heartbeat ? { worker: clone(existingRow.worker) } : {}),
    ...(existingRow?.scopeRecovery && heartbeat
      ? { scopeRecovery: clone(existingRow.scopeRecovery) }
      : {}),
    ...(existingRow?.launchState && heartbeat ? { launchState: existingRow.launchState } : {}),
    ...(existingRow?.guardianReservation && heartbeat
      ? { guardianReservation: clone(existingRow.guardianReservation) }
      : {}),
    ...(existingRow?.prearmGuardianExitWitness && heartbeat
      ? { prearmGuardianExitWitness: clone(existingRow.prearmGuardianExitWitness) }
      : {}),
  };
  params.transaction.set(SPATIAL_REFERENCE_QUALIFICATION_KEY, clone(row));
  params.transaction.set(SPATIAL_REFERENCE_RUNTIME_LOCK_KEY, {
    recordType: "runtime_lock",
    schemaVersion: SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION,
    runtimeId: identity.runtimeId,
    state: "owned",
    executionKey: SPATIAL_REFERENCE_QUALIFICATION_KEY,
    owner: clone(owner),
    claimVersion: owner.claimVersion,
  });
  return {
    claimed: true,
    executionKey: SPATIAL_REFERENCE_QUALIFICATION_KEY,
    owner: clone(owner),
    identity: clone(identity),
  };
}

export function applyExclusiveAdmissionRelease(params: {
  transaction: SpatialReferenceJournalPairTransaction;
  input: SpatialReferenceExclusiveAdmissionReleaseInput;
}): SpatialReferenceExclusiveAdmissionReleaseResult {
  const lock = params.transaction.lookup(SPATIAL_REFERENCE_RUNTIME_LOCK_KEY) as
    | SpatialReferenceRuntimeLock
    | undefined;
  const row = asExecution(params.transaction.lookup(SPATIAL_REFERENCE_QUALIFICATION_KEY));
  const admission = lockAdmission(lock);
  if (
    admission.state !== "owned" ||
    admission.executionKey !== SPATIAL_REFERENCE_QUALIFICATION_KEY ||
    !row?.claim ||
    !row.identity ||
    !sameOwner(admission.owner, params.input.owner) ||
    !sameOwner(row.claim, params.input.owner) ||
    !sameClaimOwner(admission.owner, row.claim)
  ) {
    fail("JOURNAL_STALE_CLAIM");
  }
  const claim = row.claim;
  const { claim: _claim, ...unclaimed } = row;
  const safe = qualificationReleaseIsSafe(
    row,
    claim,
    params.input.scopeEvidence,
    params.input.spawned === true,
  );
  const next: SpatialReferenceJournalRow = safe
    ? { ...unclaimed }
    : {
        ...unclaimed,
        phase: "terminal",
        delivered: false,
      };
  params.transaction.set(SPATIAL_REFERENCE_QUALIFICATION_KEY, clone(next));
  params.transaction.set(
    SPATIAL_REFERENCE_RUNTIME_LOCK_KEY,
    safe
      ? releasedLock(row.identity.runtimeId, claim.claimVersion)
      : quarantineLock({
          runtimeId: row.identity.runtimeId,
          sourceExecutionKey: SPATIAL_REFERENCE_QUALIFICATION_KEY,
          rowOwner: claim,
          scope: { scopeKey: claim.scopeKey, runId: claim.runId },
          reason: "scope_stop_unconfirmed",
        }),
  );
  return safe
    ? { released: true }
    : { released: false, quarantined: true, reason: "scope_stop_unconfirmed" };
}
