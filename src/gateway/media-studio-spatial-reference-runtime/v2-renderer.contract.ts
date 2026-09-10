import type { SpatialReferenceRelayDispatch } from "../media-studio-spatial-reference-render-http.js";
import type {
  SpatialReferenceJournalIdentity,
  SpatialReferenceJournalOwner,
  SpatialReferenceJournalScopeGuardian,
} from "./reference-journal-record.js";

export const SPATIAL_V2_FPS = 12 as const;
export const SPATIAL_V2_MAX_DURATION_MS = 10_000;
export const SPATIAL_V2_MAX_FRAMES = 120;
export const SPATIAL_V2_MAX_WIDTH = 1280;
export const SPATIAL_V2_MAX_PIXELS = 921_600;
export const SPATIAL_V2_MAX_TEMP_BYTES = 512 * 1024 * 1024;
export const SPATIAL_V2_MAX_TREE_RSS_BYTES = 1024 * 1024 * 1024;
export const SPATIAL_V2_TOTAL_TIMEOUT_MS = 120_000;
export const SPATIAL_V2_ENCODE_TIMEOUT_MS = 45_000;
export const SPATIAL_V2_PROBE_TIMEOUT_MS = 10_000;

export type SpatialReferenceV2Input = Extract<
  SpatialReferenceRelayDispatch,
  { contractVersion: "spatial_reference_render/v2" }
>;

/**
 * The only relay facts a local renderer may receive. In particular it excludes
 * runtime identifiers, tenancy, callback URLs, and every upload/source grant.
 */
export type SpatialReferenceV2RenderInput = Pick<
  SpatialReferenceV2Input,
  "blueprint" | "renderIntent" | "motionReference"
>;

export type SpatialReferenceV2OutputSlot =
  | "composition_frame"
  | "motion_reference_video"
  | "start_frame"
  | "end_frame"
  | "topdown_frame"
  | "keyframe";

/** A server-derived MissingOutputPlan entry. No client may add an output slot here. */
export type SpatialReferenceV2MissingOutput = {
  slot: SpatialReferenceV2OutputSlot;
  ordinal: number;
};

export type SpatialReferenceV2PngOutput = {
  slot: Exclude<SpatialReferenceV2OutputSlot, "motion_reference_video">;
  ordinal: number;
  sourceTimeMs?: number;
  png: Buffer;
};

export type SpatialReferenceV2MotionOutput = {
  slot: "motion_reference_video";
  ordinal: 0;
  motionMp4: Buffer;
  width: number;
  height: number;
  fps: 12;
  frameCount: number;
  durationMs: number;
  evaluatorVersion: string;
};

/** Sparse, ordered only by the server's MissingOutputPlan; no finalized slot appears here. */
export type SpatialReferenceV2PartialRenderResult = Array<
  SpatialReferenceV2PngOutput | SpatialReferenceV2MotionOutput
>;

export type SpatialReferenceV2RenderResult = {
  compositionPng: Buffer;
  compositionPixelDigest: string;
  width: number;
  height: number;
  motionMp4: Buffer;
  fps: 12;
  frameCount: number;
  durationMs: number;
  evaluatorVersion: string;
  /** Additional frozen stills requested by the v2 reference package. */
  referencePngs: Array<{
    slot: "start_frame" | "end_frame" | "topdown_frame" | "keyframe";
    ordinal: number;
    sourceTimeMs?: number;
    png: Buffer;
  }>;
};

export type SpatialReferenceV2WorkerIdentity = {
  pid: number;
  startTime: number;
  runId: string;
  scopeKey: string;
};

export type SpatialReferenceV2GuardianIdentity = SpatialReferenceV2WorkerIdentity & {
  generation: string;
};

export type SpatialReferenceV2ScopeObservation = {
  guardian: SpatialReferenceV2GuardianIdentity;
  worker: SpatialReferenceV2WorkerIdentity;
  state: "extinct" | "unknown";
  reason?: "posix_scope_unproven" | "windows_job_unavailable" | "guardian_unavailable";
  proof?:
    | {
        protocol: "posix_group_observation_v1";
        processGroupId: number;
        rootState: "dead" | "reused";
      }
    | {
        protocol: "windows_job_v1";
        jobIncarnationId: string;
        activeProcessCount: 0;
        workerPid: number;
        workerStartTime: number;
      };
};

/**
 * Private evidence emitted only by a start-authorized renderer child while it
 * qualifies its own Chromium/FFmpeg execution path. It is not a relay DTO.
 */
export type SpatialReferenceV2ToolchainProof = {
  chromiumVersion: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  ffmpegSha256: string;
  ffprobeSha256: string;
  ffmpegBuildConfiguration: string;
  ffprobeBuildConfiguration: string;
};

/**
 * A private, credential-free locator for the guardian's exact two-key writer.
 * It contains no callback endpoint, grant, source asset, or render geometry.
 */
export type SpatialReferenceV2GuardianJournalContext = {
  stateDir: string;
  namespace: string;
  identity: SpatialReferenceJournalIdentity;
  owner: SpatialReferenceJournalOwner;
  /** Returns the exact guardian receipt after the trusted owner has armed it. */
  guardianFor: (
    identity: SpatialReferenceV2GuardianIdentity,
  ) => SpatialReferenceJournalScopeGuardian | undefined;
};

