import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnCommand } from "../../process/exec.js";
import {
  createSpatialReferenceV2RssWatch,
  readSpatialReferenceV2TreeRssBytes,
  SPATIAL_DARWIN_RSS_PROTOCOL,
  parseSpatialReferenceV2NativeRssDiagnostic,
  validateSpatialReferenceV2NativeRssDiagnostic,
  spatialReferenceV2NativeRssErrorDiagnostic,
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
  vi.useRealTimers();
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
