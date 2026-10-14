import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnCommand } from "../../process/exec.js";
import {
  createSpatialReferenceV2RssWatch,
  readSpatialReferenceV2TreeRssBytes,
  SPATIAL_DARWIN_RSS_PROTOCOL,
  parseSpatialReferenceV2NativeRssDiagnostic,
  validateSpatialReferenceV2NativeRssDiagnostic,
  spatialReferenceV2NativeRssErrorDiagnostic,
  spatialReferenceV2ObserverExecErrorDiagnostic,
  validateSpatialReferenceV2ObserverExecDiagnostic,
} from "./v2-resource-watch.js";

vi.mock("../../process/exec.js", () => ({ spawnCommand: vi.fn() }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const observerPid = 1234;
const sample = {
  protocol: SPATIAL_DARWIN_RSS_PROTOCOL,
  rootPid: process.pid,
  observerPid,
  rssBytes: 102400,
  nodeCount: 2,
  verifiedSpanMs: 1,
};
const path = "/private/fixture/HostDaemon";
function child(promise: Promise<{ stdout: string }>) {
  return Object.assign(promise, {
    nodeChildProcess: { pid: observerPid },
  }) as unknown as ReturnType<typeof spawnCommand>;
}
const output = (value = sample) => ({ stdout: JSON.stringify(value) });
const watch = (abort = vi.fn()) =>
  createSpatialReferenceV2RssWatch({
    rootPid: process.pid,
    resourceObserverExecutablePath: path,
    signal: new AbortController().signal,
    abort,
    maxTreeRssBytes: 1_000_000,
  });
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("private observer exec failure evidence", () => {
  const detail = {
    source: "darwin_observer_exec/v1",
    code: "spatial_v2_rss_observation_exec_timeout",
    elapsedMs: 3005,
    closeObserved: false,
    exitCode: null,
    signal: null,
    stdoutBytes: 5,
    stderrBytes: 7,
    nativeStage: "unknown",
    renderStage: "frame_render",
    frameIndex: 42,
  };

  it.each([
    { ...detail, path: "/private/secret" },
    { ...detail, stderr: "secret" },
    { ...detail, elapsedMs: -1 },
    { ...detail, stdoutBytes: NaN },
    { ...detail, stderrBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...detail, frameIndex: 360 },
    { ...detail, nativeStage: "unrecognized" },
    { ...detail, renderStage: "secret" },
    { ...detail, signal: "SIGSECRET", closeObserved: true },
    { ...detail, signal: { toString: () => "SIGKILL" }, closeObserved: true },
    { ...detail, exitCode: 1 },
    { ...detail, exitCode: 1, signal: "SIGKILL", closeObserved: true },
    { ...detail, code: "/path/private error" },
    { ...detail, closeObserved: "false" },
  ])(
    "rejects unknown fields, raw strings, impossible terminal state and unbounded scalars",
    (value) => {
      expect(validateSpatialReferenceV2ObserverExecDiagnostic(value)).toBeUndefined();
    },
  );

  it.each([false, true])(
    "freezes only actual close and partial stream observations (close=%s)",
    async (closed) => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      let reject!: (error: unknown) => void;
      const nodeChild = Object.assign(new EventEmitter(), {
        pid: observerPid,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      const command = Object.assign(
        new Promise<{ stdout: string }>((_, no) => {
          reject = no;
        }),
        {
          nodeChildProcess: nodeChild,
        },
      ) as unknown as ReturnType<typeof spawnCommand>;
      vi.mocked(spawnCommand)
        .mockReturnValueOnce(child(Promise.resolve(output())))
        .mockReturnValue(command);
      const now = vi.spyOn(performance, "now").mockReturnValue(10);
      let context = { renderStage: "frame_render", frameIndex: 42 as number | null };
      const abort = vi.fn();
      const watcher = createSpatialReferenceV2RssWatch({
        rootPid: process.pid,
        signal: new AbortController().signal,
        abort,
        maxTreeRssBytes: 1_000_000,
        resourceObserverExecutablePath: path,
        observationContext: () => context,
      });
      try {
        const rejected = watcher.sampleBoundary("post_first_webgl_frame").catch((error) => error);
        await vi.waitFor(() => expect(nodeChild.listenerCount("close")).toBe(1));
        context = { renderStage: "motion_encode", frameIndex: null };
        nodeChild.stdout.emit("data", Buffer.from("密钥"));
        nodeChild.stderr.emit("data", "private path/token");
        if (closed) nodeChild.emit("close", null, "SIGKILL");
        now.mockReturnValue(3015);
        reject({
          timedOut: true,
          exitCode: 777,
          signal: "secret",
          stdout: "raw-secret",
          stderr: "private path/token",
        });
        const error = await rejected;
        const snapshot = spatialReferenceV2ObserverExecErrorDiagnostic(error);
        expect(error.message).toBe("spatial_v2_rss_observation_exec_timeout");
        expect(snapshot).toEqual({
          ...detail,
          closeObserved: closed,
          signal: closed ? "SIGKILL" : null,
          stdoutBytes: 6,
          stderrBytes: 18,
          spawnReturnMs: 0,
          spawnObserved: false,
          spawnObservedMs: null,
          exitObserved: false,
          exitObservedMs: null,
          exitEventCode: null,
          exitEventSignal: null,
        });
        expect(abort).toHaveBeenCalledWith(error);
        expect(spatialReferenceV2NativeRssErrorDiagnostic(error)).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toMatch(/密钥|private|token|secret|777/);
        expect(nodeChild.listenerCount("close")).toBe(0);
        expect(nodeChild.listenerCount("spawn")).toBe(0);
        expect(nodeChild.listenerCount("exit")).toBe(0);
        expect(nodeChild.stdout.listenerCount("data")).toBe(0);
        expect(nodeChild.stderr.listenerCount("data")).toBe(0);
        nodeChild.emit("close", 0, null);
        nodeChild.stdout.emit("data", "late");
        expect(spatialReferenceV2ObserverExecErrorDiagnostic(error)).toEqual(snapshot);
        expect(spawnCommand).toHaveBeenCalledTimes(2);
        expect(spawnCommand).toHaveBeenLastCalledWith(
          [path, "--observe-spatial-tree-rss", String(process.pid)],
          expect.objectContaining({
            timeout: 3000,
            forceKillAfterDelay: 100,
            maxBuffer: 4194304,
            reject: true,
          }),
        );
      } finally {
        watcher.stop();
      }
    },
  );

  it("keeps legacy evidence and strictly validates the complete lifecycle extension", () => {
    expect(validateSpatialReferenceV2ObserverExecDiagnostic(detail)).toEqual(detail);
    const extended = {
      ...detail,
      spawnReturnMs: 730,
      spawnObserved: true,
      spawnObservedMs: 731,
      exitObserved: true,
      exitObservedMs: 3000,
      exitEventCode: null,
      exitEventSignal: "SIGTERM",
    };
    expect(validateSpatialReferenceV2ObserverExecDiagnostic(extended)).toEqual(extended);
    for (const bad of [
      { ...detail, spawnReturnMs: 730 },
      { ...extended, spawnReturnMs: -1 },
      { ...extended, spawnObservedMs: 729 },
      { ...extended, spawnObservedMs: 3006 },
      { ...extended, spawnObserved: false },
      { ...extended, exitObserved: false },
      { ...extended, exitObservedMs: null },
      { ...extended, exitObservedMs: 729 },
      { ...extended, exitEventCode: 0 },
      { ...extended, exitEventSignal: "secret" },
      { ...extended, argv: "secret" },
      { ...extended, exitObserved: "true" },
    ])
      expect(validateSpatialReferenceV2ObserverExecDiagnostic(bad)).toBeUndefined();
    const absentExit = {
      ...extended,
      exitObserved: false,
      exitObservedMs: null,
      exitEventCode: null,
      exitEventSignal: null,
    };
    expect(validateSpatialReferenceV2ObserverExecDiagnostic(absentExit)).toEqual(absentExit);
  });

  it("freezes pre-return latency and actual exit before close without changing timeout refusal", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const nodeChild = Object.assign(new EventEmitter(), {
      pid: observerPid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    let reject!: (error: unknown) => void;
    const command = Object.assign(
      new Promise<{ stdout: string }>((_, no) => {
        reject = no;
      }),
      {
        nodeChildProcess: nodeChild,
      },
    ) as unknown as ReturnType<typeof spawnCommand>;
    const now = vi.spyOn(performance, "now").mockReturnValue(10);
    vi.mocked(spawnCommand)
      .mockReturnValueOnce(child(Promise.resolve(output())))
      .mockImplementation(() => {
        now.mockReturnValue(740);
        return command;
      });
    const abort = vi.fn();
    const watcher = watch(abort);
    try {
      const result = watcher.sampleBoundary("post_first_webgl_frame").catch((error) => error);
      await vi.waitFor(() => expect(nodeChild.listenerCount("exit")).toBe(1));
      now.mockReturnValue(741);
      nodeChild.emit("spawn");
      now.mockReturnValue(770);
      nodeChild.emit("exit", 0, null);
      now.mockReturnValue(3015);
      reject({ timedOut: true, exitCode: 999, stderr: "secret" });
      const error = await result;
      const snapshot = spatialReferenceV2ObserverExecErrorDiagnostic(error);
      expect(error.message).toBe("spatial_v2_rss_observation_exec_timeout");
      expect(snapshot).toMatchObject({
        elapsedMs: 3005,
        closeObserved: false,
        exitCode: null,
        signal: null,
        spawnReturnMs: 730,
        spawnObserved: true,
        spawnObservedMs: 731,
        exitObserved: true,
        exitObservedMs: 760,
        exitEventCode: 0,
        exitEventSignal: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        nativeStage: "unknown",
      });
      expect(abort).toHaveBeenCalledWith(error);
      expect(JSON.stringify(snapshot)).not.toMatch(/secret|999|argv|path/);
      for (const event of ["spawn", "exit", "close"])
        expect(nodeChild.listenerCount(event)).toBe(0);
      nodeChild.emit("spawn");
      nodeChild.emit("exit", null, "SIGKILL");
      nodeChild.emit("close", null, "SIGKILL");
      expect(spatialReferenceV2ObserverExecErrorDiagnostic(error)).toEqual(snapshot);
      expect(spawnCommand).toHaveBeenLastCalledWith(
        [path, "--observe-spatial-tree-rss", String(process.pid)],
        expect.objectContaining({
          timeout: 3000,
          forceKillAfterDelay: 100,
          maxBuffer: 4194304,
          reject: true,
        }),
      );
    } finally {
      watcher.stop();
    }
  });

  it("keeps typed native evidence separate and unknown exec output unavailable", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const stderr =
      "Error: spatial_v2_rss_observation_node_missing pid=123 stage=task_rss errno=3 read_bytes=0 lifecycle_proven=true\n";
    vi.mocked(spawnCommand).mockReturnValue(child(Promise.reject({ stderr })));
    const watcher = watch();
    const error = await watcher.sampleBoundary("before_ffmpeg").catch((value) => value);
    expect(error.message).toBe("spatial_v2_rss_observation_node_missing");
    expect(spatialReferenceV2ObserverExecErrorDiagnostic(error)).toMatchObject({
      nativeStage: "task_rss",
      renderStage: "unknown",
      frameIndex: null,
      closeObserved: false,
      exitCode: null,
      signal: null,
      stdoutBytes: null,
      stderrBytes: null,
    });
    expect(spatialReferenceV2NativeRssErrorDiagnostic(error)?.errno).toBe(3);
    watcher.stop();
  });

  it("records no fabricated close/bytes for a synchronous spawn refusal", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(spawnCommand).mockImplementation(() => {
      throw new Error("raw-private-spawn-error");
    });
    const watcher = watch();
    const error = await watcher.sampleBoundary("post_browser_launch").catch((value) => value);
    expect(error.message).toBe("spatial_v2_rss_observation_exec_failed");
    expect(spatialReferenceV2ObserverExecErrorDiagnostic(error)).toMatchObject({
      closeObserved: false,
      exitCode: null,
      signal: null,
      stdoutBytes: null,
      stderrBytes: null,
      nativeStage: "unknown",
      renderStage: "unknown",
      frameIndex: null,
    });
    watcher.stop();
  });
});

describe("Darwin armed tree RSS observer fail-closed diagnostics", () => {
  it("coalesces periodic ticks behind a slow sample and retains a new awaited boundary", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.useFakeTimers();
    let release!: (value: { stdout: string }) => void;
    vi.mocked(spawnCommand)
      .mockReturnValueOnce(
        child(
          new Promise((resolve) => {
            release = resolve;
          }),
        ),
      )
      .mockImplementation(() => child(Promise.resolve(output())));
    const watcher = watch();
    try {
      await vi.advanceTimersByTimeAsync(500);
      let resolved = false;
      const boundary = watcher.sampleBoundary("post_host_load").then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false);
      expect(spawnCommand).toHaveBeenCalledTimes(1);
      release(output());
      await boundary;
      expect(spawnCommand).toHaveBeenCalledTimes(2);
      expect(watcher.diagnostics().samples.map((s) => s.phase)).toEqual([
        "periodic",
        "post_host_load",
      ]);
      expect(spawnCommand).toHaveBeenCalledWith(
        [path, "--observe-spatial-tree-rss", String(process.pid)],
        expect.objectContaining({ timeout: 3000, maxBuffer: 4 * 1024 * 1024 }),
      );
    } finally {
      watcher.stop();
    }
  });

  it.each([
    ["exec_timeout", { timedOut: true }],
    ["exec_failed", new Error("private OS failure")],
    ["lifecycle_changed", { stderr: "Error: spatial_v2_rss_observation_lifecycle_changed" }],
    ["event_unavailable", { stderr: "Error: spatial_v2_rss_observation_event_unavailable" }],
  ])("retains bounded %s and aborts before boundary work continues", async (reason, error) => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(spawnCommand).mockImplementation(() => child(Promise.reject(error)));
    const abort = vi.fn();
    const watcher = watch(abort);
    try {
      await expect(watcher.sampleBoundary("post_browser_launch")).rejects.toThrow(
        `spatial_v2_rss_observation_${reason}`,
      );
      expect(abort).toHaveBeenCalledWith(
        expect.objectContaining({ message: `spatial_v2_rss_observation_${reason}` }),
      );
      await expect(readSpatialReferenceV2TreeRssBytes(process.pid, path)).resolves.toBeUndefined();
    } finally {
      watcher.stop();
    }
  });

  it.each([
    "42 1 100",
    "null",
    "[]",
    JSON.stringify({ ...sample, protocol: "darwin_ps_tree_rss_sum_v1" }),
    JSON.stringify({ ...sample, observerPid: observerPid + 1 }),
    JSON.stringify({ ...sample, rootPid: 42 }),
    JSON.stringify({ ...sample, rssBytes: 0 }),
    JSON.stringify({ ...sample, nodeCount: 1 }),
    JSON.stringify({ ...sample, nodeCount: 174763 }),
    JSON.stringify({ ...sample, verifiedSpanMs: 3000 }),
    JSON.stringify({ ...sample, extra: true }),
  ])("rejects stale/malformed or incomplete private schema: %s", async (stdout) => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(spawnCommand).mockImplementation(() => child(Promise.resolve({ stdout })));
    await expect(readSpatialReferenceV2TreeRssBytes(process.pid, path)).resolves.toBeUndefined();
  });

  it("rejects absent/private-relative locator and foreign root before spawning", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    await expect(readSpatialReferenceV2TreeRssBytes(process.pid)).resolves.toBeUndefined();
    await expect(
      readSpatialReferenceV2TreeRssBytes(process.pid, "relative"),
    ).resolves.toBeUndefined();
    await expect(
      readSpatialReferenceV2TreeRssBytes(process.pid + 1, path),
    ).resolves.toBeUndefined();
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("aborts when a fresh native sum exceeds the same resource limit", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(spawnCommand).mockImplementation(() =>
      child(Promise.resolve(output({ ...sample, rssBytes: 1_000_001 }))),
    );
    const watcher = watch();
    try {
      await expect(watcher.sampleBoundary("post_browser_launch")).rejects.toThrow(
        "spatial_v2_rss_limit_exceeded",
      );
    } finally {
      watcher.stop();
    }
  });
});

