import type { SpatialReferenceRelayDispatchAck } from "../media-studio-spatial-reference-render-http.js";
import type { SpatialReferenceTerminalCallback } from "./reference-callback.js";
import type {
  SpatialReferenceExpectedOutput,
  SpatialReferenceFinalizedOutput,
  SpatialReferenceJournalIdentity,
  SpatialReferenceJournalOwner,
  SpatialReferenceJournalClaimOwner,
  SpatialReferenceJournalRenderProof,
  SpatialReferenceJournalRow,
  SpatialReferenceJournalStoredValue,
  SpatialReferenceJournalWorker,
  SpatialReferenceJournalScopeGuardian,
  SpatialReferenceJournalScopeRecovery,
  SpatialReferencePreparedOutput,
} from "./reference-journal-record.js";

export type SpatialReferenceJournalClaimInput = {
  identity: SpatialReferenceJournalIdentity;
  owner: SpatialReferenceJournalOwner;
  expectedOutputs: readonly SpatialReferenceExpectedOutput[];
  knownFinalizedReceipts?: readonly SpatialReferenceFinalizedOutput[];
  nowMs: number;
  leaseExpiresAtMs: number;
  /** Exact v3 supervisor identity persisted before any worker spawn. */
  scopeKey?: string;
  runId?: string;
  previousOwner?: {
    pid: number;
    pidStartTimeMs: number;
    scopeId: string;
    runId?: string;
    observed: "dead" | "reused";
    observedAtMs: number;
    /** Durable supervisor evidence, never inferred from an empty in-process registry. */
    scopeExtinct?: boolean;
  };
  recoveryBudget?: number;
  mode?: "render" | "stop_only";
};

export type SpatialReferenceJournalClaimResult =
  | {
      claimed: true;
      row: SpatialReferenceJournalRow;
      missingOutputs: SpatialReferenceExpectedOutput[];
    }
  | {
      claimed: false;
      reason:
        | "active_owner"
        | "prior_worker_unproven"
        | "cancelled"
        | "terminal"
        | "identity_conflict"
        | "recovery_exhausted"
        | "runtime_quarantined"
        | "requires_reconciliation";
      row: SpatialReferenceJournalRow;
    };

export type SpatialReferenceJournalClaimContext = {
  identity: SpatialReferenceJournalIdentity;
  owner: SpatialReferenceJournalOwner;
  nowMs: number;
  /** Finish/release need actual scope extinction or a proof no spawn occurred. */
  scopeEvidence?: "extinct" | "never_spawned";
};

export type SpatialReferenceJournalCheckpointInput = SpatialReferenceJournalClaimContext & {
  phase: "worker_started" | "worker_exited" | "render_proof" | "prepared" | "output_finalized";
  worker?: SpatialReferenceJournalWorker;
  renderProof?: SpatialReferenceJournalRenderProof;
  prepared?: {
    callback: SpatialReferenceTerminalCallback;
    outputs: readonly SpatialReferencePreparedOutput[];
  };
  finalizedOutput?: SpatialReferenceFinalizedOutput;
};

export type SpatialReferenceJournalReleaseInput = SpatialReferenceJournalClaimContext & {
  worker?: SpatialReferenceJournalWorker;
};

/** Exact, private guardian identity is recorded before the renderer start gate opens. */
export type SpatialReferenceJournalArmScopeGuardianInput = SpatialReferenceJournalClaimContext & {
  guardian: SpatialReferenceJournalScopeGuardian;
};

/**
 * Only the independently running guardian may append this observation.  It is
 * bound to the active pair version, so a stale guardian cannot release a
 * replacement execution after restart.
 */
export type SpatialReferenceJournalScopeObservationInput = SpatialReferenceJournalClaimContext & {
  guardian: SpatialReferenceJournalScopeGuardian;
  observation: Pick<
    SpatialReferenceJournalScopeRecovery,
    "state" | "observedAtMs" | "worker" | "proof" | "reason"
  >;
};

/** Narrow private writer input received only from the exact guardian IPC. */
export type SpatialReferenceJournalRecordWorkerPreparedInput =
  SpatialReferenceJournalClaimContext & {
    guardian: SpatialReferenceJournalScopeGuardian;
    worker: SpatialReferenceJournalWorker;
  };

/** Durable-before-open checkpoint for the guardian's one-shot worker gate. */
export type SpatialReferenceJournalAuthorizeWorkerStartInput =
  SpatialReferenceJournalClaimContext & {
    guardian: SpatialReferenceJournalScopeGuardian;
    worker: Pick<SpatialReferenceJournalWorker, "pid" | "startTime" | "scopeId" | "runId">;
  };

/** Durable-before-spawn checkpoint for the guardian's one-shot renderer spawn. */
export type SpatialReferenceJournalRecordSpawnIntentInput = SpatialReferenceJournalClaimContext & {
  guardian: SpatialReferenceJournalScopeGuardian;
};

export type SpatialReferenceJournalReconcileScopeInput = {
  identity: SpatialReferenceJournalIdentity;
  nowMs: number;
  /** A stop-only caller can only act on the exact durable execution. */
  mode?: "recovery" | "stop_only";
};

export type SpatialReferenceJournalReconcileScopeResult =
  | { state: "extinct" | "never_spawned"; row: SpatialReferenceJournalRow }
  | { state: "live" | "unknown" | "unavailable"; row: SpatialReferenceJournalRow };

