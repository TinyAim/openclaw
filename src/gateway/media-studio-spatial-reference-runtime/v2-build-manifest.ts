/**
 * Private actual-build identity for the isolated Spatial v2 renderer.
 *
 * This stays below the public relay contract.  The Control API freezes the
 * resulting digest through its existing rendererBuildDigest field; it must not
 * receive paths, process information, or this manifest's diagnostic detail.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSystemBin } from "../../infra/resolve-system-bin.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { resolveFfmpegBin } from "../../media/ffmpeg-exec.js";

export const SPATIAL_V2_RESOURCE_PROFILE_ID = "spatial_tree_rss_2gib/v1" as const;
export const SPATIAL_V2_RESOURCE_PROFILE_VERSION = 1 as const;
export const SPATIAL_V2_RESOURCE_PROFILE_MAX_TREE_RSS_BYTES = 2_147_483_648;
export const SPATIAL_V2_RESOURCE_PROFILE_MIN_HOST_AVAILABLE_BYTES = 2_684_354_560;
export const SPATIAL_V2_RESOURCE_PROFILE_POLL_MS = 100 as const;

export type SpatialReferenceV2ResourceProfile = {
  profileId: typeof SPATIAL_V2_RESOURCE_PROFILE_ID;
  profileVersion: typeof SPATIAL_V2_RESOURCE_PROFILE_VERSION;
  metric: "darwin_ps_tree_rss_sum_v1" | "linux_proc_status_tree_rss_sum_v1";
  rootScope: "isolated_worker_plus_live_descendants";
  maxTreeRssBytes: number;
  minHostAvailableBytes: number;
  pollMs: typeof SPATIAL_V2_RESOURCE_PROFILE_POLL_MS;
  mandatoryBoundaries: readonly [
    "post_browser_launch",
    "post_host_load",
    "post_first_webgl_frame",
    "before_ffmpeg",
    "after_ffmpeg",
  ];
  persistentContextPages: 1;
  oneRuntimeJob: true;
};

export type SpatialReferenceV2ToolchainIdentity = {
  chromiumVersion: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  ffmpegBuildConfiguration: string;
  ffprobeBuildConfiguration: string;
};

export type SpatialReferenceV2BuildManifest = {
  contractVersion: "spatial_reference_render/v2";
  resourceProfile: SpatialReferenceV2ResourceProfile;
  execution: {
    mode: "source" | "packaged";
    workerArgv: readonly string[];
    guardianArgv: readonly string[];
    tsxLoader?: { url: string; sha256: string };
  };
  artifacts: {
    rendererParent: { url: string; sha256: string };
    rendererWorker: { url: string; sha256: string };
    guardianWorker: { url: string; sha256: string };
    referenceRenderHtml: { url: string; sha256: string };
    referenceRenderHost: { url: string; sha256: string };
    chromiumExecutable: { path: string; sha256: string; identityScope: "executable_entry" };
    nodeExecutable: { path: string; sha256: string };
    ffmpegExecutable: { path: string; sha256: string };
    ffprobeExecutable: { path: string; sha256: string };
  };
  toolchain: SpatialReferenceV2ToolchainIdentity;
};

export type SpatialReferenceV2BuildManifestInput = {
  /** This must be the renderer's own module URL, never the factory's URL. */
  rendererModuleUrl: string;
  referenceRenderHtmlPath: string;
  chromiumExecutablePath: string;
  toolchain: SpatialReferenceV2ToolchainIdentity;
  resourceProfile?: SpatialReferenceV2ResourceProfile;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")}`;
}

function filePathFromUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") throw new Error("spatial_v2_renderer_build_unavailable");
  return fileURLToPath(parsed);
}

async function fileIdentityFromPath(filePath: string): Promise<{ path: string; sha256: string }> {
  if (!path.isAbsolute(filePath)) throw new Error("spatial_v2_renderer_build_unavailable");
  try {
    return {
      path: filePath,
      sha256: createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex"),
    };
  } catch {
    throw new Error("spatial_v2_renderer_build_unavailable");
  }
}

async function urlIdentity(url: URL): Promise<{ url: string; sha256: string }> {
  const filePath = filePathFromUrl(url.href);
  const identity = await fileIdentityFromPath(filePath);
  return { url: url.href, sha256: identity.sha256 };
}

function resourceMetric(): SpatialReferenceV2ResourceProfile["metric"] {
  if (process.platform === "darwin") return "darwin_ps_tree_rss_sum_v1";
  if (process.platform === "linux") return "linux_proc_status_tree_rss_sum_v1";
  throw new Error("spatial_v2_supervision_unsupported");
}

