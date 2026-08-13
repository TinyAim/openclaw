import { describe, expect, it } from "vitest";
import {
  executeSpatialEnvironmentPanoramaRuntimeRequest,
  parseSpatialEnvironmentPanoramaRuntimeRequest,
} from "./media-studio-spatial-environment-render-http.js";
import { MODEL_FREE_PANORAMA_CONTRACT_VERSION } from "./media-studio-spatial-environment-render/types.js";

function body() {
  const expiresAt = "2026-08-09T12:15:00.000Z";
  return {
    kind: "media_studio.spatial_environment_panorama",
    contractVersion: MODEL_FREE_PANORAMA_CONTRACT_VERSION,
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
    sourceGrant: {
      grantToken: "source-secret",
      purpose: "source_download",
      slot: "source_image",
      artifactId: "source-artifact",
      allowedMimeTypes: ["image/png"],
      expectedSha256Hex: "a".repeat(64),
      maxBytes: 1024,
      expiresAt,
    },
    outputUploadGrants: [
      ["environment_panorama", "image/png"],
      ["generated_region_mask", "image/png"],
      ["quality_report", "application/json"],
    ].map(([slot, mimeType]) => ({
      grantToken: `output-${slot}`,
      purpose: "output_upload",
      slot,
      artifactId: `artifact-${slot}`,
      allowedMimeTypes: [mimeType],
      maxBytes: 2048,
      expiresAt,
    })),
    horizontalFovDegrees: 75,
    outputWidth: 256,
    centerYawDegrees: 10,
  };
}

describe("model-free panorama Runtime HTTP contract", () => {
  it("strictly parses grants and delegates an ACK-only dispatch", async () => {
    const parsed = parseSpatialEnvironmentPanoramaRuntimeRequest(body());
    expect(parsed).not.toBeNull();
    const result = await executeSpatialEnvironmentPanoramaRuntimeRequest(parsed!, {
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
    expect(result).toMatchObject({
      accepted: true,
      deferredSettlement: true,
      executionId: "execution-a",
    });
    expect(JSON.stringify(parsed)).not.toMatch(/sourceImageBase64|pngBase64/);
  });

  it("fails closed on contract drift, bytes, or incomplete output grants", () => {
    expect(
      parseSpatialEnvironmentPanoramaRuntimeRequest({
        ...body(),
        contractVersion: "future",
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentPanoramaRuntimeRequest({
        ...body(),
        sourceImageBase64: "AAAA",
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentPanoramaRuntimeRequest({
        ...body(),
        outputUploadGrants: body().outputUploadGrants.slice(0, 2),
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentPanoramaRuntimeRequest({
        ...body(),
        sequence: 0,
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentPanoramaRuntimeRequest({
        ...body(),
        sourceGrant: {
          ...body().sourceGrant,
          allowedMimeTypes: ["text/plain"],
        },
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentPanoramaRuntimeRequest({
        ...body(),
        outputUploadGrants: body().outputUploadGrants.map((grant, index) =>
          index === 0 ? { ...grant, allowedMimeTypes: ["image/jpeg"] } : grant,
        ),
      }),
    ).toBeNull();
    expect(
      parseSpatialEnvironmentPanoramaRuntimeRequest({
        ...body(),
        sourceGrant: {
          ...body().sourceGrant,
          expiresAt: "2026-08-09T12:16:00.000Z",
        },
      }),
    ).toBeNull();
  });
});
