import { describe, expect, it } from "vitest";
import {
  executeSpatialEnvironmentDepthMeshRuntimeRequest,
  parseSpatialEnvironmentDepthMeshRuntimeRequest,
} from "./media-studio-spatial-depth-mesh-render-http.js";

function body() {
  const expiresAt = "2026-08-09T12:15:00.000Z";
  const grant = (slot: string, purpose: "source_download" | "output_upload", mime: string) => ({
    grantToken: `${purpose}-${slot}`,
    purpose,
    slot,
    artifactId: `artifact-${slot}`,
    allowedMimeTypes: [mime],
    ...(purpose === "source_download" ? { expectedSha256Hex: "a".repeat(64) } : {}),
    maxBytes: slot === "depth_adapter" ? 8 : 2048,
    expiresAt,
  });
  return {
    kind: "media_studio.spatial_environment_depth_mesh",
    contractVersion: "spatial_environment_depth_mesh/manual_v1",
    workspaceId: "workspace-a",
    runtimeId: "runtime-a",
    taskId: "task-a",
    materializationId: "mat-a",
    requestFingerprint: "sha256:request",
    executionFingerprint: "sha256:execution",
    dispatchAttemptId: "dispatch-a",
    sequence: 1,
    attempt: 1,
    leaseExpiresAt: expiresAt,
    sourceGrant: grant("source_image", "source_download", "image/png"),
    depthGrant: grant("depth_adapter", "source_download", "application/octet-stream"),
    outputUploadGrants: [
      grant("environment_depth_mesh", "output_upload", "model/gltf-binary"),
      grant("generated_region_mask", "output_upload", "image/png"),
      grant("collision", "output_upload", "application/json"),
      grant("quality_report", "output_upload", "application/json"),
    ],
    calibration: {
      sourceWidthPx: 1600,
      sourceHeightPx: 900,
      orientationNormalized: true,
      horizonYNormalized: 0.44,
      vanishingPointNormalized: { x: 0.5, y: 0.44 },
      walkableRegionNormalized: [
        { x: 0.1, y: 0.9 },
        { x: 0.9, y: 0.9 },
        { x: 0.5, y: 0.5 },
      ],
      focalLengthMm: 35,
      sensorWidthMm: 36,
      relativeDepthRange: { near: 0.75, far: 8 },
      gridResolution: 16,
      confidence: 0.8,
    },
    depthAdapter: {
      contractVersion: "spatial_depth_adapter/output_v1",
      encoding: "normalized_depth_u16le",
      width: 2,
      height: 2,
      confidence: 0.8,
      componentManifestDigest: `sha256:${"b".repeat(64)}`,
      checkpointDigests: [`sha256:${"c".repeat(64)}`],
      noticeRefs: ["NOTICE.adapter"],
    },
  };
}

describe("depth mesh Runtime grant contract", () => {
  it("accepts exact source/depth/output grants and delegates ACK only", async () => {
    const parsed = parseSpatialEnvironmentDepthMeshRuntimeRequest(body());
    expect(parsed).not.toBeNull();
    const result = await executeSpatialEnvironmentDepthMeshRuntimeRequest(parsed!, {
      dispatch: (input) => ({
        ok: true,
        accepted: true,
        deferredSettlement: true,
        runtimeId: input.runtimeId,
        executionId: "execution-a",
        taskId: input.taskId,
        materializationId: input.materializationId,
        requestFingerprint: input.requestFingerprint,
        executionFingerprint: input.executionFingerprint,
        dispatchAttemptId: input.dispatchAttemptId,
        sequence: input.sequence,
        attempt: input.attempt,
        leaseExpiresAt: input.leaseExpiresAt,
      }),
      cancel: () => ({ acknowledged: true, terminal: false }),
    });
    expect(result).toMatchObject({ accepted: true, deferredSettlement: true });
    expect(JSON.stringify(parsed)).not.toMatch(/Base64|"bytes"|https?:\/\//);
  });

  it("fails closed on raw bytes, grant/mime drift, or unpaired adapter metadata", () => {
    expect(
      parseSpatialEnvironmentDepthMeshRuntimeRequest({ ...body(), glbBase64: "AAAA" }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentDepthMeshRuntimeRequest({
        ...body(),
        depthGrant: undefined,
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentDepthMeshRuntimeRequest({
        ...body(),
        outputUploadGrants: body().outputUploadGrants.map((item) =>
          item.slot === "collision" ? { ...item, allowedMimeTypes: ["image/png"] } : item,
        ),
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentDepthMeshRuntimeRequest({
        ...body(),
        outputUploadGrants: body().outputUploadGrants.slice(0, 3),
      }),
    ).toBeNull();
  });
});
