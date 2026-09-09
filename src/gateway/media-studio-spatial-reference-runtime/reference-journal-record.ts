import type { SpatialReferenceRelayDispatchAck } from "../media-studio-spatial-reference-render-http.js";
import type { SpatialReferenceTerminalCallback } from "./reference-callback.js";

export const SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION = 4;
export type SpatialReferenceJournalSchemaVersion =
  | 2
  | 3
  | typeof SPATIAL_REFERENCE_JOURNAL_SCHEMA_VERSION;

export type SpatialReferenceJournalIdentity = {
  key: string;
  runtimeId: string;
  runtimeIdempotencyKey: string;
  executionId: string;
  workspaceId: string;
  taskId: string;
  materializationId: string;
  dispatchAttemptId: string;
  sequence: number;
  attempt: number;
  intentFingerprint: string;
  executionFingerprint: string;
  blueprintDigest: string;
  contractVersion: "spatial_reference_render/v1" | "spatial_reference_render/v2";
  rendererBuildDigest: string;
  frozenDispatchDigest: string;
};

export type SpatialReferenceJournalOwner = {
  epoch: string;
  pid: number;
  pidStartTimeMs: number;
  ownerInstanceId: string;
};

/** Persisted before spawn; the four base owner fields remain the process fence. */
export type SpatialReferenceJournalClaimOwner = SpatialReferenceJournalOwner & {
  leaseExpiresAtMs: number;
  claimVersion: number;
  scopeKey: string;
  runId: string;
};

export type SpatialReferenceExpectedOutput = {
  slot: string;
  ordinal: number;
  artifactId: string;
  expectedMimeType: "image/png" | "video/mp4";
  sourceTimeMs?: number;
};

export type SpatialReferencePreparedOutput = {
  slot: string;
  ordinal: number;
  artifactId: string;
  size: number;
  sha256Hex: string;
  mimeType: "image/png" | "video/mp4";
};

export type SpatialReferenceFinalizedOutput = SpatialReferencePreparedOutput & {
  storageKey: string;
};

export type SpatialReferenceJournalWorker = {
  pid: number;
  startTime: number;
  scopeId: string;
  runId?: string;
  workerTokenDigest: string;
  exited?: {
    atMs: number;
    reason: "completed" | "cancelled" | "parent_lost" | "dead" | "reused";
  };
};

/**
 * A private, start-gated companion that survives a gateway-process crash long
 * enough to observe the exact owned worker process group.  It is deliberately
 * an execution-row fact (not a second journal or a user-visible lifecycle).
 */
export type SpatialReferenceJournalScopeGuardian = {
  protocol: "spatial_guardian/v1";
  guardianId: string;
  generation: string;
  pid: number;
  pidStartTimeMs: number;
  /** The frozen v2 manifest digest also covers this resolved guardian entry. */
  guardianBuildDigest: string;
  armedAtMs: number;
};

/**
 * A terminal receipt means the guardian itself, rather than a fresh in-memory
 * supervisor registry, observed the persisted worker scope.  `unknown` is
 * terminal for automatic recovery but deliberately does not release quarantine.
 */
export type SpatialReferenceJournalScopeRecovery = {
  guardian: SpatialReferenceJournalScopeGuardian;
  claimVersion: number;
  owner: SpatialReferenceJournalOwner;
  state: "armed" | "watching" | "extinct" | "never_spawned" | "unknown";
  observedAtMs: number;
  /** Bounded reconciliation attempts are persisted; a loop cannot reset on restart. */
  probes: number;
  firstObservedAtMs: number;
  worker?: Pick<SpatialReferenceJournalWorker, "pid" | "startTime" | "scopeId" | "runId">;
  proof?:
    | {
        protocol: "windows_job_v1";
        jobIncarnationId: string;
        activeProcessCount: 0;
        workerPid: number;
        workerStartTime: number;
      }
    | {
        protocol: "posix_group_observation_v1";
        processGroupId: number;
        rootState: "dead" | "reused";
      };
  reason?:
    | "guardian_unavailable"
    | "identity_mismatch"
    | "scope_live_timeout"
    | "scope_observation_unknown"
    | "posix_scope_unproven"
    | "windows_job_unavailable";
};

export type SpatialReferenceJournalPhase =
  | "accepted"
  | "claimed"
  | "render_proven"
  | "prepared"
  | "uploading"
  | "terminal"
  | "legacy_nonresumable"
  | "legacy_reconciling";

export type SpatialReferenceJournalRenderProof = {
  rendererBuildDigest: string;
  completedAtMs: number;
  outputDigest?: string;
};

