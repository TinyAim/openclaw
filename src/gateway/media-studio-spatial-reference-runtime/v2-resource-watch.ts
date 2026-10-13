import fs from "node:fs/promises";
import path from "node:path";
import { spawnCommand } from "../../process/exec.js";

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

export const SPATIAL_DARWIN_RSS_PROTOCOL = "darwin_spatial_tree_rss_span/v1";

const nativeStages = [
  "observation",
  "bsd_identity",
  "child_census",
  "parent_identity",
  "census_incarnation",
  "child_parent",
  "event_arm",
  "event_read",
  "event_flags",
  "root_event",
  "span_event",
  "node_exit_proven",
  "task_rss",
  "rss_identity",
  "stable_census",
  "root_pin",
];
const renderStages = [
  "observer",
  "worker",
  "request_accounting",
  "browser_launch",
  "toolchain_probe",
  "page_create",
  "reference_host_load",
  "frame_render",
  "motion_encode",
  "motion_verify",
  "render_host_dispose",
  "manifest_write",
];
export type SpatialReferenceV2NativeRssDiagnostic = {
  source: "darwin_native_rss/v1";
  pid: number;
  errno: number;
  readBytes: number;
  stage: string;
  lifecycleProven: boolean;
  renderStage: string;
};

/** Credential-free private IPC diagnostics only; reject rather than strip extra fields. */
export function validateSpatialReferenceV2NativeRssDiagnostic(
  value: unknown,
): SpatialReferenceV2NativeRssDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).toSorted().join(",") !==
      "errno,lifecycleProven,pid,readBytes,renderStage,source,stage" ||
    row.source !== "darwin_native_rss/v1" ||
    !Number.isSafeInteger(row.pid) ||
    Number(row.pid) < 0 ||
    Number(row.pid) > 2147483647 ||
    !Number.isSafeInteger(row.errno) ||
    Number(row.errno) < 0 ||
    Number(row.errno) > 2147483647 ||
    !Number.isSafeInteger(row.readBytes) ||
    Number(row.readBytes) < -1 ||
    Number(row.readBytes) > 4194304 ||
    typeof row.lifecycleProven !== "boolean" ||
    typeof row.stage !== "string" ||
    !nativeStages.includes(row.stage) ||
    typeof row.renderStage !== "string" ||
    !renderStages.includes(row.renderStage)
  )
    return undefined;
  return {
    source: "darwin_native_rss/v1",
    pid: Number(row.pid),
    errno: Number(row.errno),
    readBytes: Number(row.readBytes),
    stage: String(row.stage),
    lifecycleProven: row.lifecycleProven,
    renderStage: String(row.renderStage),
  };
}

export function parseSpatialReferenceV2NativeRssDiagnostic(
  stderr: unknown,
): SpatialReferenceV2NativeRssDiagnostic | undefined {
  if (typeof stderr !== "string" || stderr.length > 512) return undefined;
  const match =
    /^Error: spatial_v2_rss_observation_[a-z_]{1,64} pid=(\d{1,10}) stage=([a-z_]{1,32}) errno=(\d{1,10}) read_bytes=(-?\d{1,10}) lifecycle_proven=(true|false)\s*$/u.exec(
      stderr,
    );
  if (!match) return undefined;
  return validateSpatialReferenceV2NativeRssDiagnostic({
    source: "darwin_native_rss/v1",
    pid: Number(match[1]),
    stage: match[2],
    errno: Number(match[3]),
    readBytes: Number(match[4]),
    lifecycleProven: match[5] === "true",
    renderStage: "observer",
  });
}

export function spatialReferenceV2NativeRssErrorDiagnostic(
  error: unknown,
  renderStage?: string,
): SpatialReferenceV2NativeRssDiagnostic | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = validateSpatialReferenceV2NativeRssDiagnostic(error.cause);
  return value
    ? validateSpatialReferenceV2NativeRssDiagnostic({
        ...value,
        renderStage: renderStage ?? value.renderStage,
      })
    : undefined;
}

