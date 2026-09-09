import fs from "node:fs/promises";
import path from "node:path";
import { runExec } from "../../process/exec.js";

const RSS_POLL_MS = 100;
type LinuxProcess = { pid: number; ppid: number; rssBytes: number };

function parseLinuxStatus(pid: number, status: string): LinuxProcess | undefined {
  const ppid = Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1]);
  const residentKb = Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1]);
  if (!Number.isInteger(ppid) || ppid < 0 || !Number.isInteger(residentKb) || residentKb < 0) {
    return undefined;
  }
  return { pid, ppid, rssBytes: residentKb * 1024 };
}

function parseLinuxStat(pid: number, stat: string): Pick<LinuxProcess, "pid" | "ppid"> | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) {
    return undefined;
  }
  const fields = stat
    .slice(close + 1)
    .trimStart()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  if (!Number.isInteger(ppid) || ppid < 0) {
    return undefined;
  }
  return { pid, ppid };
}

async function linuxDescendantRssBytes(rootPid: number): Promise<number | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return undefined;
  }
  const processes = new Map<number, LinuxProcess>();
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/u.test(entry)) {
        return;
      }
      const pid = Number(entry);
      try {
        const [stat, status] = await Promise.all([
          fs.readFile(path.join("/proc", entry, "stat"), "utf8"),
          fs.readFile(path.join("/proc", entry, "status"), "utf8"),
        ]);
        const lineage = parseLinuxStat(pid, stat);
        const memory = parseLinuxStatus(pid, status);
        if (lineage && memory && lineage.ppid === memory.ppid) {
          processes.set(pid, memory);
        }
      } catch {
        // A process can disappear between readdir and read; retry on the next bounded poll.
      }
    }),
  );
  if (!processes.has(rootPid)) {
    // A partial /proc read must never make an over-limit live tree look empty.
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const process of processes.values()) {
    const descendants = children.get(process.ppid) ?? [];
    descendants.push(process.pid);
    children.set(process.ppid, descendants);
  }
  const pending = [rootPid];
  const visited = new Set<number>();
  let rssBytes = 0;
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    const process = processes.get(pid);
    if (!process) {
      continue;
    }
    rssBytes += process.rssBytes;
    pending.push(...(children.get(pid) ?? []));
  }
  return rssBytes;
}

function parseDarwinProcessSnapshot(output: string): Map<number, LinuxProcess> | undefined {
  const processes = new Map<number, LinuxProcess>();
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [pidValue, ppidValue, residentKbValue, ...extra] = trimmed.split(/\s+/u);
    const pid = Number(pidValue);
    const ppid = Number(ppidValue);
    const residentKb = Number(residentKbValue);
    if (
      extra.length > 0 ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      !Number.isSafeInteger(residentKb) ||
      residentKb < 0 ||
      processes.has(pid)
    ) {
      return undefined;
    }
    processes.set(pid, { pid, ppid, rssBytes: residentKb * 1024 });
  }
  return processes;
}

function descendantRssBytes(
  rootPid: number,
  processes: ReadonlyMap<number, LinuxProcess>,
): number | undefined {
  if (!processes.has(rootPid)) {
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const process of processes.values()) {
    const descendants = children.get(process.ppid) ?? [];
    descendants.push(process.pid);
    children.set(process.ppid, descendants);
  }
  const pending = [rootPid];
  const visited = new Set<number>();
  let rssBytes = 0;
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    const process = processes.get(pid);
    if (!process) {
      return undefined;
    }
    rssBytes += process.rssBytes;
    pending.push(...(children.get(pid) ?? []));
  }
  return rssBytes;
}

async function darwinDescendantRssBytes(rootPid: number): Promise<number | undefined> {
  try {
    // /bin/ps is an OS-owned, absolute-path observer. The one-shot snapshot keeps
    // PID/PPID/RSS internally consistent rather than stitching multiple reads.
    const { stdout } = await runExec("/bin/ps", ["-axo", "pid=,ppid=,rss="], {
      timeoutMs: 1_000,
      maxBuffer: 4 * 1024 * 1024,
      logOutput: false,
    });
    const processes = parseDarwinProcessSnapshot(stdout);
    return processes ? descendantRssBytes(rootPid, processes) : undefined;
  } catch {
    return undefined;
  }
}

