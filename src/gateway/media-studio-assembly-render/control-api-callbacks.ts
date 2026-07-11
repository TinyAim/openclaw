/**
 * Gate 1E — Control API progress/complete callbacks for assembly-render.
 */
import type {
  AssemblyRenderCompleteCallback,
  AssemblyRenderControlApiBridge,
  AssemblyRenderFailCallback,
  AssemblyRenderProgressCallback,
  MediaStudioAssemblyRenderFetch,
} from "./types.js";

const RUNTIME_TOKEN_HEADER = "x-wisclaw-media-gen-runtime-token";

function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, "");
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}`;
}

async function postJson(
  fetchImpl: MediaStudioAssemblyRenderFetch,
  url: string,
  token: string,
  body: unknown,
  context: string,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      [RUNTIME_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${context} failed status=${res.status} body=${text.slice(0, 200)}`);
  }
}

export const STUDIO_ASSEMBLY_RENDER_HANDOFF_PRESET =
  "media_studio.assembly_render" as const;

/**
 * Gate 1H: default Artifact Center handoff for encoded studio masters.
 * Uses renderId ownership (not media-gen taskId).
 */
export function createDefaultAssemblyRenderHandoffMaster(options: {
  controlApiUrl: string;
  runtimeId: string;
  token: string;
  fetchImpl: MediaStudioAssemblyRenderFetch;
  handoffPath?: string;
}): NonNullable<AssemblyRenderControlApiBridge["handoffMaster"]> {
  const base = options.controlApiUrl.replace(/\/+$/, "");
  const handoffPath =
    options.handoffPath ?? "/v1/control/media-gen/runtime/artifact-handoff";
  return async (input) => {
    const params = new URLSearchParams({
      workspaceId: input.workspaceId,
      runtimeId: options.runtimeId,
      renderId: input.renderId,
      projectId: input.projectId,
      presetId: STUDIO_ASSEMBLY_RENDER_HANDOFF_PRESET,
      mimeType: input.mimeType,
      sha256: input.sha256,
      durationSec: String(input.durationSec),
      resolution: input.resolution,
    });
    const url = `${joinUrl(base, handoffPath)}?${params.toString()}`;
    const res = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": input.mimeType,
        accept: "application/json",
        [RUNTIME_TOKEN_HEADER]: options.token,
      },
      body: input.bytes,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(
        `assembly-render handoff failed status=${res.status} body=${raw.slice(0, 200)}`,
      );
    }
    let parsed: { data?: { artifact?: { artifactId?: string } }; artifact?: { artifactId?: string } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new Error("assembly-render handoff returned non-JSON");
    }
    const artifactId =
      parsed?.data?.artifact?.artifactId ?? parsed?.artifact?.artifactId;
    if (!artifactId || !String(artifactId).trim()) {
      throw new Error("assembly-render handoff returned no artifactId");
    }
    return { artifactId: String(artifactId).trim() };
  };
}

export function createAssemblyRenderControlApiBridge(options: {
  controlApiUrl: string;
  runtimeId: string;
  token: string;
  fetchImpl?: MediaStudioAssemblyRenderFetch;
  progressPath?: string;
  completePath?: string;
  handoffMaster?: AssemblyRenderControlApiBridge["handoffMaster"];
  /** When true and handoffMaster omitted, wire default renderId handoff. */
  enableDefaultHandoff?: boolean;
}): AssemblyRenderControlApiBridge {
  const fetchImpl =
    options.fetchImpl ??
    (globalThis.fetch as unknown as MediaStudioAssemblyRenderFetch | undefined);
  if (!fetchImpl) {
    throw new Error("assembly-render control API bridge requires fetch");
  }
  const base = options.controlApiUrl.replace(/\/+$/, "");
  const progressPath =
    options.progressPath ?? "/v1/control/media-gen/runtime/render/progress";
  const completePath =
    options.completePath ?? "/v1/control/media-gen/runtime/render/complete";

  const handoffMaster =
    options.handoffMaster ??
    (options.enableDefaultHandoff
      ? createDefaultAssemblyRenderHandoffMaster({
          controlApiUrl: base,
          runtimeId: options.runtimeId,
          token: options.token,
          fetchImpl,
        })
      : undefined);

  return {
    runtimeId: options.runtimeId,
    ...(handoffMaster ? { handoffMaster } : {}),
    async postProgress(input: AssemblyRenderProgressCallback): Promise<void> {
      await postJson(
        fetchImpl,
        joinUrl(base, progressPath),
        options.token,
        {
          workspaceId: input.workspaceId,
          runtimeId: input.runtimeId,
          projectId: input.projectId,
          renderId: input.renderId,
          progressPercent: input.progressPercent,
          ...(input.progressMessage
            ? { progressMessage: input.progressMessage }
            : {}),
          ...(typeof input.dispatchEpoch === "number"
            ? { dispatchEpoch: input.dispatchEpoch }
            : {}),
          ...(input.dispatchAttemptId
            ? { dispatchAttemptId: input.dispatchAttemptId }
            : {}),
        },
        "assembly-render progress",
      );
    },
    async postComplete(input: AssemblyRenderCompleteCallback): Promise<void> {
      await postJson(
        fetchImpl,
        joinUrl(base, completePath),
        options.token,
        {
          workspaceId: input.workspaceId,
          runtimeId: input.runtimeId,
          projectId: input.projectId,
          renderId: input.renderId,
          finalMasterArtifactId: input.finalMasterArtifactId,
          qcPassed: true,
          ...(typeof input.durationSec === "number"
            ? { durationSec: input.durationSec }
            : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.codec ? { codec: input.codec } : {}),
          ...(input.checksum ? { checksum: input.checksum } : {}),
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          ...(typeof input.dispatchEpoch === "number"
            ? { dispatchEpoch: input.dispatchEpoch }
            : {}),
          ...(input.dispatchAttemptId
            ? { dispatchAttemptId: input.dispatchAttemptId }
            : {}),
        },
        "assembly-render complete",
      );
    },
    async postFail(input: AssemblyRenderFailCallback): Promise<void> {
      await postJson(
        fetchImpl,
        joinUrl(base, completePath),
        options.token,
        {
          workspaceId: input.workspaceId,
          runtimeId: input.runtimeId,
          projectId: input.projectId,
          renderId: input.renderId,
          failed: true,
          errorCode: input.errorCode,
          ...(input.cancelAcknowledged === true
            ? { cancelAcknowledged: true }
            : {}),
          ...(typeof input.dispatchEpoch === "number"
            ? { dispatchEpoch: input.dispatchEpoch }
            : {}),
          ...(input.dispatchAttemptId
            ? { dispatchAttemptId: input.dispatchAttemptId }
            : {}),
        },
        "assembly-render fail",
      );
    },
  };
}
