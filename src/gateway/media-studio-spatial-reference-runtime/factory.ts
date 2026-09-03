/** Environment-owned Spatial reference Runtime + combined capability heartbeat. */
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { SpatialEnvironmentDepthMeshRuntimeExecutor } from "../media-studio-spatial-depth-mesh-render-http.js";
import {
  DEPTH_MESH_ALGORITHM_ID,
  DEPTH_MESH_COMPONENT_MANIFEST_DIGEST,
  DEPTH_MESH_CONTRACT_VERSION,
  DEPTH_MESH_NOTICE_REF,
  DEPTH_MESH_RUNTIME_BUILD_DIGEST,
} from "../media-studio-spatial-depth-mesh-render/types.js";
import type { SpatialEnvironmentPanoramaRuntimeExecutor } from "../media-studio-spatial-environment-render-http.js";
import {
  MODEL_FREE_PANORAMA_ALGORITHM_ID,
  MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST,
  MODEL_FREE_PANORAMA_CONTRACT_VERSION,
  MODEL_FREE_PANORAMA_NOTICE_REF,
  MODEL_FREE_PANORAMA_RUNTIME_BUILD_DIGEST,
} from "../media-studio-spatial-environment-render/types.js";
import type { MediaStudioSpatialReferenceRenderHttpExecutor } from "../media-studio-spatial-reference-render-http.js";
import { createFileDepthMeshCallbackOutbox } from "./depth-mesh-callback-outbox.js";
import { createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor } from "./depth-mesh-executor.js";
import { createMediaStudioSpatialReferenceRuntimeExecutor } from "./executor.js";
import { createFilePanoramaCallbackOutbox } from "./panorama-callback-outbox.js";
import { createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor } from "./panorama-executor.js";

const REGISTER_PATH = "/v1/control/media-gen/runtime/register";
const RUNTIME_TOKEN_HEADER = "x-wisclaw-media-gen-runtime-token";
export const SPATIAL_REFERENCE_RUNTIME_CONTRACT = "spatial_reference_render/v1";
export const SPATIAL_REFERENCE_RUNTIME_BUILD_DIGEST = `sha256:${createHash("sha256")
  .update("openclaw-spatial-reference-render:v1")
  .digest("hex")}`;
export const SPATIAL_ENVIRONMENT_PANORAMA_RUNTIME_CONTRACT = MODEL_FREE_PANORAMA_CONTRACT_VERSION;
export const SPATIAL_ENVIRONMENT_PANORAMA_ALGORITHM = MODEL_FREE_PANORAMA_ALGORITHM_ID;

type RuntimeEnv = Record<string, string | undefined>;
type RuntimeFetch = typeof fetch;

export type SpatialReferenceRuntimeCapability = {
  contractVersion: string;
  rendererBuildDigest: string;
  supportedProfiles: readonly ["proxy_previs"];
  supportedOutputSlots: readonly ["composition_frame"];
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  supportsCancel: true;
};

export type SpatialEnvironmentPanoramaRuntimeCapability = {
  contractVersion: typeof SPATIAL_ENVIRONMENT_PANORAMA_RUNTIME_CONTRACT;
  algorithmId: typeof SPATIAL_ENVIRONMENT_PANORAMA_ALGORITHM;
  projection: "equirectangular_360";
  geometryTruth: "generated_approximate";
  navigationMode: "three_dof";
  supportedOutputSlots: readonly [
    "environment_panorama",
    "generated_region_mask",
    "quality_report",
  ];
  maxOutputWidth: 4096;
  usesTrainedWeights: false;
  modelDependencies: readonly [];
  checkpointDigests: readonly [];
  componentManifestDigest: typeof MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST;
  runtimeBuildDigest: typeof MODEL_FREE_PANORAMA_RUNTIME_BUILD_DIGEST;
  noticeRef: typeof MODEL_FREE_PANORAMA_NOTICE_REF;
  commercialUseAllowed: true;
  allowedTerritories: readonly ["*"];
  deterministic: true;
  /** No public panorama-cancel route is mounted in v1. */
  supportsCancel: false;
};

export type SpatialEnvironmentDepthMeshRuntimeCapability = {
  contractVersion: typeof DEPTH_MESH_CONTRACT_VERSION;
  algorithmId: typeof DEPTH_MESH_ALGORITHM_ID;
  representationKind: "depth_mesh";
  geometryTruth: "generated_approximate";
  navigationMode: "bounded_six_dof";
  supportedSourceSlots: readonly ["source_image", "depth_adapter"];
  supportedOutputSlots: readonly [
    "environment_depth_mesh",
    "generated_region_mask",
    "collision",
    "quality_report",
  ];
  optionalDepthAdapter: true;
  usesTrainedWeights: false;
  modelDependencies: readonly [];
  checkpointDigests: readonly [];
  componentManifestDigest: typeof DEPTH_MESH_COMPONENT_MANIFEST_DIGEST;
  runtimeBuildDigest: typeof DEPTH_MESH_RUNTIME_BUILD_DIGEST;
  noticeRef: typeof DEPTH_MESH_NOTICE_REF;
  commercialUseAllowed: true;
  allowedTerritories: readonly ["*"];
  deterministic: true;
  supportsCancel: false;
};

