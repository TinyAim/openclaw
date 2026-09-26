import { spawn, spawnSync, type ChildProcess, type Serializable } from "node:child_process";
/**
 * Private per-execution Guardian. It has no Control API token, upload grant,
 * or render geometry. Its reserved journal context permits only this
 * incarnation's scoped lifecycle checkpoints; the gateway still owns product
 * state and authorizes the Worker start after exact IPC readback.
 */
import { createHash } from "node:crypto";
import { resolveRuntimeWorkerArgv } from "../../infra/runtime-worker-url.js";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.js";
import { signalProcessTree } from "../../process/kill-tree.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import type {
  SpatialReferenceJournalIdentity,
  SpatialReferenceJournalOwner,
  SpatialReferenceJournalScopeGuardian,
  SpatialReferenceJournalScopeGuardianReservation,
  SpatialReferenceJournalWorker,
} from "./reference-journal-record.js";
import { sameIdentity, sameOwner } from "./reference-journal-record.js";
import {
  createSpatialReferenceJournal,
  type SpatialReferenceJournal,
} from "./reference-journal.js";
import type {
  SpatialReferenceV2GuardianJournalContext,
  SpatialReferenceV2GuardianLaunchContext,
} from "./v2-renderer.contract.js";

type WorkerIdentity = { pid: number; startTime: number };

const POSIX_SCOPE_POLL_MS = 50;
const POSIX_SCOPE_TIMEOUT_MS = 10_000;

function processGroupId(pid: number): number | undefined {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
      timeout: 500,
    });
    const value = Number(result.stdout.trim());
    return result.error || result.status !== 0 || !Number.isSafeInteger(value) || value < 1
      ? undefined
      : value;
  } catch {
    return undefined;
  }
}

function processGroupMemberCount(pgid: number): number | undefined {
  try {
    const result = spawnSync("ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8",
      timeout: 500,
    });
    if (result.error || result.status !== 0) return undefined;
    let count = 0;
    for (const line of result.stdout.split("\n")) {
      const [pidText, pgidText] = line.trim().split(/\s+/u);
      if (!Number.isSafeInteger(Number(pidText)) || Number(pgidText) !== pgid) continue;
      count += 1;
    }
    return count;
  } catch {
    return undefined;
  }
}

async function observePosixScopeExtinction(
  worker: WorkerIdentity,
  pgid: number,
): Promise<
  | {
      protocol: "posix_group_observation_v1";
      processGroupId: number;
      rootState: "dead" | "reused";
    }
  | undefined
> {
  const deadline = Date.now() + POSIX_SCOPE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const members = processGroupMemberCount(pgid);
    const observedStart = getFileLockProcessStartTime(worker.pid);
    const rootState =
      observedStart === null ? "dead" : observedStart === worker.startTime ? undefined : "reused";
    if (members === 0 && rootState) {
      return { protocol: "posix_group_observation_v1", processGroupId: pgid, rootState };
    }
    await new Promise((resolve) => setTimeout(resolve, POSIX_SCOPE_POLL_MS));
  }
  return undefined;
}

type GuardianJournalControl = {
  type: "spatial-guardian-journal-context-v1";
  generation: string;
  sequence: 0;
  journal: Pick<
    SpatialReferenceV2GuardianJournalContext,
    "stateDir" | "namespace" | "identity" | "owner"
  >;
  guardian: SpatialReferenceJournalScopeGuardian;
  scope: { scopeKey: string; runId: string };
};

let durable:
  | {
      journal: SpatialReferenceJournal;
      context: GuardianJournalControl;
      spawnIntentRecorded: boolean;
      worker?: SpatialReferenceJournalWorker;
    }
  | undefined;

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("spatial_guardian_arguments_invalid");
  }
  return value;
}