async function darwinDescendantRssBytes(rootPid: number, executablePath?: string): Promise<number> {
  if (!executablePath || !path.isAbsolute(executablePath) || rootPid !== process.pid) {
    throw new Error("spatial_v2_rss_observation_parent_binding");
  }
  let stdout: string;
  let observerPid: number | undefined;
  try {
    const child = spawnCommand([executablePath, "--observe-spatial-tree-rss", String(rootPid)], {
      encoding: "utf8",
      stdin: "ignore",
      reject: true,
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
      forceKillAfterDelay: 100,
    });
    observerPid = child.nodeChildProcess.pid;
    ({ stdout } = await child);
  } catch (error) {
    const value =
      error && typeof error === "object" ? (error as { timedOut?: boolean; stderr?: unknown }) : {};
    const boundedReason =
      typeof value.stderr === "string"
        ? /spatial_v2_rss_observation_[a-z_]+/u.exec(value.stderr.slice(0, 512))?.[0]
        : undefined;
    throw new Error(
      value.timedOut
        ? "spatial_v2_rss_observation_exec_timeout"
        : (boundedReason ?? "spatial_v2_rss_observation_exec_failed"),
      { cause: parseSpatialReferenceV2NativeRssDiagnostic(value.stderr) },
    );
  }
  let sample: Record<string, unknown>;
  try {
    sample = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("spatial_v2_rss_observation_snapshot_invalid");
  }
  if (
    !sample ||
    typeof sample !== "object" ||
    Array.isArray(sample) ||
    Object.keys(sample).toSorted().join(",") !==
      "nodeCount,observerPid,protocol,rootPid,rssBytes,verifiedSpanMs" ||
    sample.protocol !== SPATIAL_DARWIN_RSS_PROTOCOL ||
    sample.rootPid !== rootPid ||
    !Number.isSafeInteger(observerPid) ||
    sample.observerPid !== observerPid ||
    !Number.isSafeInteger(sample.rssBytes) ||
    Number(sample.rssBytes) <= 0 ||
    !Number.isSafeInteger(sample.nodeCount) ||
    Number(sample.nodeCount) < 2 ||
    Number(sample.nodeCount) > Math.floor((4 * 1024 * 1024) / 24) ||
    !Number.isSafeInteger(sample.verifiedSpanMs) ||
    Number(sample.verifiedSpanMs) < 0 ||
    Number(sample.verifiedSpanMs) >= 3_000
  ) {
    throw new Error("spatial_v2_rss_observation_snapshot_invalid");
  }
  return Number(sample.rssBytes);
}

/** Verified tree observers: Linux procfs and Darwin armed, stable libproc measurement span. */
export function supportsSpatialReferenceV2ResourceLimits(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

/** Fresh sum over identity-verified nodes; unknown observation stays unavailable. */
export async function readSpatialReferenceV2TreeRssBytes(
  rootPid: number,
  resourceObserverExecutablePath?: string,
): Promise<number | undefined> {
  if (process.platform === "linux") {
    return await linuxDescendantRssBytes(rootPid);
  }
  if (process.platform === "darwin") {
    try {
      return await darwinDescendantRssBytes(rootPid, resourceObserverExecutablePath);
    } catch {
      return undefined;
    }
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
  /** Maximum observed sample sum, not a continuous peak between measurement spans. */
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
  resourceObserverExecutablePath?: string;
}): SpatialReferenceV2RssWatch {
  if (!supportsSpatialReferenceV2ResourceLimits()) {
    throw new Error("spatial_v2_supervision_unsupported");
  }
  let stopped = false;
  let sampling: Promise<void> = Promise.resolve();
  let pendingSamples = 0;
  let peakBytes = 0;
  const samples: SpatialReferenceV2RssSample[] = [];
  const sample = (phase: SpatialReferenceV2RssSamplePhase): Promise<void> => {
    // Expired interval ticks are not fresh observations. Bound the interval
    // queue while retaining every mandatory boundary as a new awaited read.
    if (phase === "periodic" && pendingSamples > 0) return Promise.resolve();
    pendingSamples += 1;
    const next = sampling
      .then(async () => {
        if (stopped || params.signal.aborted) return;
        let rssBytes: number | undefined;
        try {
          rssBytes =
            process.platform === "darwin"
              ? await darwinDescendantRssBytes(
                  params.rootPid,
                  params.resourceObserverExecutablePath,
                )
              : await readSpatialReferenceV2TreeRssBytes(params.rootPid);
        } catch (error) {
          params.abort(
            error instanceof Error ? error : new Error("spatial_v2_rss_observation_unavailable"),
          );
          throw error;
        }
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
      })
      .finally(() => {
        pendingSamples -= 1;
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
  resourceObserverExecutablePath?: string;
}): () => void {
  return createSpatialReferenceV2RssWatch({
    ...params,
    maxTreeRssBytes: params.maxTreeRssBytes ?? 1024 * 1024 * 1024,
  }).stop;
}