export type SpatialReferenceJournalRow = {
  recordType: "execution";
  schemaVersion: SpatialReferenceJournalSchemaVersion;
  key: string;
  dispatchAttemptId: string;
  cancelled: boolean;
  phase: SpatialReferenceJournalPhase;
  /** Immutable ACK origin; recovery deadlines must never move on re-claim. */
  acceptedAtMs?: number;
  requestDigest?: string;
  ack?: SpatialReferenceRelayDispatchAck;
  callback?: SpatialReferenceTerminalCallback;
  delivered?: boolean;
  identity?: SpatialReferenceJournalIdentity;
  expectedOutputs?: SpatialReferenceExpectedOutput[];
  knownFinalizedReceipts?: SpatialReferenceFinalizedOutput[];
  renderProof?: SpatialReferenceJournalRenderProof;
  prepared?: {
    callback: SpatialReferenceTerminalCallback;
    outputs: SpatialReferencePreparedOutput[];
  };
  claim?: SpatialReferenceJournalClaimOwner;
  /** Survives owner release so post-crash recovery cannot reset its budget. */
  recoveryCount?: number;
  worker?: SpatialReferenceJournalWorker;
  /** Private durable recovery authority for v3 owned process groups. */
  scopeRecovery?: SpatialReferenceJournalScopeRecovery;
  /**
   * Private schema-v4 launch checkpoint. This is deliberately orthogonal to
   * public execution phase and scope-recovery observation.
   */
  launchState?: "armed" | "spawn_intent" | "worker_prepared" | "start_authorized";
  cancelFence?: {
    dispatchAttemptId: string;
    fenceEpoch: string;
    requestedAtMs: number;
  };
  reconciliation?: {
    kind: "legacy_torn_pair" | "legacy_lock_unmapped";
    observedAtMs: number;
    probes: number;
    legacyLockOwner?: SpatialReferenceJournalOwner;
    legacyRowOwner?: SpatialReferenceJournalOwner;
  };
};

export type SpatialReferenceRuntimeQuarantine = {
  fenceId: string;
  sourceExecutionKey?: string;
  reason: "legacy_owner_unproven" | "legacy_scope_unproven" | "scope_stop_unconfirmed";
  enteredAtMs: number;
  legacyLockOwner?: SpatialReferenceJournalOwner;
  legacyRowOwner?: SpatialReferenceJournalOwner;
  scope: { state: "exact"; scopeKey: string; runId: string } | { state: "unavailable" };
  stopOnly?: { requestedAtMs: number; requestId: string };
  manualRecoveryProofDigest?: string;
};

export type SpatialReferenceRuntimeLock = {
  recordType: "runtime_lock";
  schemaVersion: SpatialReferenceJournalSchemaVersion;
  runtimeId: string;
  /** v2 lock used @released; v3 has an explicit state. */
  state?: "released" | "owned" | "quarantined";
  executionKey?: string;
  owner?: SpatialReferenceJournalClaimOwner | SpatialReferenceJournalOwner;
  claimVersion?: number;
  quarantine?: SpatialReferenceRuntimeQuarantine;
};

export type SpatialReferenceJournalMigration = {
  recordType: "migration";
  schemaVersion: SpatialReferenceJournalSchemaVersion;
  state: "in_progress" | "complete";
  sourceDigest: string;
};

export type SpatialReferenceJournalStoredValue =
  | SpatialReferenceJournalRow
  | SpatialReferenceRuntimeLock
  | SpatialReferenceJournalMigration;

export function outputKey(input: Pick<SpatialReferenceExpectedOutput, "slot" | "ordinal">): string {
  return `${input.slot}:${input.ordinal}`;
}

export function sameIdentity(
  left: SpatialReferenceJournalIdentity,
  right: SpatialReferenceJournalIdentity,
): boolean {
  return (
    left.key === right.key &&
    left.runtimeId === right.runtimeId &&
    left.runtimeIdempotencyKey === right.runtimeIdempotencyKey &&
    left.executionId === right.executionId &&
    left.workspaceId === right.workspaceId &&
    left.taskId === right.taskId &&
    left.materializationId === right.materializationId &&
    left.dispatchAttemptId === right.dispatchAttemptId &&
    left.sequence === right.sequence &&
    left.attempt === right.attempt &&
    left.intentFingerprint === right.intentFingerprint &&
    left.executionFingerprint === right.executionFingerprint &&
    left.blueprintDigest === right.blueprintDigest &&
    left.contractVersion === right.contractVersion &&
    left.rendererBuildDigest === right.rendererBuildDigest &&
    left.frozenDispatchDigest === right.frozenDispatchDigest
  );
}

export function sameOwner(
  left: SpatialReferenceJournalOwner,
  right: SpatialReferenceJournalOwner,
): boolean {
  return (
    left.epoch === right.epoch &&
    left.pid === right.pid &&
    left.pidStartTimeMs === right.pidStartTimeMs &&
    left.ownerInstanceId === right.ownerInstanceId
  );
}

export function sameClaimOwner(
  left: SpatialReferenceJournalClaimOwner,
  right: SpatialReferenceJournalClaimOwner,
): boolean {
  return (
    sameOwner(left, right) &&
    left.leaseExpiresAtMs === right.leaseExpiresAtMs &&
    left.claimVersion === right.claimVersion &&
    left.scopeKey === right.scopeKey &&
    left.runId === right.runId
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