export type MediaStudioSpatialReferenceRuntimeFromEnv =
  | {
      enabled: true;
      executor: MediaStudioSpatialReferenceRenderHttpExecutor;
      panoramaExecutor: SpatialEnvironmentPanoramaRuntimeExecutor;
      depthMeshExecutor: SpatialEnvironmentDepthMeshRuntimeExecutor;
      capability: SpatialReferenceRuntimeCapability;
      panoramaCapability: SpatialEnvironmentPanoramaRuntimeCapability;
      depthMeshCapability: SpatialEnvironmentDepthMeshRuntimeCapability;
      startHeartbeat: (input?: {
        supportedPresetIds?: string[];
        enforcesModeration?: boolean;
        appliesLabeling?: boolean;
        supportsMultiReference?: boolean;
      }) => () => void;
    }
  | { enabled: false; reason: string };

function envString(env: RuntimeEnv, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function envBool(env: RuntimeEnv, key: string): boolean {
  return /^(1|true|yes|on)$/i.test(env[key]?.trim() ?? "");
}

function envNumber(env: RuntimeEnv, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envList(env: RuntimeEnv, key: string): string[] {
  return (env[key] ?? "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createMediaStudioSpatialReferenceRuntimeFromEnv(
  options: {
    env?: RuntimeEnv;
    fetchImpl?: RuntimeFetch;
    log?: { info?: (message: string) => void; warn?: (message: string) => void };
  } = {},
): MediaStudioSpatialReferenceRuntimeFromEnv {
  const env = options.env ?? process.env;
  if (!envBool(env, "OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED")) {
    return {
      enabled: false,
      reason: "OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED is not set",
    };
  }
  const controlApiUrl = envString(
    env,
    "OPENCLAW_MEDIA_GEN_CONTROL_API_URL",
    "WISCLAW_CONTROL_API_URL",
    "CONTROL_API_BASE_URL",
  );
  const runtimeId = envString(env, "OPENCLAW_MEDIA_GEN_RUNTIME_ID", "MEDIAGEN_RUNTIME_ID");
  const token = envString(
    env,
    "OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN",
    "MEDIAGEN_RUNTIME_REGISTRATION_TOKEN",
  );
  if (!controlApiUrl || !runtimeId || !token) {
    return {
      enabled: false,
      reason: "control-api URL, runtime id, or runtime token is missing",
    };
  }
  const workspaces = envList(env, "OPENCLAW_MEDIA_GEN_WORKSPACE_IDS");
  const heartbeatMs = envNumber(env, "OPENCLAW_MEDIA_GEN_REGISTER_INTERVAL_MS", 60_000);
  const capability: SpatialReferenceRuntimeCapability = {
    contractVersion: SPATIAL_REFERENCE_RUNTIME_CONTRACT,
    rendererBuildDigest: SPATIAL_REFERENCE_RUNTIME_BUILD_DIGEST,
    // Current relay does not redeem source cutout grants. Advertising only
    // proxy_previs keeps reference_composite fail-closed and honest.
    supportedProfiles: ["proxy_previs"],
    supportedOutputSlots: ["composition_frame"],
    maxWidth: 8192,
    maxHeight: 8192,
    maxPixels: 33_554_432,
    supportsCancel: true,
  };
  const panoramaCapability: SpatialEnvironmentPanoramaRuntimeCapability = {
    contractVersion: SPATIAL_ENVIRONMENT_PANORAMA_RUNTIME_CONTRACT,
    algorithmId: SPATIAL_ENVIRONMENT_PANORAMA_ALGORITHM,
    projection: "equirectangular_360",
    geometryTruth: "generated_approximate",
    navigationMode: "three_dof",
    supportedOutputSlots: ["environment_panorama", "generated_region_mask", "quality_report"],
    maxOutputWidth: 4096,
    usesTrainedWeights: false,
    modelDependencies: [],
    checkpointDigests: [],
    componentManifestDigest: MODEL_FREE_PANORAMA_COMPONENT_MANIFEST_DIGEST,
    runtimeBuildDigest: MODEL_FREE_PANORAMA_RUNTIME_BUILD_DIGEST,
    noticeRef: MODEL_FREE_PANORAMA_NOTICE_REF,
    commercialUseAllowed: true,
    allowedTerritories: ["*"],
    deterministic: true,
    // The executor has an internal cancellation fence, but v1 exposes no
    // authenticated panorama-cancel HTTP route. Do not advertise a public
    // capability that Control API cannot invoke.
    supportsCancel: false,
  };
  const depthMeshCapability: SpatialEnvironmentDepthMeshRuntimeCapability = {
    contractVersion: DEPTH_MESH_CONTRACT_VERSION,
    algorithmId: DEPTH_MESH_ALGORITHM_ID,
    representationKind: "depth_mesh",
    geometryTruth: "generated_approximate",
    navigationMode: "bounded_six_dof",
    supportedSourceSlots: ["source_image", "depth_adapter"],
    supportedOutputSlots: [
      "environment_depth_mesh",
      "generated_region_mask",
      "collision",
      "quality_report",
    ],
    optionalDepthAdapter: true,
    usesTrainedWeights: false,
    modelDependencies: [],
    checkpointDigests: [],
    componentManifestDigest: DEPTH_MESH_COMPONENT_MANIFEST_DIGEST,
    runtimeBuildDigest: DEPTH_MESH_RUNTIME_BUILD_DIGEST,
    noticeRef: DEPTH_MESH_NOTICE_REF,
    commercialUseAllowed: true,
    allowedTerritories: ["*"],
    deterministic: true,
    // The executor can fence cancellation internally, but no authenticated
    // depth-mesh cancel route is public in v1.
    supportsCancel: false,
  };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const executor = createMediaStudioSpatialReferenceRuntimeExecutor({
    controlApiUrl,
    runtimeId,
    token,
    fetchImpl,
    log: options.log,
  });
  const panoramaExecutor = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
    controlApiUrl,
    runtimeId,
    token,
    fetchImpl,
    log: options.log,
    callbackOutbox: createFilePanoramaCallbackOutbox({
      filePath: path.join(
        resolveStateDir(env as NodeJS.ProcessEnv),
        "media-studio",
        `spatial-panorama-callback-outbox-${createHash("sha256")
          .update(runtimeId)
          .digest("hex")
          .slice(0, 20)}.json`,
      ),
    }),
  });
  const depthMeshExecutor = createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor({
    controlApiUrl,
    runtimeId,
    token,
    fetchImpl,
    log: options.log,
    callbackOutbox: createFileDepthMeshCallbackOutbox({
      filePath: path.join(
        resolveStateDir(env as NodeJS.ProcessEnv),
        "media-studio",
        `spatial-depth-mesh-callback-outbox-${createHash("sha256")
          .update(runtimeId)
          .digest("hex")
          .slice(0, 20)}.json`,
      ),
    }),
  });

  return {
    enabled: true,
    executor,
    panoramaExecutor,
    depthMeshExecutor,
    capability,
    panoramaCapability,
    depthMeshCapability,
    startHeartbeat(media = {}) {
      if (workspaces.length === 0) {
        options.log?.warn?.(
          "spatial reference runtime enabled but OPENCLAW_MEDIA_GEN_WORKSPACE_IDS is empty; registration heartbeat is disabled",
        );
        return () => {
          panoramaExecutor.stop?.();
          depthMeshExecutor.stop?.();
        };
      }
      let stopped = false;
      const register = () => {
        for (const workspaceId of workspaces) {
          void fetchImpl(`${controlApiUrl.replace(/\/+$/, "")}${REGISTER_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [RUNTIME_TOKEN_HEADER]: token,
            },
            body: JSON.stringify({
              workspaceId,
              runtimeId,
              supportedPresetIds: media.supportedPresetIds ?? [],
              enforcesModeration: media.enforcesModeration === true,
              appliesLabeling: media.appliesLabeling === true,
              ...(media.supportsMultiReference === true ? { supportsMultiReference: true } : {}),
              spatialReferenceRender: capability,
              spatialEnvironmentPanorama: panoramaCapability,
              spatialEnvironmentDepthMesh: depthMeshCapability,
            }),
          })
            .then(async (response) => {
              if (!response.ok) {
                throw new Error(`status ${response.status}`);
              }
              options.log?.info?.(
                `spatial reference runtime heartbeat registered workspace=${workspaceId} runtime=${runtimeId}`,
              );
            })
            .catch((error) => {
              if (!stopped) {
                options.log?.warn?.(
                  `spatial reference runtime heartbeat failed workspace=${workspaceId}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            });
        }
      };
      register();
      const timer = setInterval(register, heartbeatMs);
      return () => {
        stopped = true;
        clearInterval(timer);
        panoramaExecutor.stop?.();
        depthMeshExecutor.stop?.();
      };
    },
  };
}
