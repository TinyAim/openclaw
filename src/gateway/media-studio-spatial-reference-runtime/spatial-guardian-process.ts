/** Private Guardian process probes; no product authority or external effects. */
import { ChildProcess, type Serializable } from "node:child_process";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";

export type WorkerIdentity = { pid: number; startTime: number };
export type PosixScopeProof = {
  protocol: "posix_group_observation_v1";
  processGroupId: number;
  rootState: "dead" | "reused";
};
const POSIX_SCOPE_POLL_MS = 50;
const POSIX_SCOPE_TIMEOUT_MS = 10_000;

type ProbeDependencies = {
  probe: (pid: number) => void;
  readStart: (pid: number) => number | null;
};
const nativeProbes: ProbeDependencies = {
  probe: (pid) => {
    process.kill(pid, 0);
  },
  readStart: getFileLockProcessStartTime,
};
function existence(
  pid: number,
  probe: ProbeDependencies["probe"],
): "present" | "absent" | "unknown" {
  try {
    probe(pid);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
  }
}

const ownedSpawn = Symbol("spatial_guardian_native_detached_spawn");
export type GuardianOwnedSpawnReceipt = {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly [ownedSpawn]: true;
};
/** Only the Guardian's fixed trusted native spawn can create this receipt.
 * On POSIX, Node detached spawn creates a new session/group led by the child.
 * No arbitrary PID or serialized payload substitutes for that native event.
 */
export function observeGuardianOwnedWorkerSpawn(
  child: ChildProcess,
  detached: boolean,
): Promise<GuardianOwnedSpawnReceipt> {
  if (!(child instanceof ChildProcess) || !detached || child.spawnfile !== process.execPath) {
    return Promise.reject(new Error("spatial_guardian_posix_scope_unavailable"));
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      if (!Number.isSafeInteger(child.pid) || child.pid! < 2) {
        reject(new Error("spatial_guardian_posix_scope_unavailable"));
        return;
      }
      resolve(Object.freeze({ child, pid: child.pid!, [ownedSpawn]: true as const }));
    });
  });
}

export function processGroupId(receipt: GuardianOwnedSpawnReceipt): number | undefined {
  if (
    !receipt ||
    receipt[ownedSpawn] !== true ||
    !(receipt.child instanceof ChildProcess) ||
    receipt.child.pid !== receipt.pid ||
    receipt.child.killed ||
    receipt.child.exitCode !== null ||
    receipt.child.signalCode !== null
  )
    return undefined;
  return existence(-receipt.pid, nativeProbes.probe) === "present" ? receipt.pid : undefined;
}

/** ESRCH is an empty-group snapshot. A root read failure is never a dead root.
 * The final group check keeps a PID/group reuse during the probes fail closed.
 */
export function inspectSpatialPosixScopeExtinction(
  worker: WorkerIdentity,
  pgid: number,
  dependencies: ProbeDependencies = nativeProbes,
): PosixScopeProof | undefined {
  if (
    !Number.isSafeInteger(pgid) ||
    pgid < 2 ||
    pgid !== worker.pid ||
    !Number.isSafeInteger(worker.startTime) ||
    worker.startTime < 0
  )
    return undefined;
  if (existence(-pgid, dependencies.probe) !== "absent") return undefined;
  const root = existence(worker.pid, dependencies.probe);
  let rootState: PosixScopeProof["rootState"];
  if (root === "absent") rootState = "dead";
  else if (root === "present") {
    const startedAt = dependencies.readStart(worker.pid);
    if (
      startedAt === null ||
      !Number.isSafeInteger(startedAt) ||
      startedAt < 0 ||
      startedAt === worker.startTime
    )
      return undefined;
    rootState = "reused";
  } else return undefined;
  if (existence(-pgid, dependencies.probe) !== "absent") return undefined;
  return { protocol: "posix_group_observation_v1", processGroupId: pgid, rootState };
}

export async function observePosixScopeExtinction(
  worker: WorkerIdentity,
  pgid: number,
  dependencies: ProbeDependencies = nativeProbes,
): Promise<PosixScopeProof | undefined> {
  const deadline = Date.now() + POSIX_SCOPE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const proof = inspectSpatialPosixScopeExtinction(worker, pgid, dependencies);
    if (Date.now() >= deadline) return undefined;
    if (proof) return proof;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POSIX_SCOPE_POLL_MS, remaining)));
  }
  return undefined;
}

export function isStart(message: unknown): message is { type: "openclaw-worker-start-v1" } {
  return Boolean(
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { type?: unknown }).type === "openclaw-worker-start-v1",
  );
}

export function childMessage(child: ChildProcess, message: unknown): Promise<void> {
  if (!child.connected) return Promise.reject(new Error("spatial_guardian_worker_ipc_closed"));
  return new Promise((resolve, reject) => {
    try {
      child.send?.(message as Serializable, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

export function isWorkerReady(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { type?: unknown }).type === "openclaw-worker-ready-v1",
  );
}