export type SpatialReferenceV2RenderLifecycle = {
  /** Journal-owned identity supplied before this renderer may spawn a worker. */
  executionScope?: { scopeKey: string; runId: string };
  /** Supplied only by the trusted runtime owner; the guardian uses it for narrow SQLite writes. */
  guardianJournal?: SpatialReferenceV2GuardianJournalContext;
  /** The independently started guardian is known before its one-shot start gate opens. */
  onGuardianLaunched?: (identity: SpatialReferenceV2GuardianIdentity) => void | Promise<void>;
  /** Guardian recorded a durable spawn intent immediately before it creates a worker. */
  onSpawnIntent?: (guardian: SpatialReferenceV2GuardianIdentity) => void | Promise<void>;
  /** Called after exact PID/start-time/scope ownership is available, before render work starts. */
  onLaunched?: (identity: SpatialReferenceV2WorkerIdentity) => void | Promise<void>;
  /** The trusted journal must persist this before the guardian can open its child gate. */
  onStartAuthorized?: (
    guardian: SpatialReferenceV2GuardianIdentity,
    worker: SpatialReferenceV2WorkerIdentity,
  ) => void | Promise<void>;
  /** A guardian-produced local scope fact; only exact platform proof may be extinct. */
  onScopeObservation?: (observation: SpatialReferenceV2ScopeObservation) => void | Promise<void>;
  /** A qualification-only fact produced after the guardian has durably opened the child gate. */
  onToolchainProof?: (proof: SpatialReferenceV2ToolchainProof) => void | Promise<void>;
  /** Called only after the supervisor confirms the exact scope is extinct. */
  onExited?: (
    identity: SpatialReferenceV2WorkerIdentity,
    outcome: "completed" | "cancelled" | "failed" | "stop-unconfirmed",
  ) => void | Promise<void>;
};

export function createSpatialReferenceV2RenderInput(
  input: SpatialReferenceV2Input,
): SpatialReferenceV2RenderInput {
  return {
    blueprint: input.blueprint,
    renderIntent: input.renderIntent,
    motionReference: input.motionReference,
  };
}

export function assertSpatialReferenceV2RenderInputLimits(
  input: SpatialReferenceV2RenderInput,
): void {
  const plan = input.motionReference;
  const referenceFrames = plan.referenceFrames ?? [];
  if (
    plan.fps !== SPATIAL_V2_FPS ||
    plan.sourceDurationMs < 1 ||
    plan.sourceDurationMs > SPATIAL_V2_MAX_DURATION_MS ||
    plan.frames.length < 1 ||
    plan.frames.length > SPATIAL_V2_MAX_FRAMES ||
    plan.frames.length !== Math.ceil((plan.sourceDurationMs * SPATIAL_V2_FPS) / 1000)
  ) {
    throw new Error("spatial_v2_motion_limits_invalid");
  }
  if (
    referenceFrames.length < 3 ||
    referenceFrames.filter((frame) => frame.slot === "keyframe").length > 16 ||
    !referenceFrames.some(
      (frame) => frame.slot === "start_frame" && frame.ordinal === 0 && frame.sourceTimeMs === 0,
    ) ||
    !referenceFrames.some(
      (frame) =>
        frame.slot === "end_frame" &&
        frame.ordinal === 0 &&
        frame.sourceTimeMs === plan.sourceDurationMs,
    ) ||
    !referenceFrames.some((frame) => frame.slot === "topdown_frame" && frame.ordinal === 0)
  ) {
    throw new Error("spatial_v2_reference_package_invalid");
  }
  const { width, height } = input.renderIntent;
  if (
    width < 1 ||
    height < 1 ||
    width > SPATIAL_V2_MAX_WIDTH ||
    height > SPATIAL_V2_MAX_WIDTH ||
    width * height > SPATIAL_V2_MAX_PIXELS ||
    width % 2 !== 0 ||
    height % 2 !== 0
  ) {
    throw new Error("spatial_v2_dimensions_invalid");
  }
  if (input.renderIntent.profile !== "proxy_previs") {
    throw new Error("spatial_v2_profile_or_source_unsupported");
  }
}

/** Validate relay-only policy before the credential-free render projection is made. */
export function assertSpatialReferenceV2InputLimits(input: SpatialReferenceV2Input): void {
  assertSpatialReferenceV2RenderInputLimits(input);
  if (input.sourceGrants.length > 0) {
    throw new Error("spatial_v2_profile_or_source_unsupported");
  }
}

export function expectedSpatialReferenceV2Outputs(
  input: SpatialReferenceV2RenderInput,
): SpatialReferenceV2MissingOutput[] {
  return [
    { slot: "composition_frame", ordinal: 0 },
    { slot: "motion_reference_video", ordinal: 0 },
    ...(input.motionReference.referenceFrames ?? []).map((frame) => ({
      slot: frame.slot,
      ordinal: frame.ordinal,
    })),
  ];
}

function outputKey(output: SpatialReferenceV2MissingOutput): string {
  return `${output.slot}:${output.ordinal}`;
}

export function assertSpatialReferenceV2MissingOutputs(
  input: SpatialReferenceV2RenderInput,
  outputs: readonly SpatialReferenceV2MissingOutput[],
): void {
  const expected = new Set(expectedSpatialReferenceV2Outputs(input).map(outputKey));
  const observed = new Set<string>();
  if (outputs.length === 0) {
    throw new Error("spatial_v2_missing_output_plan_empty");
  }
  for (const output of outputs) {
    if (!Number.isSafeInteger(output.ordinal) || output.ordinal < 0) {
      throw new Error("spatial_v2_missing_output_plan_invalid");
    }
    const key = outputKey(output);
    if (!expected.has(key) || observed.has(key)) {
      throw new Error("spatial_v2_missing_output_plan_invalid");
    }
    observed.add(key);
  }
}
