// Hermetic guardian fixture: exercises the production guardian handshake while
// never opening a browser or passing credentials across the private boundary.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const safetyExit = setTimeout(() => process.exit(91), 4_000);
safetyExit.unref?.();

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function report(message) {
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {
    // Parent loss is intentionally not a success receipt.
  }
}

function waitFor(predicate) {
  return new Promise((resolve) => {
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onDisconnect = () => {
      cleanup();
      resolve(undefined);
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

const isType = (type) => (message) => message?.type === type;

process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));

async function run() {
  const requestPath = argument("--request");
  const manifestPath = argument("--manifest");
  const generation = argument("--generation");
  report({ type: "openclaw-worker-ready-v1" });
  if (!(await waitFor(isType("openclaw-worker-start-v1")))) return;
  report({ type: "openclaw-worker-started-v1" });
  report({ type: "spatial-guardian-spawn-intent-v1", generation, sequence: 0 });
  if (
    !(await waitFor(
      (message) =>
        message?.type === "spatial-guardian-spawn-intent-ack-v1" &&
        message.generation === generation &&
        message.sequence === 0,
    ))
  )
    return;
  const worker = { pid: process.pid, startTime: Date.now() };
  report({ type: "spatial-guardian-worker-prepared-v1", generation, sequence: 1, worker });
  if (
    !(await waitFor(
      (message) =>
        message?.type === "spatial-guardian-authorize-start-v1" &&
        message.generation === generation &&
        message.sequence === 1,
    ))
  )
    return;
  const request = requestPath ? JSON.parse(await readFile(requestPath, "utf8")) : undefined;
  report({
    type: "spatial-v2-test-audit",
    request,
    startMessage: { type: "openclaw-worker-start-v1" },
  });
  const failureCode = argument("--worker-failure-code");
  if (failureCode) {
    const diagnosticMode = argument("--native-diagnostic-mode");
    const nativeDiagnostic =
      diagnosticMode && !diagnosticMode.startsWith("rss")
        ? {
            source: "darwin_native_rss/v1",
            pid: 123,
            errno: 3,
            readBytes: 0,
            stage: "task_rss",
            lifecycleProven: true,
            renderStage: "motion_encode",
            ...(diagnosticMode === "invalid" ? { argv: ["must-not-forward"] } : {}),
          }
        : undefined;
    const failureDetails = diagnosticMode?.startsWith("rss")
      ? {
          source: "spatial_rss_limit/v1",
          metric: "darwin_libproc_tree_rss_span_v1",
          rootPid: diagnosticMode === "rss-identity" ? process.pid + 1 : process.pid,
          observerPid: process.pid + 2,
          nodeCount: 3,
          verifiedSpanMs: 1,
          capBytes: 2147483648,
          observedBytes: 2147483649,
          peakBytes: 2147483649,
          observedAtMs: 5,
          phase: "periodic",
          renderStage: "frame_render",
          frameIndex: 42,
          ...(diagnosticMode === "rss-invalid" ? { argv: ["must-not-forward"] } : {}),
        }
      : undefined;
    report({
      type: failureCode.startsWith("spatial_guardian_")
        ? "spatial-guardian-failed-v1"
        : "spatial-v2-failed",
      generation,
      code: failureCode,
      nativeDiagnostic,
      failureDetails,
    });
    if (diagnosticMode === "rss-late")
      report({
        type: "spatial-v2-failed",
        generation,
        code: failureCode,
        failureDetails: { ...failureDetails, observedAtMs: 6 },
      });
  }
  if (request && manifestPath && !failureCode) {
    const outputs = [];
    for (const output of request.outputs) {
      const extension = output.slot === "motion_reference_video" ? "mp4" : "png";
      const file = `fixture-${output.slot}-${output.ordinal}.${extension}`;
      await writeFile(
        path.join(request.workDir, file),
        Buffer.from(`${output.slot}:${output.ordinal}`),
        { flag: "wx" },
      );
      outputs.push({ slot: output.slot, ordinal: output.ordinal, file });
    }
    await writeFile(manifestPath, JSON.stringify({ outputs }), { flag: "wx" });
  }
  if (request?.collectToolchainProof) {
    report({
      type: "spatial-v2-toolchain-proof-v1",
      generation,
      toolchain: {
        chromiumVersion: "fixture-chromium",
        ffmpegVersion: "fixture-ffmpeg",
        ffprobeVersion: "fixture-ffprobe",
        ffmpegSha256: "a".repeat(64),
        ffprobeSha256: "b".repeat(64),
        ffmpegBuildConfiguration: "fixture-ffmpeg-build",
        ffprobeBuildConfiguration: "fixture-ffprobe-build",
      },
    });
  }
  report({
    type: "spatial-guardian-scope-observation-v1",
    generation,
    sequence: 2,
    worker,
    state: "extinct",
    proof:
      process.platform === "win32"
        ? {
            protocol: "windows_job_v1",
            jobIncarnationId: `fixture-job-${generation}`,
            activeProcessCount: 0,
            workerPid: worker.pid,
            workerStartTime: worker.startTime,
          }
        : {
            protocol: "posix_group_observation_v1",
            processGroupId: worker.pid,
            rootState: "dead",
          },
  });
  process.disconnect?.();
}

void run().catch((error) => {
  report({
    type: "spatial-guardian-failed-v1",
    code: error instanceof Error ? error.message : "fixture_failed",
  });
  process.exitCode = 1;
});
