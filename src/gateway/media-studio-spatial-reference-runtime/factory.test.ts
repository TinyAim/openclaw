import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMediaStudioSpatialReferenceRuntimeFromEnv } from "./factory.js";

describe("Spatial reference Runtime env factory", () => {
  it("publishes one combined workspace heartbeat with honest Spatial capability", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const runtime = await createMediaStudioSpatialReferenceRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "ws-1",
        OPENCLAW_MEDIA_GEN_REGISTER_INTERVAL_MS: "60000",
      },
      fetchImpl,
    });
    expect(runtime.enabled).toBe(true);
    if (!runtime.enabled) return;
    expect(runtime.depthMeshExecutor).toBeDefined();
    expect(runtime.depthMeshCapability).toMatchObject({
      representationKind: "depth_mesh",
      geometryTruth: "generated_approximate",
      navigationMode: "bounded_six_dof",
      supportsCancel: false,
    });

    const stop = runtime.startHeartbeat({
      supportedPresetIds: ["vidu"],
      enforcesModeration: true,
      appliesLabeling: true,
      supportsMultiReference: true,
    });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    stop();

    expect(bodies[0]).toMatchObject({
      workspaceId: "ws-1",
      runtimeId: "runtime-1",
      supportedPresetIds: ["vidu"],
      enforcesModeration: true,
      appliesLabeling: true,
      supportsMultiReference: true,
      spatialReferenceRender: {
        contractVersion: "spatial_reference_render/v1",
        supportedProfiles: ["proxy_previs"],
        supportedOutputSlots: ["composition_frame"],
        supportsCancel: true,
      },
      spatialEnvironmentPanorama: {
        contractVersion: "spatial_environment_panorama/model_free_v1",
        algorithmId: "wisclaw.model_free_panorama_reflection_quilt/v1",
        projection: "equirectangular_360",
        geometryTruth: "generated_approximate",
        navigationMode: "three_dof",
        supportedOutputSlots: ["environment_panorama", "generated_region_mask", "quality_report"],
        maxOutputWidth: 4096,
        usesTrainedWeights: false,
        modelDependencies: [],
        deterministic: true,
        supportsCancel: false,
      },
      spatialEnvironmentDepthMesh: {
        contractVersion: "spatial_environment_depth_mesh/manual_v1",
        algorithmId: "wisclaw.deterministic_layered_depth_mesh/v1",
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
        deterministic: true,
        supportsCancel: false,
      },
    });
  });

  it("fails closed without explicit enable or machine credentials", async () => {
    await expect(
      createMediaStudioSpatialReferenceRuntimeFromEnv({ env: {} }),
    ).resolves.toMatchObject({
      enabled: false,
    });
    await expect(
      createMediaStudioSpatialReferenceRuntimeFromEnv({
        env: { OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED: "1" },
      }),
    ).resolves.toMatchObject({ enabled: false, reason: expect.stringContaining("missing") });
    await expect(
      createMediaStudioSpatialReferenceRuntimeFromEnv({
        env: {
          OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED: "1",
          OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_V2_ENABLED: "1",
          OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
          OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
          OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        },
      }),
    ).resolves.toMatchObject({
      enabled: false,
      reason: expect.stringContaining("v2 bundle directory or Chromium executable"),
    });
  });

  it("does not probe a source/tsx worker as though it were a packaged Runtime", async () => {
    const runtime = await createMediaStudioSpatialReferenceRuntimeFromEnv({
      env: {
        OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED: "1",
        OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_V2_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-1",
        OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_BUNDLE_DIR: path.resolve(
          process.cwd(),
          "../../../apps/control_surface/spatial_babylon/dist",
        ),
        // The assertion is evaluated before Chromium probing, so an existing
        // non-Chromium executable is enough to prove source mode is rejected.
        OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_CHROMIUM_PATH: process.execPath,
      },
    });
    expect(runtime).toMatchObject({
      enabled: false,
      reason: "v2 packaged renderer worker is unavailable",
    });
  });
});
