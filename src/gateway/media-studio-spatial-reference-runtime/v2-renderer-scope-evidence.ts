import type { SpatialReferenceJournalRow } from "./reference-journal-record.js";
import type {
  SpatialReferenceV2GuardianIdentity,
  SpatialReferenceV2ScopeObservation,
  SpatialReferenceV2WorkerIdentity,
} from "./v2-renderer.contract.js";

function sameGuardian(
  left: SpatialReferenceV2GuardianIdentity,
  right: SpatialReferenceV2GuardianIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.runId === right.runId &&
    left.scopeKey === right.scopeKey &&
    left.generation === right.generation
  );
}

function sameWorker(
  left: SpatialReferenceV2WorkerIdentity,
  right: SpatialReferenceV2WorkerIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.runId === right.runId &&
    left.scopeKey === right.scopeKey
  );
}

function sameOwner(
  left: { epoch: string; pid: number; pidStartTimeMs: number; ownerInstanceId: string },
  right: { epoch: string; pid: number; pidStartTimeMs: number; ownerInstanceId: string },
): boolean {
  return (
    left.epoch === right.epoch &&
    left.pid === right.pid &&
    left.pidStartTimeMs === right.pidStartTimeMs &&
    left.ownerInstanceId === right.ownerInstanceId
  );
}

function sameProof(
  worker: SpatialReferenceV2WorkerIdentity,
  proof: NonNullable<SpatialReferenceV2ScopeObservation["proof"]> | undefined,
): boolean {
  if (!proof) return false;
  if (proof.protocol === "posix_group_observation_v1") {
    return (
      proof.processGroupId === worker.pid &&
      (proof.rootState === "dead" || proof.rootState === "reused")
    );
  }
  return (
    proof.protocol === "windows_job_v1" &&
    proof.activeProcessCount === 0 &&
    proof.workerPid === worker.pid &&
    proof.workerStartTime === worker.startTime &&
    proof.jobIncarnationId.trim().length > 0
  );
}

function sameDurableProof(
  left: NonNullable<SpatialReferenceV2ScopeObservation["proof"]> | undefined,
  right: NonNullable<SpatialReferenceV2ScopeObservation["proof"]> | undefined,
): boolean {
  if (!left || !right || left.protocol !== right.protocol) return false;
  if (
    left.protocol === "posix_group_observation_v1" &&
    right.protocol === "posix_group_observation_v1"
  ) {
    return left.processGroupId === right.processGroupId && left.rootState === right.rootState;
  }
  if (left.protocol === "windows_job_v1" && right.protocol === "windows_job_v1") {
    return (
      left.jobIncarnationId === right.jobIncarnationId &&
      left.activeProcessCount === right.activeProcessCount &&
      left.workerPid === right.workerPid &&
      left.workerStartTime === right.workerStartTime
    );
  }
  return false;
}

function sameDurableWorker(
  left: { pid: number; startTime: number; scopeId: string; runId?: string },
  right: { pid: number; startTime: number; scopeId: string; runId?: string },
): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.scopeId === right.scopeId &&
    left.runId === right.runId
  );
}

export function acceptSpatialReferenceV2ScopeObservation(
  current: SpatialReferenceV2ScopeObservation | undefined,
  next: SpatialReferenceV2ScopeObservation,
  expected: {
    guardian: SpatialReferenceV2GuardianIdentity;
    worker: SpatialReferenceV2WorkerIdentity;
  },
): SpatialReferenceV2ScopeObservation {
  if (
    !sameGuardian(next.guardian, expected.guardian) ||
    !sameWorker(next.worker, expected.worker)
  ) {
    throw new Error("spatial_v2_scope_observation_identity_mismatch");
  }
  if (next.state === "unknown") {
    if (!next.reason || next.proof) {
      throw new Error("spatial_v2_scope_observation_unknown_invalid");
    }
  } else if (next.state !== "extinct" || !sameProof(expected.worker, next.proof)) {
    throw new Error("spatial_v2_scope_observation_extinction_proof_invalid");
  }
  if (current && JSON.stringify(current) !== JSON.stringify(next)) {
    throw new Error("spatial_v2_scope_observation_conflict");
  }
  return current ?? next;
}

export function assertSpatialReferenceV2ExtinctObservation(
  observation: SpatialReferenceV2ScopeObservation | undefined,
  expected: {
    guardian: SpatialReferenceV2GuardianIdentity;
    worker: SpatialReferenceV2WorkerIdentity;
  },
): asserts observation is SpatialReferenceV2ScopeObservation {
  if (!observation || observation.state !== "extinct") {
    throw new Error("spatial_v2_scope_observation_unconfirmed");
  }
  acceptSpatialReferenceV2ScopeObservation(undefined, observation, expected);
}

export function assertSpatialReferenceV2DurableExtinction(
  observation: SpatialReferenceV2ScopeObservation,
  row: SpatialReferenceJournalRow | undefined,
): void {
  const recovery = row?.scopeRecovery;
  if (!recovery || recovery.state !== "extinct") {
    throw new Error("spatial_v2_scope_observation_not_durable");
  }
  if (
    !row?.claim ||
    recovery.claimVersion !== row.claim.claimVersion ||
    !sameOwner(recovery.owner, row.claim) ||
    observation.guardian.pid !== recovery.guardian.pid ||
    observation.guardian.startTime !== recovery.guardian.pidStartTimeMs ||
    observation.guardian.runId !== row.claim.runId ||
    observation.guardian.scopeKey !== row.claim.scopeKey ||
    observation.guardian.generation !== recovery.guardian.generation ||
    !recovery.worker ||
    !row.worker ||
    !sameDurableWorker(row.worker, recovery.worker) ||
    !sameWorker(observation.worker, {
      pid: row.worker.pid,
      startTime: row.worker.startTime,
      runId: row.worker.runId ?? row.claim.runId,
      scopeKey: row.worker.scopeId,
    }) ||
    !sameDurableProof(observation.proof, recovery.proof)
  ) {
    throw new Error("spatial_v2_scope_observation_durable_identity_mismatch");
  }
}
