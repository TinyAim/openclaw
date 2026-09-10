/** Private v2 packaged-worker qualification before Runtime capability advertisement. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { freemem } from "node:os";
import path from "node:path";
import { requireNodeWorkerProcessIdentity } from "../../node-host/node-worker-process-identity.js";
import type { SpatialReferenceRelayDispatch } from "../media-studio-spatial-reference-render-http.js";
import type {
  SpatialReferenceJournalScopeGuardian,
  SpatialReferenceJournalWorker,
} from "./reference-journal-record.js";
import type { SpatialReferenceJournal, SpatialReferenceJournalOwner } from "./reference-journal.js";
import {
  buildSpatialReferenceV2Manifest,
  createSpatialReferenceV2ResourceProfile,
  spatialReferenceV2ExecutionMode,
  spatialReferenceV2BuildDigest,
  SPATIAL_V2_RESOURCE_PROFILE_MIN_HOST_AVAILABLE_BYTES,
  type SpatialReferenceV2BuildManifestInput,
} from "./v2-build-manifest.js";
import type {
  SpatialReferenceV2RenderLifecycle,
  SpatialReferenceV2RenderResult,
  SpatialReferenceV2ToolchainProof,
} from "./v2-renderer.contract.js";
import {
  createSpatialReferenceV2Renderer,
  SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
} from "./v2-renderer.js";

export type SpatialReferenceV2RuntimeToolchain = {
  referenceRenderHtmlPath: string;
  chromiumExecutablePath: string;
  rendererBuildDigest: string;
  buildIdentity: {
    advertisedDigest: string;
    manifestInput: Omit<SpatialReferenceV2BuildManifestInput, "rendererModuleUrl">;
  };
};

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function qualificationDispatch(
  rendererBuildDigest: string,
): Extract<SpatialReferenceRelayDispatch, { contractVersion: "spatial_reference_render/v2" }> {
  const camera = {
    position: { x: 0, y: 2, z: 5 },
    targetPoint: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
  };
  const nodes = [
    {
      nodeId: "qualification-floor",
      kind: "prop_placeholder",
      position: { x: 0, y: -0.1, z: 0 },
      scale: { x: 12, y: 0.2, z: 12 },
    },
    {
      nodeId: "qualification-wall",
      kind: "prop_placeholder",
      position: { x: 0, y: 2, z: -4 },
      scale: { x: 9, y: 4, z: 0.2 },
    },
    {
      nodeId: "qualification-actor",
      kind: "character_placeholder",
      position: { x: 0, y: 0, z: 0 },
    },
  ];
  const sourceDurationMs = 10_000;
  const frames = Array.from({ length: 120 }, (_, index) => ({
    timeMs: Math.min(sourceDurationMs, Math.round((index * 1000) / 12)),
    snapshotDigest: `qualification-frame-${index}`,
    camera,
    nodes,
  }));
  const keyframes = Array.from({ length: 16 }, (_, index) => ({
    slot: "keyframe" as const,
    ordinal: index,
    sourceTimeMs: Math.round(((index + 1) * sourceDurationMs) / 17),
    snapshotDigest: `qualification-keyframe-${index}`,
    camera,
    nodes,
  }));
  return {
    kind: "media_studio.spatial_reference_render",
    contractVersion: "spatial_reference_render/v2",
    workspaceId: "qualification",
    runtimeId: "qualification",
    projectId: "qualification",
    shotId: "qualification",
    taskId: "qualification",
    materializationId: "qualification",
    runtimeIdempotencyKey: "qualification",
    requestId: "qualification",
    attempt: 1,
    dispatchAttemptId: "qualification",
    sequence: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    intentFingerprint: "qualification",
    executionFingerprint: "qualification",
    blueprint: {
      blueprintId: "qualification",
      version: 1,
      blueprintDigest: "qualification",
      frameAspectRatio: 16 / 9,
      camera,
      nodes,
    },
    renderIntent: {
      profile: "proxy_previs",
      width: 1280,
      height: 720,
      backgroundPolicy: "neutral_studio",
      rendererContractVersion: "spatial_reference_render/v2",
      rendererBuildDigest,
      renderSpecDigest: "qualification",
    },
    // The worker input projection excludes every grant, callback, Runtime ID,
    // workspace ID and token. These placeholders are never observed by it.
    sourceGrants: [],
    outputUploadGrant: {
      purpose: "output_upload",
      grantToken: "qualification",
      artifactId: "qualification",
    },
    motionReferenceUploadGrant: {
      purpose: "output_upload",
      grantToken: "qualification",
      artifactId: "qualification-motion",
    },
    expectedOutputs: [
      { slot: "composition_frame", ordinal: 0, artifactId: "qualification", mimeType: "image/png" },
      {
        slot: "motion_reference_video",
        ordinal: 0,
        artifactId: "qualification-motion",
        mimeType: "video/mp4",
      },
      {
        slot: "start_frame",
        ordinal: 0,
        sourceTimeMs: 0,
        artifactId: "qualification-start",
        mimeType: "image/png",
      },
      {
        slot: "end_frame",
        ordinal: 0,
        sourceTimeMs: sourceDurationMs,
        artifactId: "qualification-end",
        mimeType: "image/png",
      },
      {
        slot: "topdown_frame",
        ordinal: 0,
        artifactId: "qualification-topdown",
        mimeType: "image/png",
      },
      ...keyframes.map((frame) => ({
        slot: frame.slot,
        ordinal: frame.ordinal,
        sourceTimeMs: frame.sourceTimeMs,
        artifactId: `qualification-${frame.slot}-${frame.ordinal}`,
        mimeType: "image/png" as const,
      })),
    ],
    callback: {
      path: "/v1/control/media-gen/runtime/spatial-reference/callback",
      controlApiBaseUrl: "https://qualification.invalid",
    },
    motionReference: {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs,
      encodedDurationMs: 10_000,
      evaluatorVersion: "spatial_frame_eval/v4",
      frames,
      referenceFrames: [
        {
          slot: "start_frame",
          ordinal: 0,
          sourceTimeMs: 0,
          snapshotDigest: "qualification-start",
          camera,
          nodes,
        },
        {
          slot: "end_frame",
          ordinal: 0,
          sourceTimeMs: sourceDurationMs,
          snapshotDigest: "qualification-end",
          camera,
          nodes,
        },
        {
          slot: "topdown_frame",
          ordinal: 0,
          snapshotDigest: "qualification-topdown",
          camera,
          nodes,
        },
        ...keyframes,
      ],
    },
  };
}

function qualificationOwner(): SpatialReferenceJournalOwner {
  const parent = requireNodeWorkerProcessIdentity(process.pid);
  return {
    epoch: randomUUID(),
    pid: parent.pid,
    pidStartTimeMs: parent.startTime,
    ownerInstanceId: randomUUID(),
  };
}

function admissionBlockedReason(
  reason: "active_owner" | "runtime_quarantined" | "requires_reconciliation",
): string {
  return reason === "active_owner"
    ? "v2 resource qualification is blocked by durable Runtime admission: active_owner"
    : "v2 resource qualification is blocked by durable Runtime admission";
}

/**
 * Build and qualify one actual packaged worker before a v2 capability can be
 * advertised. Exclusive journal admission and a fresh host-memory check happen
 * before any browser, toolchain probe, or worker effect.
 */