export type SpatialReferenceJournalAcceptInput = {
  identity: SpatialReferenceJournalIdentity;
  ack: SpatialReferenceRelayDispatchAck;
  requestDigest: string;
  expectedOutputs: readonly SpatialReferenceExpectedOutput[];
  knownFinalizedReceipts?: readonly SpatialReferenceFinalizedOutput[];
};

export type SpatialReferenceJournalAcceptDetails = Omit<
  SpatialReferenceJournalAcceptInput,
  "ack" | "requestDigest"
>;

export type SpatialReferenceJournalBackend = {
  lookup(key: string): SpatialReferenceJournalStoredValue | undefined;
  update(
    key: string,
    updateValue: (
      current: SpatialReferenceJournalStoredValue | undefined,
    ) => SpatialReferenceJournalStoredValue,
  ): void;
  transaction<TResult>(
    keys: readonly string[],
    mutate: (transaction: {
      lookup(key: string): SpatialReferenceJournalStoredValue | undefined;
      set(key: string, value: SpatialReferenceJournalStoredValue): void;
      delete(key: string): void;
    }) => TResult,
  ): TResult;
  entries(): SpatialReferenceJournalStoredValue[];
};

export type SpatialReferenceRuntimeAdmission =
  | { state: "released" }
  | { state: "owned"; executionKey: string; owner: SpatialReferenceJournalClaimOwner }
  | { state: "quarantined"; fenceId: string; reason: string; scope: "exact" | "unavailable" }
  | { state: "requires_reconciliation" };

export type SpatialReferenceExclusiveAdmissionClaimInput = {
  owner: SpatialReferenceJournalOwner;
  nowMs: number;
  leaseExpiresAtMs: number;
  scopeKey: string;
  runId: string;
  runtimeId: string;
};

export type SpatialReferenceExclusiveAdmissionClaimResult =
  | {
      claimed: true;
      executionKey: "@qualification";
      owner: SpatialReferenceJournalClaimOwner;
      identity: SpatialReferenceJournalIdentity;
    }
  | {
      claimed: false;
      reason: "active_owner" | "runtime_quarantined" | "requires_reconciliation";
    };

export type SpatialReferenceExclusiveAdmissionReleaseInput = {
  owner: SpatialReferenceJournalOwner;
  nowMs: number;
  scopeEvidence: "never_spawned" | "extinct";
  /** Probe or worker spawn; never_spawned is refused when true. */
  spawned?: boolean;
};

export type SpatialReferenceExclusiveAdmissionReleaseResult =
  | { released: true }
  | { released: false; quarantined: true; reason: string };

export type SpatialReferenceJournal = {
  authority: "memory" | "sqlite";
  accept(
    input: SpatialReferenceJournalAcceptInput,
  ): Promise<{ replay: boolean; row: SpatialReferenceJournalRow; requiresRecovery: boolean }>;
  accept(
    key: string,
    ack: SpatialReferenceRelayDispatchAck,
    requestDigest?: string,
    details?: SpatialReferenceJournalAcceptDetails,
  ): Promise<{ replay: boolean; row: SpatialReferenceJournalRow; requiresRecovery?: boolean }>;
  cancel(
    key: string,
    dispatchAttemptId: string,
    claimContext?: SpatialReferenceJournalClaimContext,
  ): Promise<SpatialReferenceJournalRow>;
  finish(
    key: string,
    callback: SpatialReferenceTerminalCallback,
    claimContext?: SpatialReferenceJournalClaimContext,
  ): Promise<SpatialReferenceTerminalCallback>;
  list(): Promise<SpatialReferenceJournalRow[]>;
  get(key: string): Promise<SpatialReferenceJournalRow | undefined>;
  getRuntimeAdmission(): Promise<SpatialReferenceRuntimeAdmission>;
  claimExclusiveAdmission(
    input: SpatialReferenceExclusiveAdmissionClaimInput,
  ): Promise<SpatialReferenceExclusiveAdmissionClaimResult>;
  releaseExclusiveAdmission(
    input: SpatialReferenceExclusiveAdmissionReleaseInput,
  ): Promise<SpatialReferenceExclusiveAdmissionReleaseResult>;
  delivered(
    key: string,
    callback: SpatialReferenceTerminalCallback,
    claimContext?: SpatialReferenceJournalClaimContext,
  ): Promise<void>;
  claim(input: SpatialReferenceJournalClaimInput): Promise<SpatialReferenceJournalClaimResult>;
  checkClaim(input: SpatialReferenceJournalClaimContext): Promise<SpatialReferenceJournalRow>;
  checkpoint(input: SpatialReferenceJournalCheckpointInput): Promise<SpatialReferenceJournalRow>;
  release(input: SpatialReferenceJournalReleaseInput): Promise<SpatialReferenceJournalRow>;
  armScopeGuardian(
    input: SpatialReferenceJournalArmScopeGuardianInput,
  ): Promise<SpatialReferenceJournalRow>;
  recordSpawnIntent(
    input: SpatialReferenceJournalRecordSpawnIntentInput,
  ): Promise<SpatialReferenceJournalRow>;
  recordWorkerPrepared(
    input: SpatialReferenceJournalRecordWorkerPreparedInput,
  ): Promise<SpatialReferenceJournalRow>;
  authorizeWorkerStart(
    input: SpatialReferenceJournalAuthorizeWorkerStartInput,
  ): Promise<SpatialReferenceJournalRow>;
  recordScopeObservation(
    input: SpatialReferenceJournalScopeObservationInput,
  ): Promise<SpatialReferenceJournalRow>;
  reconcileScope(
    input: SpatialReferenceJournalReconcileScopeInput,
  ): Promise<SpatialReferenceJournalReconcileScopeResult>;
};