/** The additive 2 GiB profile is immutable and therefore safe to include in the build digest. */
export function createSpatialReferenceV2ResourceProfile(): SpatialReferenceV2ResourceProfile {
  return {
    profileId: SPATIAL_V2_RESOURCE_PROFILE_ID,
    profileVersion: SPATIAL_V2_RESOURCE_PROFILE_VERSION,
    metric: resourceMetric(),
    rootScope: "isolated_worker_plus_live_descendants",
    maxTreeRssBytes: SPATIAL_V2_RESOURCE_PROFILE_MAX_TREE_RSS_BYTES,
    minHostAvailableBytes: SPATIAL_V2_RESOURCE_PROFILE_MIN_HOST_AVAILABLE_BYTES,
    pollMs: SPATIAL_V2_RESOURCE_PROFILE_POLL_MS,
    mandatoryBoundaries: [
      "post_browser_launch",
      "post_host_load",
      "post_first_webgl_frame",
      "before_ffmpeg",
      "after_ffmpeg",
    ],
    persistentContextPages: 1,
    oneRuntimeJob: true,
  };
}

function isSourceWorker(url: URL): boolean {
  return /\.[cm]?ts$/u.test(fileURLToPath(url));
}

/** Resolve only the execution shape so factory admission can reject source/tsx before probing Chrome. */
export function spatialReferenceV2ExecutionMode(rendererModuleUrl: string): "source" | "packaged" {
  const workerUrl = resolveRuntimeWorkerUrl({
    currentModuleUrl: rendererModuleUrl,
    sourceWorkerName: "v2-renderer.worker",
    distWorkerPath: "gateway/media-studio-spatial-reference-runtime/v2-renderer.worker.js",
  });
  const guardianUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spatialReferenceGuardian);
  return isSourceWorker(workerUrl) || isSourceWorker(guardianUrl) ? "source" : "packaged";
}

async function resolveTsxLoader(parentUrl: string): Promise<{ url: string; sha256: string }> {
  try {
    const require = createRequire(parentUrl);
    const loaderPath = require.resolve("tsx");
    return await urlIdentity(pathToFileURL(loaderPath));
  } catch {
    throw new Error("spatial_v2_renderer_build_unavailable");
  }
}

/**
 * Rebuild the identity from the actual resolved parent and worker artifacts.
 * No caller may substitute a nearby TypeScript source file for a dist worker.
 */
export async function buildSpatialReferenceV2Manifest(
  input: SpatialReferenceV2BuildManifestInput,
): Promise<SpatialReferenceV2BuildManifest> {
  const parentUrl = new URL(input.rendererModuleUrl);
  const workerUrl = resolveRuntimeWorkerUrl({
    currentModuleUrl: parentUrl.href,
    sourceWorkerName: "v2-renderer.worker",
    distWorkerPath: "gateway/media-studio-spatial-reference-runtime/v2-renderer.worker.js",
  });
  const workerArgv = resolveRuntimeWorkerArgv(workerUrl);
  const guardianUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spatialReferenceGuardian);
  const guardianArgv = resolveRuntimeWorkerArgv(guardianUrl);
  const ffprobePath = resolveSystemBin("ffprobe", { trust: "standard" });
  if (!ffprobePath) throw new Error("spatial_v2_renderer_build_unavailable");
  const referenceHostPath = path.join(
    path.dirname(input.referenceRenderHtmlPath),
    "reference_render_host.js",
  );
  const [
    rendererParent,
    rendererWorker,
    guardianWorker,
    referenceRenderHtml,
    referenceRenderHost,
    chromium,
    node,
    ffmpeg,
    ffprobe,
  ] = await Promise.all([
    urlIdentity(parentUrl),
    urlIdentity(workerUrl),
    urlIdentity(guardianUrl),
    urlIdentity(pathToFileURL(input.referenceRenderHtmlPath)),
    urlIdentity(pathToFileURL(referenceHostPath)),
    fileIdentityFromPath(input.chromiumExecutablePath),
    fileIdentityFromPath(process.execPath),
    fileIdentityFromPath(resolveFfmpegBin()),
    fileIdentityFromPath(ffprobePath),
  ]);
  const source = isSourceWorker(workerUrl) || isSourceWorker(guardianUrl);
  const tsxLoader = source ? await resolveTsxLoader(parentUrl.href) : undefined;
  return {
    contractVersion: "spatial_reference_render/v2",
    resourceProfile: input.resourceProfile ?? createSpatialReferenceV2ResourceProfile(),
    execution: {
      mode: source ? "source" : "packaged",
      workerArgv,
      guardianArgv,
      ...(tsxLoader ? { tsxLoader } : {}),
    },
    artifacts: {
      rendererParent,
      rendererWorker,
      guardianWorker,
      referenceRenderHtml,
      referenceRenderHost,
      chromiumExecutable: { ...chromium, identityScope: "executable_entry" },
      nodeExecutable: node,
      ffmpegExecutable: ffmpeg,
      ffprobeExecutable: ffprobe,
    },
    toolchain: input.toolchain,
  };
}

export function spatialReferenceV2BuildDigest(manifest: SpatialReferenceV2BuildManifest): string {
  return digest(manifest);
}