describe("private native RSS diagnostic boundary", () => {
  const stderr =
    "Error: spatial_v2_rss_observation_node_missing pid=123 stage=task_rss errno=3 read_bytes=0 lifecycle_proven=true\n";
  const diagnostic = {
    source: "darwin_native_rss/v1",
    pid: 123,
    stage: "task_rss",
    errno: 3,
    readBytes: 0,
    lifecycleProven: true,
    renderStage: "observer",
  };
  it("retains only bounded scalar diagnostics and preserves the primary failure code", () => {
    expect(parseSpatialReferenceV2NativeRssDiagnostic(stderr)).toEqual(diagnostic);
    const error = new Error("spatial_v2_rss_observation_node_missing", { cause: diagnostic });
    expect(spatialReferenceV2NativeRssErrorDiagnostic(error, "motion_encode")).toEqual({
      ...diagnostic,
      renderStage: "motion_encode",
    });
    expect(error.message).toBe("spatial_v2_rss_observation_node_missing");
  });
  it.each([
    { ...diagnostic, argv: ["secret"] },
    { ...diagnostic, path: "/private" },
    { ...diagnostic, payload: {} },
    { ...diagnostic, key: "secret" },
    { ...diagnostic, pid: -1 },
    { ...diagnostic, pid: 2147483648 },
    { ...diagnostic, errno: -1 },
    { ...diagnostic, readBytes: 4194305 },
    { ...diagnostic, stage: "unknown" },
    { ...diagnostic, renderStage: "unknown" },
    { ...diagnostic, lifecycleProven: "true" },
  ])("rejects malformed or non-scalar private metadata", (value) => {
    expect(validateSpatialReferenceV2NativeRssDiagnostic(value)).toBeUndefined();
  });
  it("rejects trailing raw data and overlong stderr", () => {
    expect(parseSpatialReferenceV2NativeRssDiagnostic(stderr + "path=/secret")).toBeUndefined();
    expect(parseSpatialReferenceV2NativeRssDiagnostic("x".repeat(513))).toBeUndefined();
  });
});
