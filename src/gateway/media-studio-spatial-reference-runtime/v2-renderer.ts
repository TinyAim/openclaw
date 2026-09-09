/** Supervised isolated Chromium + Babylon renderer for relay v2. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { freemem, tmpdir } from "node:os";
import path from "node:path";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { ProcessSupervisor } from "../../process/supervisor/types.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import {
  buildSpatialReferenceV2Manifest,
  createSpatialReferenceV2ResourceProfile,
  spatialReferenceV2BuildDigest,
  type SpatialReferenceV2BuildManifestInput,
  type SpatialReferenceV2ResourceProfile,
} from "./v2-build-manifest.js";
import {
  assertSpatialReferenceV2InputLimits,
  assertSpatialReferenceV2MissingOutputs,
  createSpatialReferenceV2RenderInput,
  expectedSpatialReferenceV2Outputs,
  type SpatialReferenceV2Input,
  type SpatialReferenceV2MissingOutput,
  type SpatialReferenceV2PartialRenderResult,
  type SpatialReferenceV2RenderInput,
  type SpatialReferenceV2RenderLifecycle,
  type SpatialReferenceV2RenderResult,
  type SpatialReferenceV2GuardianIdentity,
  type SpatialReferenceV2ScopeObservation,
  type SpatialReferenceV2ToolchainProof,
  type SpatialReferenceV2WorkerIdentity,
} from "./v2-renderer.contract.js";
import { supportsSpatialReferenceV2ResourceLimits } from "./v2-resource-watch.js";

const STOP_CONFIRM_TIMEOUT_MS = 10_000;
/** Factory callers import this rather than substituting factory.ts as the build parent. */
export const SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL = import.meta.url;

export type {
  SpatialReferenceV2MissingOutput,
  SpatialReferenceV2PartialRenderResult,
  SpatialReferenceV2RenderLifecycle,
  SpatialReferenceV2RenderResult,
  SpatialReferenceV2GuardianIdentity,
  SpatialReferenceV2ScopeObservation,
  SpatialReferenceV2ToolchainProof,
  SpatialReferenceV2WorkerIdentity,
} from "./v2-renderer.contract.js";

export type SpatialReferenceV2Renderer = {
  /** Initial materialization: emits the complete, backwards-compatible Buffer package. */
  render(
    input: SpatialReferenceV2Input,
    signal: AbortSignal,
    lifecycle?: SpatialReferenceV2RenderLifecycle,
  ): Promise<SpatialReferenceV2RenderResult>;
  /** Crash recovery renders only the owner-derived MissingOutputPlan. */
  renderMissing?(
    input: SpatialReferenceV2Input,
    signal: AbortSignal,
    outputs: readonly SpatialReferenceV2MissingOutput[],
    lifecycle?: SpatialReferenceV2RenderLifecycle,
  ): Promise<SpatialReferenceV2PartialRenderResult>;
};

