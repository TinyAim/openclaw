/**
 * Gate 1E — assembly-render runtime encoder types.
 * Control API owns FinalMaster; this runtime only encodes + callbacks.
 */

export type MediaStudioAssemblyRenderFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

export type AssemblyRenderProgressCallback = {
  workspaceId: string;
  projectId: string;
  renderId: string;
  runtimeId: string;
  progressPercent: number;
  progressMessage?: string;
  dispatchEpoch?: number;
  dispatchAttemptId?: string;
};

export type AssemblyRenderCompleteCallback = {
  workspaceId: string;
  projectId: string;
  renderId: string;
  runtimeId: string;
  finalMasterArtifactId: string;
  qcPassed: true;
  durationSec?: number;
  resolution?: string;
  codec?: string;
  checksum?: string;
  mimeType?: string;
  dispatchEpoch?: number;
  dispatchAttemptId?: string;
};

export type AssemblyRenderFailCallback = {
  workspaceId: string;
  projectId: string;
  renderId: string;
  runtimeId: string;
  failed: true;
  errorCode: string;
  dispatchEpoch?: number;
  dispatchAttemptId?: string;
  cancelAcknowledged?: boolean;
  /**
   * When complete fails after Artifact handoff, carry the orphan pointer so
   * Control API can record detection evidence (not yet a full reconcile receipt).
   */
  orphanArtifactId?: string;
  orphanChecksum?: string;
};

export type AssemblyRenderControlApiBridge = {
  runtimeId: string;
  postProgress: (input: AssemblyRenderProgressCallback) => Promise<void>;
  postComplete: (input: AssemblyRenderCompleteCallback) => Promise<void>;
  postFail: (input: AssemblyRenderFailCallback) => Promise<void>;
  /**
   * Optional: register encoded bytes as Artifact Center object.
   * When omitted, complete uses a synthetic id only if allowSyntheticMasterId.
   */
  handoffMaster?: (input: {
    workspaceId: string;
    projectId: string;
    renderId: string;
    taskCenterTaskId?: string;
    bytes: Uint8Array;
    mimeType: string;
    sha256: string;
    durationSec: number;
    resolution: string;
  }) => Promise<{ artifactId: string }>;
};

export type AssemblyRenderEncodeResult = {
  bytes: Uint8Array;
  mimeType: "video/mp4";
  durationSec: number;
  resolution: string;
  codec: string;
  sha256: string;
};

export type AssemblyRenderEncodeFn = (input: {
  renderId: string;
  timeline: Array<{ shotId: string; artifactId: string; durationSec?: number }>;
  signal: AbortSignal;
}) => Promise<AssemblyRenderEncodeResult>;