/** Verified full-tree RSS observers: Linux procfs and Darwin's atomic ps snapshot. */
export function supportsSpatialReferenceV2ResourceLimits(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

/** Return an exact one-snapshot tree RSS reading, or undefined when observation is incomplete. */
export async function readSpatialReferenceV2TreeRssBytes(
  rootPid: number,
): Promise<number | undefined> {
  if (process.platform === "linux") {
    return await linuxDescendantRssBytes(rootPid);
  }
  if (process.platform === "darwin") {
    return await darwinDescendantRssBytes(rootPid);
  }
  return undefined;
}

export type SpatialReferenceV2RssSamplePhase =
  | "periodic"
  | "post_browser_launch"
  | "post_host_load"
  | "post_first_webgl_frame"
  | "before_ffmpeg"
  | "after_ffmpeg";

export type SpatialReferenceV2RssSample = {
  phase: SpatialReferenceV2RssSamplePhase;
  rssBytes: number;
  observedAtMs: number;
};

export type SpatialReferenceV2RssWatch = {
  /** Boundary samples are awaited; an unavailable/over-limit observation aborts before work continues. */
  sampleBoundary: (phase: Exclude<SpatialReferenceV2RssSamplePhase, "periodic">) => Promise<void>;
  stop: () => void;
  diagnostics: () => { peakBytes: number; samples: readonly SpatialReferenceV2RssSample[] };
};

/**
 * Observes only an isolated worker and its live descendants.  The caller owns
 * the private diagnostics; no PID tree or command details are projected to a
 * Control API response, artifact manifest, or client surface.
 */
export function createSpatialReferenceV2RssWatch(params: {
  rootPid: number;
  signal: AbortSignal;
  abort: (reason: Error) => void;
  maxTreeRssBytes: number;
  pollMs?: number;
}): SpatialReferenceV2RssWatch {
  if (!supportsSpatialReferenceV2ResourceLimits()) {
    throw new Error("spatial_v2_supervision_unsupported");
  }
  let stopped = false;
  let sampling: Promise<void> = Promise.resolve();
  let peakBytes = 0;
  const samples: SpatialReferenceV2RssSample[] = [];
  const sample = (phase: SpatialReferenceV2RssSamplePhase): Promise<void> => {
    const next = sampling.then(async () => {
      if (stopped || params.signal.aborted) return;
      const rssBytes = await readSpatialReferenceV2TreeRssBytes(params.rootPid);
      if (rssBytes === undefined) {
        const error = new Error("spatial_v2_rss_observation_unavailable");
        params.abort(error);
        throw error;
      }
      const observation = { phase, rssBytes, observedAtMs: Date.now() };
      samples.push(observation);
      peakBytes = Math.max(peakBytes, rssBytes);
      if (rssBytes > params.maxTreeRssBytes) {
        const error = new Error("spatial_v2_rss_limit_exceeded");
        params.abort(error);
        throw error;
      }
    });
    // A failed periodic sample must not poison a later mandatory boundary;
    // that boundary still re-observes and sees the controller's abort fence.
    sampling = next.catch(() => undefined);
    return next;
  };
  const timer = setInterval(
    () => void sample("periodic").catch(() => undefined),
    params.pollMs ?? RSS_POLL_MS,
  );
  timer.unref?.();
  void sample("periodic").catch(() => undefined);
  return {
    sampleBoundary: async (phase) => await sample(phase),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    diagnostics: () => ({ peakBytes, samples: [...samples] }),
  };
}

/** Backwards-compatible interval-only seam for focused observer tests. */
export function startSpatialReferenceV2RssWatch(params: {
  rootPid: number;
  signal: AbortSignal;
  abort: (reason: Error) => void;
  maxTreeRssBytes?: number;
}): () => void {
  return createSpatialReferenceV2RssWatch({
    ...params,
    maxTreeRssBytes: params.maxTreeRssBytes ?? 1024 * 1024 * 1024,
  }).stop;
}