export type SpatialReferenceV2RendererConfig = {
  chromiumExecutablePath: string;
  referenceRenderHtmlPath: string;
  /** Required for a production relay; absent only in isolated worker-fixture tests. */
  buildIdentity?: {
    advertisedDigest: string;
    manifestInput: Omit<SpatialReferenceV2BuildManifestInput, "rendererModuleUrl">;
    readHostAvailableBytes?: () => number;
  };
  /** Test-only injection; production uses the process-wide supervisor. */
  supervisor?: ProcessSupervisor;
  /** Hermetic tests may replace only the guardian entry, never production wiring. */
  guardianWorkerUrl?: URL;
  /** Capability qualification asks the start-gated child for its own toolchain proof. */
  collectToolchainProof?: boolean;
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

type WorkerManifest = {
  outputs: Array<{
    slot: SpatialReferenceV2MissingOutput["slot"];
    ordinal: number;
    file: string;
    sourceTimeMs?: number;
  }>;
};

function assertSpatialV2SupervisionAvailable(): void {
  if (!supportsSpatialReferenceV2ResourceLimits()) {
    // Other platforms have no verified full-tree RSS observer and must not advertise v2.
    throw new Error("spatial_v2_supervision_unsupported");
  }
}

function exactScopeKey(input: SpatialReferenceV2Input): string {
  const identity = [
    input.runtimeId,
    input.runtimeIdempotencyKey,
    input.dispatchAttemptId,
    input.sequence,
    input.executionFingerprint,
  ];
  return `spatial-reference-v2:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

async function resolveExecutionResourceProfile(params: {
  config: SpatialReferenceV2RendererConfig;
  input: SpatialReferenceV2Input;
}): Promise<SpatialReferenceV2ResourceProfile> {
  const identity = params.config.buildIdentity;
  if (!identity) {
    // Direct construction is retained only for supervised fixture tests.  The
    // factory is the sole production construction path and always supplies a
    // verified identity below.
    return createSpatialReferenceV2ResourceProfile();
  }
  let actualDigest: string;
  let resourceProfile: SpatialReferenceV2ResourceProfile;
  try {
    const manifest = await buildSpatialReferenceV2Manifest({
      ...identity.manifestInput,
      rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
    });
    actualDigest = spatialReferenceV2BuildDigest(manifest);
    resourceProfile = manifest.resourceProfile;
  } catch (error) {
    if (error instanceof Error && error.message === "spatial_v2_supervision_unsupported") {
      throw error;
    }
    throw new Error("spatial_v2_renderer_build_unavailable");
  }
  if (
    actualDigest !== identity.advertisedDigest ||
    actualDigest !== params.input.renderIntent.rendererBuildDigest
  ) {
    throw new Error("spatial_v2_renderer_build_mismatch");
  }
  const availableBytes = (identity.readHostAvailableBytes ?? freemem)();
  if (
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < resourceProfile.minHostAvailableBytes
  ) {
    throw new Error("spatial_v2_host_memory_unavailable");
  }
  return resourceProfile;
}

async function waitForScopeExtinction(
  supervisor: ProcessSupervisor,
  scopeKey: string,
): Promise<void> {
  if (!supervisor.waitForScope) {
    throw new Error("spatial_v2_supervision_unsupported");
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      supervisor.waitForScope(scopeKey),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("spatial_v2_stop_unconfirmed")),
          STOP_CONFIRM_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isPathDirectChild(root: string, file: string): boolean {
  const resolved = path.resolve(root, file);
  return path.dirname(resolved) === path.resolve(root) && path.basename(resolved) === file;
}

async function readWorkerManifest(params: {
  manifestPath: string;
  workDir: string;
  expected: readonly SpatialReferenceV2MissingOutput[];
  input: SpatialReferenceV2RenderInput;
}): Promise<SpatialReferenceV2PartialRenderResult> {
  const manifest = JSON.parse(await readFile(params.manifestPath, "utf8")) as WorkerManifest;
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length !== params.expected.length) {
    throw new Error("spatial_v2_worker_manifest_invalid");
  }
  const expected = new Set(params.expected.map((output) => `${output.slot}:${output.ordinal}`));
  const observed = new Set<string>();
  const outputs: SpatialReferenceV2PartialRenderResult = [];
  for (const output of manifest.outputs) {
    if (
      !output ||
      typeof output.slot !== "string" ||
      !Number.isSafeInteger(output.ordinal) ||
      typeof output.file !== "string" ||
      !isPathDirectChild(params.workDir, output.file)
    ) {
      throw new Error("spatial_v2_worker_manifest_invalid");
    }
    const key = `${output.slot}:${output.ordinal}`;
    if (!expected.has(key) || observed.has(key)) {
      throw new Error("spatial_v2_worker_manifest_invalid");
    }
    observed.add(key);
    const bytes = await readFile(path.join(params.workDir, output.file));
    if (output.slot === "motion_reference_video") {
      outputs.push({
        slot: "motion_reference_video",
        ordinal: 0,
        motionMp4: bytes,
        width: params.input.renderIntent.width,
        height: params.input.renderIntent.height,
        fps: 12,
        frameCount: params.input.motionReference.frames.length,
        durationMs: params.input.motionReference.encodedDurationMs,
        evaluatorVersion: params.input.motionReference.evaluatorVersion,
      });
      continue;
    }
    if (
      output.slot !== "composition_frame" &&
      output.slot !== "start_frame" &&
      output.slot !== "end_frame" &&
      output.slot !== "topdown_frame" &&
      output.slot !== "keyframe"
    ) {
      throw new Error("spatial_v2_worker_manifest_invalid");
    }
    outputs.push({
      slot: output.slot,
      ordinal: output.ordinal,
      ...(typeof output.sourceTimeMs === "number" ? { sourceTimeMs: output.sourceTimeMs } : {}),
      png: bytes,
    });
  }
  return outputs;
}

function fullResultFromPartial(
  partial: SpatialReferenceV2PartialRenderResult,
  input: SpatialReferenceV2RenderInput,
): SpatialReferenceV2RenderResult {
  const composition = partial.find((output) => output.slot === "composition_frame");
  const motion = partial.find((output) => output.slot === "motion_reference_video");
  if (!composition || !motion || !("png" in composition) || !("motionMp4" in motion)) {
    throw new Error("spatial_v2_worker_manifest_incomplete");
  }
  const referencePngs = partial.flatMap((output) => {
    if (output.slot === "composition_frame" || output.slot === "motion_reference_video") {
      return [];
    }
    return [
      {
        slot: output.slot,
        ordinal: output.ordinal,
        ...(output.sourceTimeMs === undefined ? {} : { sourceTimeMs: output.sourceTimeMs }),
        png: output.png,
      },
    ];
  });
  if (referencePngs.length !== (input.motionReference.referenceFrames ?? []).length) {
    throw new Error("spatial_v2_worker_manifest_incomplete");
  }
  return {
    compositionPng: composition.png,
    compositionPixelDigest: `sha256:${createHash("sha256").update(composition.png).digest("hex")}`,
    width: motion.width,
    height: motion.height,
    motionMp4: motion.motionMp4,
    fps: motion.fps,
    frameCount: motion.frameCount,
    durationMs: motion.durationMs,
    evaluatorVersion: motion.evaluatorVersion,
    referencePngs,
  };
}

async function runSupervisedWorker(params: {
  config: SpatialReferenceV2RendererConfig;
  input: SpatialReferenceV2Input;
  signal: AbortSignal;
  outputs: readonly SpatialReferenceV2MissingOutput[];
  lifecycle?: SpatialReferenceV2RenderLifecycle;
}): Promise<SpatialReferenceV2PartialRenderResult> {
  assertSpatialV2SupervisionAvailable();
  const resourceProfile = await resolveExecutionResourceProfile({
    config: params.config,
    input: params.input,
  });
  const supervisor = params.config.supervisor ?? getProcessSupervisor();
  const scopeKey = params.lifecycle?.executionScope?.scopeKey ?? exactScopeKey(params.input);
  const runId = params.lifecycle?.executionScope?.runId ?? `spatial-reference-v2:${randomUUID()}`;
  const workDir = await mkdtemp(path.join(tmpdir(), "wisclaw-spatial-v2-"));
  const requestPath = path.join(workDir, "request.json");
  const manifestPath = path.join(workDir, "result.json");
  const renderInput = createSpatialReferenceV2RenderInput(params.input);
  await writeFile(
    requestPath,
    JSON.stringify({
      input: renderInput,
      outputs: [...params.outputs],
      chromiumExecutablePath: params.config.chromiumExecutablePath,
      referenceRenderHtmlPath: params.config.referenceRenderHtmlPath,
      workDir,
      resourceProfile,
      ...(params.config.collectToolchainProof ? { collectToolchainProof: true as const } : {}),
    } satisfies WorkerRequest),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  const workerUrl = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "v2-renderer.worker",
    distWorkerPath: "gateway/media-studio-spatial-reference-runtime/v2-renderer.worker.js",
  });
  const guardianUrl =
    params.config.guardianWorkerUrl ??
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spatialReferenceGuardian);
  // A production guardian owns narrow durable checkpoints. Hermetic guardian
  // substitutes are explicitly permitted only for fixture-level protocol tests.
  if (!params.lifecycle?.guardianJournal && !params.config.guardianWorkerUrl) {
    throw new Error("spatial_guardian_journal_unavailable");
  }
  const generation = randomUUID();
  let guardianScopeExited = false;
  let guardianSpawned = false;
  let guardian: SpatialReferenceV2GuardianIdentity | undefined;
  let identity: SpatialReferenceV2WorkerIdentity | undefined;
  let scopeObservation: SpatialReferenceV2ScopeObservation | undefined;
  let resolveSpawnIntent: (() => void) | undefined;
  let rejectSpawnIntent: ((error: Error) => void) | undefined;
  const spawnIntent = new Promise<void>((resolve, reject) => {
    resolveSpawnIntent = resolve;
    rejectSpawnIntent = reject;
  });
  let resolveWorkerPrepared: ((value: SpatialReferenceV2WorkerIdentity) => void) | undefined;
  let rejectWorkerPrepared: ((error: Error) => void) | undefined;
  const workerPrepared = new Promise<SpatialReferenceV2WorkerIdentity>((resolve, reject) => {
    resolveWorkerPrepared = resolve;
    rejectWorkerPrepared = reject;
  });
  let resolveStartAuthorized: (() => void) | undefined;
  let rejectStartAuthorized: ((error: Error) => void) | undefined;
  const startAuthorized = new Promise<void>((resolve, reject) => {
    resolveStartAuthorized = resolve;
    rejectStartAuthorized = reject;
  });
  let observationDelivery = Promise.resolve();
  let toolchainProofDelivery = Promise.resolve();
  let receivedToolchainProof = false;
  let invalidToolchainProof: Error | undefined;
  let outcome: "completed" | "cancelled" | "failed" | "stop-unconfirmed" = "failed";
  let workerFailureCode: string | undefined;
  const stop = () => supervisor.cancelScope(scopeKey, "manual-cancel");
  params.signal.addEventListener("abort", stop, { once: true });
  try {
    if (params.signal.aborted) throw new Error("spatial_v2_cancelled_before_launch");
    const run = await supervisor.spawn({
      mode: "child",
      runId,
      sessionId: params.input.dispatchAttemptId,
      backendId: "spatial-reference-v2-guardian",
      scopeKey,
      replaceExistingScope: true,
      argv: [
        process.execPath,
        ...resolveRuntimeWorkerArgv(guardianUrl),
        "--renderer-worker-url",
        workerUrl.href,
        "--request",
        requestPath,
        "--manifest",
        manifestPath,
        "--generation",
        generation,
      ],
      stdinMode: "pipe-closed",
      timeoutMs: 120_000,
      captureOutput: false,
      ownedWorker: true,
      deferWorkerStart: true,
      workerStartHandshake: true,
      onWorkerMessage: (message: unknown) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) return;
        const event = message as Record<string, unknown>;
        if (
          event.type === "spatial-guardian-spawn-intent-v1" &&
          event.generation === generation &&
          event.sequence === 0
        ) {
          resolveSpawnIntent?.();
          return;
        }
        if (
          event.type === "spatial-guardian-worker-prepared-v1" &&
          event.generation === generation &&
          event.sequence === 1 &&
          event.worker &&
          typeof event.worker === "object" &&
          !Array.isArray(event.worker)
        ) {
          const worker = event.worker as Record<string, unknown>;
          if (
            Number.isSafeInteger(worker.pid) &&
            (worker.pid as number) > 0 &&
            Number.isSafeInteger(worker.startTime) &&
            (worker.startTime as number) >= 0
          ) {
            resolveWorkerPrepared?.({
              pid: worker.pid as number,
              startTime: worker.startTime as number,
              runId,
              scopeKey,
            });
          } else {
            rejectWorkerPrepared?.(new Error("spatial_guardian_worker_identity_invalid"));
          }
          return;
        }
        if (
          event.type === "spatial-guardian-start-authorized-v1" &&
          event.generation === generation &&
          event.sequence === 2 &&
          event.worker &&
          typeof event.worker === "object" &&
          !Array.isArray(event.worker)
        ) {
          const worker = event.worker as Record<string, unknown>;
          if (
            identity &&
            Number.isSafeInteger(worker.pid) &&
            Number.isSafeInteger(worker.startTime) &&
            worker.pid === identity.pid &&
            worker.startTime === identity.startTime
          ) {
            resolveStartAuthorized?.();
          } else {
            rejectStartAuthorized?.(new Error("spatial_guardian_start_authorization_invalid"));
          }
          return;
        }
        if (
          event.type === "spatial-guardian-scope-observation-v1" &&
          event.generation === generation &&
          event.sequence === 2 &&
          event.worker &&
          typeof event.worker === "object" &&
          !Array.isArray(event.worker) &&
          guardian
        ) {
          const worker = event.worker as Record<string, unknown>;
          const reason = event.reason;
          if (
            Number.isSafeInteger(worker.pid) &&
            Number.isSafeInteger(worker.startTime) &&
            (reason === "posix_scope_unproven" || reason === "windows_job_unavailable")
          ) {
            scopeObservation = {
              guardian,
              worker: {
                pid: worker.pid as number,
                startTime: worker.startTime as number,
                runId,
                scopeKey,
              },
              reason,
            };
            observationDelivery = observationDelivery.then(
              async () => await params.lifecycle?.onScopeObservation?.(scopeObservation!),
            );
          }
          return;
        }
        if (
          event.type === "spatial-v2-toolchain-proof-v1" &&
          event.generation === generation &&
          event.toolchain &&
          typeof event.toolchain === "object" &&
          !Array.isArray(event.toolchain)
        ) {
          const toolchain = event.toolchain as Record<string, unknown>;
          const isBoundedString = (value: unknown): value is string =>
            typeof value === "string" && value.length > 0 && value.length <= 20_000;
          if (
            !receivedToolchainProof &&
            isBoundedString(toolchain.chromiumVersion) &&
            isBoundedString(toolchain.ffmpegVersion) &&
            isBoundedString(toolchain.ffprobeVersion) &&
            typeof toolchain.ffmpegSha256 === "string" &&
            /^[a-f0-9]{64}$/u.test(toolchain.ffmpegSha256) &&
            typeof toolchain.ffprobeSha256 === "string" &&
            /^[a-f0-9]{64}$/u.test(toolchain.ffprobeSha256) &&
            isBoundedString(toolchain.ffmpegBuildConfiguration) &&
            isBoundedString(toolchain.ffprobeBuildConfiguration)
          ) {
            const proof: SpatialReferenceV2ToolchainProof = {
              chromiumVersion: toolchain.chromiumVersion,
              ffmpegVersion: toolchain.ffmpegVersion,
              ffprobeVersion: toolchain.ffprobeVersion,
              ffmpegSha256: toolchain.ffmpegSha256,
              ffprobeSha256: toolchain.ffprobeSha256,
              ffmpegBuildConfiguration: toolchain.ffmpegBuildConfiguration,
              ffprobeBuildConfiguration: toolchain.ffprobeBuildConfiguration,
            };
            receivedToolchainProof = true;
            toolchainProofDelivery = toolchainProofDelivery.then(
              async () => await params.lifecycle?.onToolchainProof?.(proof),
            );
          } else {
            workerFailureCode = "spatial_v2_toolchain_proof_invalid";
            invalidToolchainProof = new Error(workerFailureCode);
            rejectSpawnIntent?.(new Error(workerFailureCode));
            rejectWorkerPrepared?.(new Error(workerFailureCode));
            rejectStartAuthorized?.(new Error(workerFailureCode));
          }
          return;
        }
        if (
          (event.type === "spatial-v2-failed" || event.type === "spatial-guardian-failed-v1") &&
          typeof event.code === "string"
        ) {
          workerFailureCode = /^spatial_v2_[a-z0-9_]{1,120}$/.test(event.code)
            ? event.code
            : "spatial_v2_guardian_failed";
          rejectSpawnIntent?.(new Error(workerFailureCode));
          rejectWorkerPrepared?.(new Error(workerFailureCode));
          rejectStartAuthorized?.(new Error(workerFailureCode));
        }
      },
    });
    guardianSpawned = true;
    // `run.wait()` is deliberately observed before the first guardian IPC
    // checkpoint. A guardian that dies silently cannot leave the parent
    // waiting for its global worker timeout or be mistaken for an unobserved
    // yet still-recoverable launch.
    const guardianExit = run.wait();
    const awaitGuardianCheckpoint = async <T>(checkpoint: Promise<T>, code: string): Promise<T> =>
      await Promise.race([
        checkpoint,
        guardianExit.then(() => {
          throw new Error(code);
        }),
      ]);
    if (!run.pid) throw new Error("spatial_guardian_identity_unavailable");
    const startTime = getFileLockProcessStartTime(run.pid);
    if (startTime === null) throw new Error("spatial_guardian_identity_unavailable");
    guardian = { pid: run.pid, startTime, runId, scopeKey, generation };
    await params.lifecycle?.onGuardianLaunched?.(guardian);
    const guardianJournal = params.lifecycle?.guardianJournal;
    const journalGuardian = guardianJournal?.guardianFor(guardian);
    if (
      guardianJournal &&
      (!journalGuardian ||
        journalGuardian.protocol !== "spatial_guardian/v1" ||
        journalGuardian.pid !== guardian.pid ||
        journalGuardian.pidStartTimeMs !== guardian.startTime ||
        journalGuardian.generation !== guardian.generation)
    ) {
      throw new Error("spatial_guardian_journal_identity_invalid");
    }
    if (params.signal.aborted) throw new Error("spatial_v2_cancelled_before_start");
    if (!run.openStartGate || !run.sendWorkerMessage)
      throw new Error("spatial_v2_supervision_unsupported");
    await run.openStartGate();
    if (guardianJournal && journalGuardian) {
      await run.sendWorkerMessage({
        type: "spatial-guardian-journal-context-v1",
        generation,
        sequence: 0,
        journal: {
          stateDir: guardianJournal.stateDir,
          namespace: guardianJournal.namespace,
          identity: guardianJournal.identity,
          owner: guardianJournal.owner,
        },
        guardian: journalGuardian,
        scope: { scopeKey, runId },
      });
    }
    await awaitGuardianCheckpoint(spawnIntent, "spatial_guardian_exited_before_spawn_intent");
    await params.lifecycle?.onSpawnIntent?.(guardian);
    await run.sendWorkerMessage({
      type: "spatial-guardian-spawn-intent-ack-v1",
      generation,
      sequence: 0,
    });
    identity = await awaitGuardianCheckpoint(
      workerPrepared,
      "spatial_guardian_exited_before_worker_prepared",
    );
    await params.lifecycle?.onLaunched?.(identity);
    if (guardianJournal) {
      await run.sendWorkerMessage({
        type: "spatial-guardian-authorize-start-v1",
        generation,
        sequence: 1,
      });
      await awaitGuardianCheckpoint(
        startAuthorized,
        "spatial_guardian_exited_before_start_authorization",
      );
      await params.lifecycle?.onStartAuthorized?.(guardian, identity);
    } else {
      // Fixture-only guardian substitutes retain the original parent-owned
      // acknowledgment shape; production cannot enter this branch.
      await params.lifecycle?.onStartAuthorized?.(guardian, identity);
      await run.sendWorkerMessage({
        type: "spatial-guardian-authorize-start-v1",
        generation,
        sequence: 1,
      });
    }
    const exit = await guardianExit;
    if (exit.reason !== "exit" || exit.exitCode !== 0)
      throw new Error(workerFailureCode ?? "spatial_v2_worker_failed");
    if (invalidToolchainProof) throw invalidToolchainProof;
    if (params.config.collectToolchainProof && !receivedToolchainProof) {
      throw new Error("spatial_v2_toolchain_proof_missing");
    }
    await waitForScopeExtinction(supervisor, scopeKey);
    guardianScopeExited = true;
    await observationDelivery;
    await toolchainProofDelivery;
    outcome = "completed";
    return await readWorkerManifest({
      manifestPath,
      workDir,
      expected: params.outputs,
      input: renderInput,
    });
  } catch (error) {
    stop();
    if (!guardianSpawned) throw error;
    try {
      await waitForScopeExtinction(supervisor, scopeKey);
      guardianScopeExited = true;
      await observationDelivery;
      outcome = params.signal.aborted ? "cancelled" : "failed";
    } catch {
      outcome = "stop-unconfirmed";
      throw new Error("spatial_v2_stop_unconfirmed");
    }
    throw error;
  } finally {
    params.signal.removeEventListener("abort", stop);
    if (guardianSpawned && !guardianScopeExited) {
      stop();
      try {
        await waitForScopeExtinction(supervisor, scopeKey);
        guardianScopeExited = true;
      } catch {
        outcome = "stop-unconfirmed";
      }
    }
    try {
      if (guardianScopeExited && guardian && identity && !scopeObservation) {
        await params.lifecycle?.onScopeObservation?.({
          guardian,
          worker: identity,
          reason: "guardian_unavailable",
        });
      }
      // Guardian root completion is not whole-descendant extinction. Its emitted
      // platform observation is separately persisted and remains fail-closed.
      if (identity && guardianScopeExited) await params.lifecycle?.onExited?.(identity, outcome);
    } finally {
      if (guardianScopeExited || !guardianSpawned)
        await rm(workDir, { recursive: true, force: true });
    }
  }
}

export function createSpatialReferenceV2Renderer(
  config: SpatialReferenceV2RendererConfig,
): SpatialReferenceV2Renderer {
  return {
    async render(input, signal, lifecycle) {
      assertSpatialReferenceV2InputLimits(input);
      const outputs = expectedSpatialReferenceV2Outputs(input);
      return fullResultFromPartial(
        await runSupervisedWorker({ config, input, signal, outputs, lifecycle }),
        createSpatialReferenceV2RenderInput(input),
      );
    },
    async renderMissing(input, signal, outputs, lifecycle) {
      assertSpatialReferenceV2InputLimits(input);
      assertSpatialReferenceV2MissingOutputs(input, outputs);
      return await runSupervisedWorker({ config, input, signal, outputs, lifecycle });
    },
  };
}
