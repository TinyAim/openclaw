/**
 * Private v2 render worker. Its parent owns upload credentials; this process only
 * consumes a frozen local request, renders offline Babylon frames, and leaves a
 * bounded local result manifest for the supervised parent to read.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Route } from "playwright-core";
import { resolveSystemBin } from "../../infra/resolve-system-bin.js";
import { runFfmpeg, runFfprobe, resolveFfmpegBin } from "../../media/ffmpeg-exec.js";
import { signalProcessTree } from "../../process/kill-tree.js";
import { mergeSpatialFrozenNodes } from "./frozen-scene.js";
import type { SpatialReferenceV2ResourceProfile } from "./v2-build-manifest.js";
import {
  assertSpatialReferenceV2RenderInputLimits,
  assertSpatialReferenceV2MissingOutputs,
  SPATIAL_V2_ENCODE_TIMEOUT_MS,
  SPATIAL_V2_FPS,
  SPATIAL_V2_MAX_TEMP_BYTES,
  SPATIAL_V2_PROBE_TIMEOUT_MS,
  SPATIAL_V2_TOTAL_TIMEOUT_MS,
  type SpatialReferenceV2MissingOutput,
  type SpatialReferenceV2OutputSlot,
  type SpatialReferenceV2RenderInput,
} from "./v2-renderer.contract.js";
import { createSpatialReferenceV2RssWatch } from "./v2-resource-watch.js";

type BrowserRenderHost = {
  render(snapshot: unknown): Promise<string> | string;
};

type WorkerRequest = {
  input: SpatialReferenceV2RenderInput;
  outputs: SpatialReferenceV2MissingOutput[];
  chromiumExecutablePath: string;
  referenceRenderHtmlPath: string;
  workDir: string;
  resourceProfile: SpatialReferenceV2ResourceProfile;
  collectToolchainProof?: true;
};

type WorkerManifestOutput = {
  slot: SpatialReferenceV2OutputSlot;
  ordinal: number;
  file: string;
  sourceTimeMs?: number;
};

type WorkerManifest = { outputs: WorkerManifestOutput[] };

async function workDirBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await workDirBytes(item);
      continue;
    }
    if (entry.isFile()) {
      total += (await stat(item)).size;
    }
  }
  return total;
}

function startTempWatch(params: {
  workDir: string;
  signal: AbortSignal;
  abort: (reason: Error) => void;
}): () => void {
  let stopped = false;
  let sampling = false;
  const sample = async () => {
    if (stopped || sampling || params.signal.aborted) {
      return;
    }
    sampling = true;
    try {
      if ((await workDirBytes(params.workDir)) > SPATIAL_V2_MAX_TEMP_BYTES) {
        params.abort(new Error("spatial_v2_temp_limit_exceeded"));
      }
    } catch {
      params.abort(new Error("spatial_v2_temp_observation_unavailable"));
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => void sample(), 100);
  timer.unref?.();
  void sample();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function requireArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error("spatial_v2_worker_arguments_invalid");
  }
  return value;
}

function dataUrlBytes(value: unknown): Buffer {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) {
    throw new Error("spatial_v2_renderer_invalid_png_data_url");
  }
  const bytes = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
  if (bytes.length < 8 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("spatial_v2_renderer_invalid_png_bytes");
  }
  return bytes;
}

function snapshot(input: {
  width: number;
  height: number;
  backgroundPolicy: "environment_plate" | "neutral_studio" | "transparent";
  camera: {
    position: { x: number; y: number; z: number };
    worldAimTarget?: { x: number; y: number; z: number };
    targetPoint: { x: number; y: number; z: number };
    focalLengthMm: number;
    sensorWidthMm: number;
  };
  nodes: Array<unknown>;
}): Record<string, unknown> {
  if (input.backgroundPolicy === "environment_plate") {
    throw new Error("spatial_v2_environment_plate_unsupported");
  }
  return input;
}

async function renderPng(
  page: { evaluate: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T> },
  value: Record<string, unknown>,
): Promise<Buffer> {
  return dataUrlBytes(
    await page.evaluate(async (next) => {
      const renderer = (
        globalThis as typeof globalThis & {
          WisclawSpatialReferenceRender?: BrowserRenderHost;
        }
      ).WisclawSpatialReferenceRender;
      if (!renderer) {
        throw new Error("spatial_reference_render_host_missing");
      }
      return renderer.render(next as never);
    }, value),
  );
}

function outputKey(output: SpatialReferenceV2MissingOutput): string {
  return `${output.slot}:${output.ordinal}`;
}

function sourceTimeForReference(
  input: SpatialReferenceV2RenderInput,
  output: SpatialReferenceV2MissingOutput,
): number | undefined {
  return input.motionReference.referenceFrames?.find(
    (frame) => frame.slot === output.slot && frame.ordinal === output.ordinal,
  )?.sourceTimeMs;
}

async function verifyMotion(params: {
  outputPath: string;
  input: SpatialReferenceV2RenderInput;
  signal: AbortSignal;
}): Promise<void> {
  const probe = await runFfprobe(
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,avg_frame_rate,nb_frames,width,height,duration",
      "-of",
      "default=noprint_wrappers=1",
      params.outputPath,
    ],
    { timeoutMs: SPATIAL_V2_PROBE_TIMEOUT_MS, signal: params.signal },
  );
  const metadata = Object.fromEntries(
    probe
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("=")),
  );
  const { input } = params;
  if (
    metadata.codec_name !== "h264" ||
    metadata.avg_frame_rate !== "12/1" ||
    Number(metadata.nb_frames) !== input.motionReference.frames.length ||
    Number(metadata.width) !== input.renderIntent.width ||
    Number(metadata.height) !== input.renderIntent.height ||
    Math.abs(
      Number(metadata.duration) * 1000 -
        (input.motionReference.frames.length * 1000) / SPATIAL_V2_FPS,
    ) > 1 ||
    !Number.isFinite(Number(metadata.duration))
  ) {
    throw new Error("spatial_v2_encoded_probe_mismatch");
  }
  // Stream metadata cannot prove every encoded frame decodes.
  await runFfmpeg(["-v", "error", "-xerror", "-i", params.outputPath, "-f", "null", "-"], {
    timeoutMs: SPATIAL_V2_ENCODE_TIMEOUT_MS,
    signal: params.signal,
  });
}

async function writeBoundedFile(params: {
  file: string;
  bytes: Buffer;
  trackedBytes: { value: number };
}): Promise<void> {
  if (params.trackedBytes.value + params.bytes.length > SPATIAL_V2_MAX_TEMP_BYTES) {
    throw new Error("spatial_v2_temp_limit_exceeded");
  }
  await writeFile(params.file, params.bytes, { flag: "wx" });
  params.trackedBytes.value += params.bytes.length;
}

function report(message: unknown): void {
  if (!process.connected) {
    return;
  }
  try {
    process.send?.(message);
  } catch {
    // Parent disconnect is the fail-closed cleanup path.
  }
}

async function collectToolchainProof(params: {
  browser: BrowserContext;
  signal: AbortSignal;
}): Promise<{
  chromiumVersion: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  ffmpegSha256: string;
  ffprobeSha256: string;
  ffmpegBuildConfiguration: string;
  ffprobeBuildConfiguration: string;
}> {
  const chromiumVersion = params.browser.browser()?.version() ?? "";
  const [ffmpegVersion, ffprobeVersion, encoders] = await Promise.all([
    runFfmpeg(["-version"], { timeoutMs: SPATIAL_V2_PROBE_TIMEOUT_MS, signal: params.signal }),
    runFfprobe(["-version"], { timeoutMs: SPATIAL_V2_PROBE_TIMEOUT_MS, signal: params.signal }),
    runFfmpeg(["-hide_banner", "-encoders"], {
      timeoutMs: SPATIAL_V2_PROBE_TIMEOUT_MS,
      signal: params.signal,
    }),
  ]);
  if (
    !chromiumVersion ||
    !/ffmpeg version/i.test(ffmpegVersion) ||
    !/ffprobe version/i.test(ffprobeVersion)
  ) {
    throw new Error("spatial_v2_toolchain_probe_failed");
  }
  if (!/libx264/i.test(encoders)) {
    throw new Error("spatial_v2_libx264_encoder_missing");
  }
  const ffprobePath = resolveSystemBin("ffprobe", { trust: "standard" });
  if (!ffprobePath) {
    throw new Error("spatial_v2_ffprobe_path_missing");
  }
  return {
    chromiumVersion,
    ffmpegVersion: ffmpegVersion.split(/\r?\n/, 1)[0] ?? "",
    ffprobeVersion: ffprobeVersion.split(/\r?\n/, 1)[0] ?? "",
    ffmpegSha256: createHash("sha256")
      .update(await readFile(resolveFfmpegBin()))
      .digest("hex"),
    ffprobeSha256: createHash("sha256")
      .update(await readFile(ffprobePath))
      .digest("hex"),
    ffmpegBuildConfiguration: ffmpegVersion,
    ffprobeBuildConfiguration: ffprobeVersion,
  };
}

function workerFailureCode(error: unknown, stage: string): string {
  const candidate = error instanceof Error ? error.message : "";
  if (/^spatial_v2_[a-z0-9_]{1,120}$/u.test(candidate)) {
    return candidate;
  }
  return `spatial_v2_${stage}_failed`;
}

async function waitForStart(): Promise<void> {
  if (!process.connected || !process.channel) {
    throw new Error("spatial_v2_worker_ipc_missing");
  }
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        !Array.isArray(message) &&
        (message as { type?: unknown }).type === "openclaw-worker-start-v1"
      ) {
        cleanup();
        resolve();
        return;
      }
      cleanup();
      reject(new Error("spatial_v2_worker_start_invalid"));
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("spatial_v2_worker_parent_lost"));
    };
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    process.once("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

async function run(): Promise<void> {
  const requestPath = requireArgument("--request");
  const manifestPath = requireArgument("--manifest");
  // Register the private lifecycle gate before the first asynchronous request read.
  // The parent can open the gate immediately after spawn; registering afterwards
  // loses that one-shot IPC message and leaves a valid worker waiting forever.
  const startGate = waitForStart();
  report({ type: "openclaw-worker-ready-v1" });
  const request = JSON.parse(await readFile(requestPath, "utf8")) as WorkerRequest;
  assertSpatialReferenceV2RenderInputLimits(request.input);
  assertSpatialReferenceV2MissingOutputs(request.input, request.outputs);
  await startGate;
  report({ type: "openclaw-worker-started-v1" });

  const controller = new AbortController();
  let browser: BrowserContext | undefined;
  let closing: Promise<void> | undefined;
  const closeBrowser = () => {
    if (browser && !closing) {
      closing = browser.close();
      void closing.catch(() => undefined);
    }
  };
  const abort = (reason: Error) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
      closeBrowser();
    }
  };
  const deadline = setTimeout(
    () => abort(new Error("spatial_v2_total_timeout")),
    SPATIAL_V2_TOTAL_TIMEOUT_MS,
  );
  deadline.unref?.();
  const rssWatch = createSpatialReferenceV2RssWatch({
    rootPid: process.pid,
    signal: controller.signal,
    abort,
    maxTreeRssBytes: request.resourceProfile.maxTreeRssBytes,
    pollMs: request.resourceProfile.pollMs,
  });
  const stopTempWatch = startTempWatch({
    workDir: request.workDir,
    signal: controller.signal,
    abort,
  });
  const parentLost = () => {
    abort(new Error("spatial_v2_worker_parent_lost"));
    // Parent IPC is the lifetime anchor. If graceful tool shutdown stalls, only this
    // detached worker tree is targeted; no user browser or unrelated process is addressed.
    setTimeout(() => {
      signalProcessTree(process.pid, "SIGKILL", { detached: process.platform !== "win32" });
    }, 1_000).unref?.();
  };
  process.once("disconnect", parentLost);
  process.once("SIGTERM", () => abort(new Error("spatial_v2_worker_cancelled")));
  process.once("SIGINT", () => abort(new Error("spatial_v2_worker_cancelled")));

  const requested = new Set(request.outputs.map(outputKey));
  // Keep the request, final outputs, encoder frames, and persistent Chromium
  // profile under one work directory so this exact limit covers all local temp.
  const trackedBytes = { value: 0 };
  const manifest: WorkerManifest = { outputs: [] };
  let toolchainProof: Awaited<ReturnType<typeof collectToolchainProof>> | undefined;
  let completed = false;
  let failureStage = "request_accounting";
  const outputPng = async (params: { output: SpatialReferenceV2MissingOutput; png: Buffer }) => {
    const file = `${params.output.slot}-${params.output.ordinal}.png`;
    await writeBoundedFile({
      file: path.join(request.workDir, file),
      bytes: params.png,
      trackedBytes,
    });
    manifest.outputs.push({
      slot: params.output.slot as Exclude<SpatialReferenceV2OutputSlot, "motion_reference_video">,
      ordinal: params.output.ordinal,
      file,
      ...(sourceTimeForReference(request.input, params.output) === undefined
        ? {}
        : { sourceTimeMs: sourceTimeForReference(request.input, params.output) }),
    });
  };
  try {
    failureStage = "request_accounting";
    trackedBytes.value = (await stat(requestPath)).size;
    if (trackedBytes.value > SPATIAL_V2_MAX_TEMP_BYTES) {
      throw new Error("spatial_v2_temp_limit_exceeded");
    }
    report({ type: "spatial-v2-ready", pid: process.pid });
    failureStage = "browser_launch";
    browser = await chromium.launchPersistentContext(
      path.join(request.workDir, "chromium-profile"),
      {
        executablePath: request.chromiumExecutablePath,
        headless: true,
        viewport: {
          width: request.input.renderIntent.width,
          height: request.input.renderIntent.height,
        },
        args: ["--disable-background-networking", "--disable-extensions", "--no-first-run"],
      },
    );
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    if (request.collectToolchainProof) {
      failureStage = "toolchain_probe";
      toolchainProof = await collectToolchainProof({ browser, signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
    }
    await rssWatch.sampleBoundary("post_browser_launch");
    if (controller.signal.aborted) throw controller.signal.reason;
    failureStage = "page_create";
    const pages = browser.pages();
    if (pages.length !== request.resourceProfile.persistentContextPages || !pages[0]) {
      throw new Error("spatial_v2_persistent_context_pages_invalid");
    }
    const page = pages[0];
    const viewport = page.viewportSize();
    if (
      !viewport ||
      viewport.width !== request.input.renderIntent.width ||
      viewport.height !== request.input.renderIntent.height
    ) {
      throw new Error("spatial_v2_persistent_context_viewport_invalid");
    }
    await page.route(/^https?:/, (route: Route) => route.abort());
    failureStage = "reference_host_load";
    await page.goto(pathToFileURL(request.referenceRenderHtmlPath).href, {
      waitUntil: "load",
      timeout: SPATIAL_V2_PROBE_TIMEOUT_MS,
    });
    await rssWatch.sampleBoundary("post_host_load");
    if (controller.signal.aborted) throw controller.signal.reason;
    let firstWebglFrame = true;
    const renderStatic = async (
      camera: SpatialReferenceV2RenderInput["blueprint"]["camera"],
      nodes: unknown[],
    ) => {
      const rendered = await renderPng(
        page,
        snapshot({
          width: request.input.renderIntent.width,
          height: request.input.renderIntent.height,
          backgroundPolicy: request.input.renderIntent.backgroundPolicy,
          camera,
          nodes,
        }),
      );
      if (firstWebglFrame) {
        firstWebglFrame = false;
        await rssWatch.sampleBoundary("post_first_webgl_frame");
        if (controller.signal.aborted) throw controller.signal.reason;
      }
      return rendered;
    };
    failureStage = "frame_render";
    if (requested.has("composition_frame:0")) {
      await outputPng({
        output: { slot: "composition_frame", ordinal: 0 },
        png: await renderStatic(request.input.blueprint.camera, request.input.blueprint.nodes),
      });
    }
    for (const frame of request.input.motionReference.referenceFrames ?? []) {
      const output = {
        slot: frame.slot,
        ordinal: frame.ordinal,
      } as SpatialReferenceV2MissingOutput;
      if (!requested.has(outputKey(output))) {
        continue;
      }
      await outputPng({
        output,
        png: await renderStatic(
          frame.camera,
          mergeSpatialFrozenNodes(request.input.blueprint.nodes, frame.nodes),
        ),
      });
    }
    if (requested.has("motion_reference_video:0")) {
      let frameBytes = 0;
      const frameFiles: string[] = [];
      for (let index = 0; index < request.input.motionReference.frames.length; index += 1) {
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        const frame = request.input.motionReference.frames[index]!;
        const png = await renderStatic(
          frame.camera,
          mergeSpatialFrozenNodes(request.input.blueprint.nodes, frame.nodes),
        );
        if (trackedBytes.value + frameBytes + png.length > SPATIAL_V2_MAX_TEMP_BYTES) {
          throw new Error("spatial_v2_temp_limit_exceeded");
        }
        const file = path.join(request.workDir, `frame_${String(index).padStart(5, "0")}.png`);
        await writeFile(file, png, { flag: "wx" });
        frameFiles.push(file);
        frameBytes += png.length;
      }
      const motionPath = path.join(request.workDir, "motion-reference.mp4");
      const maxMotionBytes = SPATIAL_V2_MAX_TEMP_BYTES - trackedBytes.value - frameBytes;
      if (maxMotionBytes < 1) {
        throw new Error("spatial_v2_temp_limit_exceeded");
      }
      failureStage = "motion_encode";
      await rssWatch.sampleBoundary("before_ffmpeg");
      if (controller.signal.aborted) throw controller.signal.reason;
      await runFfmpeg(
        [
          "-y",
          "-framerate",
          String(SPATIAL_V2_FPS),
          "-i",
          path.join(request.workDir, "frame_%05d.png"),
          "-frames:v",
          String(request.input.motionReference.frames.length),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-fs",
          String(maxMotionBytes),
          motionPath,
        ],
        { timeoutMs: SPATIAL_V2_ENCODE_TIMEOUT_MS, signal: controller.signal },
      );
      await rssWatch.sampleBoundary("after_ffmpeg");
      if (controller.signal.aborted) throw controller.signal.reason;
      const motionSize = (await stat(motionPath)).size;
      if (trackedBytes.value + frameBytes + motionSize > SPATIAL_V2_MAX_TEMP_BYTES) {
        throw new Error("spatial_v2_temp_limit_exceeded");
      }
      failureStage = "motion_verify";
      await verifyMotion({
        outputPath: motionPath,
        input: request.input,
        signal: controller.signal,
      });
      await Promise.all(frameFiles.map(async (file) => await rm(file, { force: true })));
      trackedBytes.value += motionSize;
      manifest.outputs.push({
        slot: "motion_reference_video",
        ordinal: 0,
        file: path.basename(motionPath),
      });
    }
    failureStage = "manifest_write";
    await writeBoundedFile({
      file: manifestPath,
      bytes: Buffer.from(JSON.stringify(manifest)),
      trackedBytes,
    });
    completed = true;
  } catch (error) {
    // Preserve only a bounded stage code across the worker boundary. The outer
    // lifecycle reporter sends it after cleanup while IPC remains available.
    throw new Error(workerFailureCode(error, failureStage));
  } finally {
    clearTimeout(deadline);
    rssWatch.stop();
    stopTempWatch();
    process.off("disconnect", parentLost);
    closeBrowser();
    await closing;
    // A failure must retain IPC until the outer boundary sends its bounded code.
    // Successful workers disconnect here so the parent still owns normal teardown.
    if (completed && process.connected) {
      if (toolchainProof) {
        report({ type: "spatial-v2-toolchain-proof-v1", toolchain: toolchainProof });
      }
      process.disconnect?.();
    }
  }
}

void run().catch((error: unknown) => {
  report({
    type: "spatial-v2-failed",
    code: workerFailureCode(error, "worker"),
  });
  process.exitCode = 1;
});