function launchContextArgument(): SpatialReferenceV2GuardianLaunchContext {
  try {
    const value: unknown = JSON.parse(requiredArgument("--journal-launch-v1"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("spatial_guardian_launch_context_invalid");
    }
    const context = value as Partial<SpatialReferenceV2GuardianLaunchContext>;
    const reservation = context.reservation as
      | Partial<SpatialReferenceJournalScopeGuardianReservation>
      | undefined;
    const identity = context.identity as SpatialReferenceJournalIdentity | undefined;
    const owner = context.owner as SpatialReferenceJournalOwner | undefined;
    if (
      typeof context.stateDir !== "string" ||
      !context.stateDir ||
      typeof context.namespace !== "string" ||
      !context.namespace ||
      !identity ||
      !owner ||
      reservation?.protocol !== "spatial_guardian_reservation/v1" ||
      typeof reservation.generation !== "string" ||
      !reservation.generation ||
      typeof reservation.guardianBuildDigest !== "string" ||
      !reservation.guardianBuildDigest ||
      typeof reservation.scopeKey !== "string" ||
      !reservation.scopeKey ||
      typeof reservation.runId !== "string" ||
      !reservation.runId
    ) {
      throw new Error("spatial_guardian_launch_context_invalid");
    }
    return context as SpatialReferenceV2GuardianLaunchContext;
  } catch {
    throw new Error("spatial_guardian_launch_context_invalid");
  }
}

function send(message: unknown): void {
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {
    // Parent loss is a cleanup trigger; it is never a success receipt.
  }
}

async function waitForMessage<T>(predicate: (message: unknown) => message is T): Promise<T> {
  if (!process.connected || !process.channel) {
    throw new Error("spatial_guardian_ipc_missing");
  }
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const onMessage = (message: unknown) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("spatial_guardian_parent_lost"));
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

function isStart(message: unknown): message is { type: "openclaw-worker-start-v1" } {
  return Boolean(
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { type?: unknown }).type === "openclaw-worker-start-v1",
  );
}

function isAuthorize(
  message: unknown,
  generation: string,
): message is {
  type: "spatial-guardian-authorize-start-v1";
  generation: string;
  sequence: number;
} {
  return Boolean(
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { type?: unknown }).type === "spatial-guardian-authorize-start-v1" &&
    (message as { generation?: unknown }).generation === generation &&
    (message as { sequence?: unknown }).sequence === 1,
  );
}

function isSpawnIntentAcknowledged(message: unknown, generation: string): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { type?: unknown }).type === "spatial-guardian-spawn-intent-ack-v1" &&
    (message as { generation?: unknown }).generation === generation &&
    (message as { sequence?: unknown }).sequence === 0,
  );
}