export async function resolveSpatialReferenceV2RuntimeToolchain(params: {
  bundleDir: string;
  chromiumExecutablePath: string;
  journal: Pick<
    SpatialReferenceJournal,
    | "claimExclusiveAdmission"
    | "releaseExclusiveAdmission"
    | "armScopeGuardian"
    | "recordSpawnIntent"
    | "recordWorkerPrepared"
    | "authorizeWorkerStart"
    | "recordScopeObservation"
    | "checkpoint"
  >;
  /** Same credential-free SQLite namespace later used by the production guardian. */
  guardianJournal?: { stateDir: string; namespace: string };
  runtimeId?: string;
  readHostAvailableBytes?: () => number;
  /** Hermetic-admission seam only. The factory never supplies a parent probe. */
  testProbeToolchain?: () => Promise<SpatialReferenceV2ToolchainProof>;
  /** Hermetic-admission seam only. Production starts the guardian-owned renderer. */
  testRenderQualification?: (
    dispatch: Extract<
      SpatialReferenceRelayDispatch,
      { contractVersion: "spatial_reference_render/v2" }
    >,
    signal: AbortSignal,
    lifecycle?: SpatialReferenceV2RenderLifecycle,
  ) => Promise<SpatialReferenceV2RenderResult>;
  executionMode?: "source" | "packaged";
}): Promise<SpatialReferenceV2RuntimeToolchain | { reason: string }> {
  if (!params.bundleDir || !params.chromiumExecutablePath) {
    return { reason: "v2 bundle directory or Chromium executable is missing" };
  }
  const manifestPath = path.join(params.bundleDir, "viewport_manifest.json");
  const referenceRenderHtmlPath = path.join(params.bundleDir, "reference_render.html");
  const referenceRenderScriptPath = path.join(params.bundleDir, "reference_render_host.js");
  const owner = qualificationOwner();
  const runtimeId = params.runtimeId || "qualification";
  const nowMs = () => Date.now();
  let admitted:
    | Extract<
        Awaited<ReturnType<SpatialReferenceJournal["claimExclusiveAdmission"]>>,
        { claimed: true }
      >
    | undefined;
  let spawned = false;
  let scopeEvidence: "extinct" | "never_spawned" | undefined;
  const releaseAdmission = async () => {
    if (!admitted) return;
    return await params.journal.releaseExclusiveAdmission({
      owner,
      nowMs: nowMs(),
      scopeEvidence: scopeEvidence ?? "never_spawned",
      spawned,
    });
  };
  const qualify = async (): Promise<SpatialReferenceV2RuntimeToolchain | { reason: string }> => {
    try {
      const [manifestText, chromiumStat] = await Promise.all([
        readFile(manifestPath, "utf8"),
        stat(params.chromiumExecutablePath),
      ]);
      if (!chromiumStat.isFile()) return { reason: "configured Chromium path is not a file" };
      const manifest = JSON.parse(manifestText) as {
        referenceRender?: { contractVersion?: unknown; bundleSha256?: unknown };
      };
      if (
        manifest.referenceRender?.contractVersion !== "spatial_reference_render/v2" ||
        typeof manifest.referenceRender?.bundleSha256 !== "string" ||
        manifest.referenceRender.bundleSha256 !== (await sha256File(referenceRenderScriptPath))
      ) {
        return { reason: "reference renderer bundle manifest does not match v2 artifact" };
      }
      // Do not use a source/tsx probe as a surrogate for a deployable Runtime
      // worker. The packaged entry must exist before this code launches Chrome.
      const executionMode =
        params.executionMode ??
        spatialReferenceV2ExecutionMode(SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL);
      if (executionMode !== "packaged") {
        return { reason: "v2 packaged renderer worker is unavailable" };
      }
      const claimed = await params.journal.claimExclusiveAdmission({
        owner,
        nowMs: nowMs(),
        leaseExpiresAtMs: nowMs() + 120_000,
        scopeKey: `spatial-reference-qualification:${runtimeId}:${owner.epoch}`,
        runId: `spatial-reference-qualification:${runtimeId}:${owner.epoch}`,
        runtimeId,
      });
      if (!claimed.claimed) return { reason: admissionBlockedReason(claimed.reason) };
      admitted = claimed;
      const availableBytes = (params.readHostAvailableBytes ?? freemem)();
      if (
        !Number.isSafeInteger(availableBytes) ||
        availableBytes < SPATIAL_V2_RESOURCE_PROFILE_MIN_HOST_AVAILABLE_BYTES
      ) {
        return { reason: "spatial_v2_host_memory_unavailable" };
      }
      // The parent may read the packaged artifact identity, but it must not
      // launch Chromium or FFmpeg/ffprobe before the guardian owns a durable
      // spawn intent and authorizes its child. A test may provide a synthetic
      // proof; the factory never does.
      let toolchain = await params.testProbeToolchain?.();
      const provisionalManifestInput = {
        referenceRenderHtmlPath,
        chromiumExecutablePath: params.chromiumExecutablePath,
        toolchain: {
          chromiumVersion: toolchain?.chromiumVersion ?? "qualification-pending",
          ffmpegVersion: toolchain?.ffmpegVersion ?? "qualification-pending",
          ffprobeVersion: toolchain?.ffprobeVersion ?? "qualification-pending",
          ffmpegBuildConfiguration: toolchain?.ffmpegBuildConfiguration ?? "qualification-pending",
          ffprobeBuildConfiguration:
            toolchain?.ffprobeBuildConfiguration ?? "qualification-pending",
        },
        resourceProfile: createSpatialReferenceV2ResourceProfile(),
      } satisfies Omit<SpatialReferenceV2BuildManifestInput, "rendererModuleUrl">;
      const provisionalBuildManifest = await buildSpatialReferenceV2Manifest({
        ...provisionalManifestInput,
        rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      });
      if (
        provisionalBuildManifest.execution.mode !== "packaged" &&
        !params.testRenderQualification
      ) {
        return { reason: "v2 packaged renderer worker is unavailable" };
      }
      const qualificationBuildDigest = spatialReferenceV2BuildDigest(provisionalBuildManifest);
      const qualificationBuildIdentity = {
        advertisedDigest: qualificationBuildDigest,
        manifestInput: provisionalManifestInput,
      };
      let guardian: SpatialReferenceJournalScopeGuardian | undefined;
      let worker: SpatialReferenceJournalWorker | undefined;
      const lifecycle: SpatialReferenceV2RenderLifecycle = {
        executionScope: { scopeKey: claimed.owner.scopeKey, runId: claimed.owner.runId },
        ...(params.guardianJournal
          ? {
              guardianJournal: {
                ...params.guardianJournal,
                identity: claimed.identity,
                owner,
                guardianFor: (receipt) =>
                  guardian &&
                  guardian.pid === receipt.pid &&
                  guardian.pidStartTimeMs === receipt.startTime &&
                  guardian.generation === receipt.generation
                    ? guardian
                    : undefined,
              },
            }
          : {}),
        onGuardianLaunched: async (receipt) => {
          guardian = {
            protocol: "spatial_guardian/v1",
            guardianId: `spatial-qualification-guardian:${owner.epoch}:${receipt.pid}`,
            generation: receipt.generation,
            pid: receipt.pid,
            pidStartTimeMs: receipt.startTime,
            guardianBuildDigest: qualificationBuildDigest,
            armedAtMs: nowMs(),
          };
          await params.journal.armScopeGuardian({
            identity: claimed.identity,
            owner,
            nowMs: nowMs(),
            guardian,
          });
        },
        onSpawnIntent: async () => {
          if (!guardian) throw new Error("spatial_guardian_identity_missing");
        },
        onLaunched: async (receipt) => {
          if (!guardian) throw new Error("spatial_guardian_identity_missing");
          worker = {
            pid: receipt.pid,
            startTime: receipt.startTime,
            scopeId: receipt.scopeKey,
            runId: receipt.runId,
            workerTokenDigest: createHash("sha256").update(receipt.runId).digest("hex"),
          };
        },
        onStartAuthorized: async (_guardian, receipt) => {
          if (
            !guardian ||
            !worker ||
            receipt.pid !== worker.pid ||
            receipt.startTime !== worker.startTime
          ) {
            throw new Error("spatial_guardian_start_authorization_invalid");
          }
        },
        onScopeObservation: async (observation) => {
          if (
            !guardian ||
            !worker ||
            observation.guardian.pid !== guardian.pid ||
            observation.guardian.startTime !== guardian.pidStartTimeMs ||
            observation.worker.pid !== worker.pid ||
            observation.worker.startTime !== worker.startTime
          ) {
            throw new Error("spatial_guardian_scope_observation_invalid");
          }
          if (observation.state === "extinct") scopeEvidence = "extinct";
        },
        onToolchainProof: async (proof) => {
          if (toolchain) throw new Error("spatial_v2_toolchain_proof_duplicate");
          toolchain = proof;
        },
        onExited: async (receipt, outcome) => {
          if (!worker || receipt.pid !== worker.pid || receipt.startTime !== worker.startTime) {
            throw new Error("spatial_v2_stop_unconfirmed");
          }
          await params.journal.checkpoint({
            identity: claimed.identity,
            owner,
            nowMs: nowMs(),
            phase: "worker_exited",
            worker: {
              ...worker,
              exited: {
                atMs: nowMs(),
                reason:
                  outcome === "cancelled"
                    ? "cancelled"
                    : outcome === "completed"
                      ? "completed"
                      : "dead",
              },
            },
          });
        },
      };
      const render =
        params.testRenderQualification ??
        ((dispatch, signal, renderLifecycle) =>
          createSpatialReferenceV2Renderer({
            chromiumExecutablePath: params.chromiumExecutablePath,
            referenceRenderHtmlPath,
            buildIdentity: qualificationBuildIdentity,
            collectToolchainProof: !toolchain,
          }).render(dispatch, signal, renderLifecycle));
      // A synthetic test renderer never creates a process. All real
      // qualification effects begin only in the guardian-owned child above.
      spawned = !params.testRenderQualification;
      await render(
        qualificationDispatch(qualificationBuildDigest),
        AbortSignal.timeout(120_000),
        lifecycle,
      );
      if (!toolchain) throw new Error("spatial_v2_toolchain_proof_missing");
      const manifestInput = {
        referenceRenderHtmlPath,
        chromiumExecutablePath: params.chromiumExecutablePath,
        toolchain: {
          chromiumVersion: toolchain.chromiumVersion,
          ffmpegVersion: toolchain.ffmpegVersion,
          ffprobeVersion: toolchain.ffprobeVersion,
          ffmpegBuildConfiguration: toolchain.ffmpegBuildConfiguration,
          ffprobeBuildConfiguration: toolchain.ffprobeBuildConfiguration,
        },
        resourceProfile: createSpatialReferenceV2ResourceProfile(),
      } satisfies Omit<SpatialReferenceV2BuildManifestInput, "rendererModuleUrl">;
      const buildManifest = await buildSpatialReferenceV2Manifest({
        ...manifestInput,
        rendererModuleUrl: SPATIAL_REFERENCE_V2_RENDERER_MODULE_URL,
      });
      if (buildManifest.execution.mode !== "packaged" && !params.testRenderQualification) {
        return { reason: "v2 packaged renderer worker is unavailable" };
      }
      const rendererBuildDigest = spatialReferenceV2BuildDigest(buildManifest);
      const buildIdentity = { advertisedDigest: rendererBuildDigest, manifestInput };
      return {
        referenceRenderHtmlPath,
        chromiumExecutablePath: params.chromiumExecutablePath,
        rendererBuildDigest,
        buildIdentity,
      };
    } catch (error) {
      return {
        reason: `v2 toolchain probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  const result = await qualify();
  try {
    const released = await releaseAdmission();
    if (released && !released.released)
      return { reason: "spatial_v2_qualification_scope_unconfirmed" };
  } catch {
    return { reason: "spatial_v2_qualification_admission_release_failed" };
  }
  return result;
}