function isJournalContext(message: unknown, generation: string): message is GuardianJournalControl {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const value = message as Partial<GuardianJournalControl>;
  return (
    value.type === "spatial-guardian-journal-context-v1" &&
    value.generation === generation &&
    value.sequence === 0 &&
    Boolean(
      value.journal &&
      typeof value.journal === "object" &&
      typeof value.journal.stateDir === "string" &&
      value.journal.stateDir &&
      typeof value.journal.namespace === "string" &&
      value.journal.namespace &&
      value.journal.identity &&
      value.journal.owner &&
      value.guardian &&
      Boolean(
        value.scope &&
        typeof value.scope.scopeKey === "string" &&
        value.scope.scopeKey &&
        typeof value.scope.runId === "string" &&
        value.scope.runId,
      ),
    )
  );
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

function matchesLaunchContext(
  received: GuardianJournalControl,
  expected: GuardianJournalControl,
): boolean {
  return (
    received.generation === expected.generation &&
    received.journal.stateDir === expected.journal.stateDir &&
    received.journal.namespace === expected.journal.namespace &&
    sameIdentity(received.journal.identity, expected.journal.identity) &&
    sameOwner(received.journal.owner, expected.journal.owner) &&
    sameGuardian(received.guardian, expected.guardian) &&
    received.scope.scopeKey === expected.scope.scopeKey &&
    received.scope.runId === expected.scope.runId
  );
}

function childMessage(child: ChildProcess, message: unknown): Promise<void> {
  if (!child.connected) return Promise.reject(new Error("spatial_guardian_worker_ipc_closed"));
  return new Promise((resolve, reject) => {
    try {
      child.send?.(message as Serializable, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

function isWorkerReady(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { type?: unknown }).type === "openclaw-worker-ready-v1",
  );
}

async function recordGuardianObservation(
  state: "never_spawned" | "unknown" | "extinct",
  reason?: "scope_observation_unknown" | "guardian_unavailable",
  proof?: {
    protocol: "posix_group_observation_v1";
    processGroupId: number;
    rootState: "dead" | "reused";
  },
): Promise<void> {
  if (!durable) return;
  const { journal, context, worker } = durable;
  await journal.recordScopeObservation({
    identity: context.journal.identity,
    owner: context.journal.owner,
    guardian: context.guardian,
    nowMs: Date.now(),
    observation: {
      state,
      observedAtMs: Date.now(),
      ...(worker
        ? {
            worker: {
              pid: worker.pid,
              startTime: worker.startTime,
              scopeId: worker.scopeId,
              runId: worker.runId,
            },
          }
        : {}),
      ...(reason ? { reason } : {}),
      ...(proof ? { proof } : {}),
    },
  });
}

async function run(): Promise<void> {
  const workerUrl = new URL(requiredArgument("--renderer-worker-url"));
  if (workerUrl.protocol !== "file:") throw new Error("spatial_guardian_worker_url_invalid");
  const requestPath = requiredArgument("--request");
  const manifestPath = requiredArgument("--manifest");
  const generation = requiredArgument("--generation");
  const launch = launchContextArgument();
  const reservation = launch.reservation;
  if (
    reservation.generation !== generation ||
    !sameOwner(reservation.owner, launch.owner) ||
    launch.identity.runtimeId.length === 0
  ) {
    throw new Error("spatial_guardian_launch_context_invalid");
  }
  const guardianStartTime = getFileLockProcessStartTime(process.pid);
  if (guardianStartTime === null) throw new Error("spatial_guardian_identity_unavailable");
  const guardian: SpatialReferenceJournalScopeGuardian = {
    protocol: "spatial_guardian/v1",
    guardianId: `spatial-guardian:${reservation.owner.epoch}:${process.pid}`,
    generation,
    pid: process.pid,
    pidStartTimeMs: guardianStartTime,
    guardianBuildDigest: reservation.guardianBuildDigest,
    armedAtMs: Date.now(),
  };
  const journalContext: GuardianJournalControl = {
    type: "spatial-guardian-journal-context-v1",
    generation,
    sequence: 0,
    journal: {
      stateDir: launch.stateDir,
      namespace: launch.namespace,
      identity: launch.identity,
      owner: launch.owner,
    },
    guardian,
    scope: { scopeKey: reservation.scopeKey, runId: reservation.runId },
  };
  const journal = createSpatialReferenceJournal({
    env: { OPENCLAW_STATE_DIR: launch.stateDir },
    namespace: launch.namespace,
  });
  durable = { journal, context: journalContext, spawnIntentRecorded: false };
  await journal.armScopeGuardian({
    identity: launch.identity,
    owner: launch.owner,
    guardian,
    nowMs: Date.now(),
  });

  const initialStart = waitForMessage(isStart);
  send({ type: "openclaw-worker-ready-v1" });
  await initialStart;
  send({ type: "openclaw-worker-started-v1" });
  const receivedContext = await waitForMessage((message): message is GuardianJournalControl =>
    isJournalContext(message, generation),
  );
  if (!matchesLaunchContext(receivedContext, journalContext)) {
    throw new Error("spatial_guardian_journal_identity_invalid");
  }
  const context = journalContext;
  await durable.journal.recordSpawnIntent({
    identity: context.journal.identity,
    owner: context.journal.owner,
    guardian: context.guardian,
    nowMs: Date.now(),
  });
  durable.spawnIntentRecorded = true;
  send({ type: "spatial-guardian-spawn-intent-v1", generation, sequence: 0 });
  await waitForMessage(
    (
      message,
    ): message is {
      type: "spatial-guardian-spawn-intent-ack-v1";
      generation: string;
      sequence: number;
    } => isSpawnIntentAcknowledged(message, generation),
  );
  const worker = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(workerUrl), "--request", requestPath, "--manifest", manifestPath],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.on("message", (message) => {
      if (isWorkerReady(message)) resolve();
      if (
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as { type?: unknown }).type === "spatial-v2-toolchain-proof-v1"
      ) {
        // The renderer child does not know the guardian generation.  Bind the
        // proof to this exact guardian before it crosses the private IPC hop.
        send({ ...(message as Record<string, unknown>), generation });
      }
      if (
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as { type?: unknown }).type === "spatial-v2-failed"
      ) {
        send(message);
      }
    });
    worker.once("exit", () => reject(new Error("spatial_guardian_worker_exited_before_ready")));
  });
  if (!worker.pid || !worker.connected) throw new Error("spatial_guardian_worker_spawn_failed");
  const startTime = getFileLockProcessStartTime(worker.pid);
  if (startTime === null) throw new Error("spatial_guardian_worker_identity_unavailable");
  const identity: WorkerIdentity = { pid: worker.pid, startTime };
  const pgid = process.platform === "win32" ? undefined : processGroupId(identity.pid);
  if (process.platform !== "win32" && pgid !== identity.pid) {
    throw new Error("spatial_guardian_posix_scope_unavailable");
  }
  const journalWorker: SpatialReferenceJournalWorker = {
    pid: identity.pid,
    startTime: identity.startTime,
    scopeId: context.scope.scopeKey,
    runId: context.scope.runId,
    workerTokenDigest: createHash("sha256").update(context.scope.runId).digest("hex"),
  };

  let cleanupRequested = false;
  const cleanup = () => {
    if (cleanupRequested) return;
    cleanupRequested = true;
    signalProcessTree(identity.pid, "SIGTERM", { detached: process.platform !== "win32" });
    setTimeout(
      () => signalProcessTree(identity.pid, "SIGKILL", { detached: process.platform !== "win32" }),
      1_000,
    ).unref?.();
  };
  process.once("disconnect", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);

  await ready;
  await durable.journal.recordWorkerPrepared({
    identity: context.journal.identity,
    owner: context.journal.owner,
    guardian: context.guardian,
    worker: journalWorker,
    nowMs: Date.now(),
  });
  durable.worker = journalWorker;
  send({ type: "spatial-guardian-worker-prepared-v1", generation, sequence: 1, worker: identity });
  await waitForMessage(
    (
      message,
    ): message is {
      type: "spatial-guardian-authorize-start-v1";
      generation: string;
      sequence: number;
    } => isAuthorize(message, generation),
  );
  await durable.journal.authorizeWorkerStart({
    identity: context.journal.identity,
    owner: context.journal.owner,
    guardian: context.guardian,
    worker: journalWorker,
    nowMs: Date.now(),
  });
  send({ type: "spatial-guardian-start-authorized-v1", generation, sequence: 2, worker: identity });
  await childMessage(worker, { type: "openclaw-worker-start-v1" });
  await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  const posixProof =
    process.platform !== "win32" && pgid !== undefined
      ? await observePosixScopeExtinction(identity, pgid)
      : undefined;
  if (posixProof) {
    await durable.journal.recordScopeObservation({
      identity: context.journal.identity,
      owner: context.journal.owner,
      guardian: context.guardian,
      nowMs: Date.now(),
      observation: {
        state: "extinct",
        worker: journalWorker,
        proof: posixProof,
        observedAtMs: Date.now(),
      },
    });
    send({
      type: "spatial-guardian-scope-observation-v1",
      generation,
      sequence: 2,
      worker: identity,
      state: "extinct",
      proof: posixProof,
    });
  } else {
    await recordGuardianObservation("unknown", "scope_observation_unknown");
    send({
      type: "spatial-guardian-scope-observation-v1",
      generation,
      sequence: 2,
      worker: identity,
      state: "unknown",
      reason: process.platform === "win32" ? "windows_job_unavailable" : "posix_scope_unproven",
    });
  }
  // The private IPC channel is also the supervisor's ownership boundary.
  // Close it only after the terminal scope observation; an open channel would
  // retain the guardian forever and prevent scope settlement.
  closePluginStateDatabase();
  if (process.connected && typeof process.disconnect === "function") {
    process.once("disconnect", () => process.exit(0));
    process.disconnect();
  } else {
    process.exit(0);
  }
}

void run().catch(async (error: unknown) => {
  try {
    await recordGuardianObservation(
      durable?.spawnIntentRecorded ? "unknown" : "never_spawned",
      durable?.spawnIntentRecorded ? "guardian_unavailable" : undefined,
    );
  } catch {
    // A failed narrow writer is never substituted by an in-memory success fact.
  }
  send({
    type: "spatial-guardian-failed-v1",
    code: error instanceof Error ? error.message.slice(0, 160) : "spatial_guardian_failed",
  });
  closePluginStateDatabase();
  process.exitCode = 1;
});
