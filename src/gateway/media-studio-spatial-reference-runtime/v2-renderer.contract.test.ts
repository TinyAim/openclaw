import { describe, expect, it } from "vitest";
import {
  assertSpatialReferenceV2MissingOutputs,
  createSpatialReferenceV2RenderInput,
  expectedSpatialReferenceV2Outputs,
  type SpatialReferenceV2Input,
} from "./v2-renderer.contract.js";

function input(): SpatialReferenceV2Input {
  const camera = {
    position: { x: 0, y: 2, z: 5 },
    targetPoint: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
  };
  return {
    kind: "media_studio.spatial_reference_render",
    contractVersion: "spatial_reference_render/v2",
    workspaceId: "test-workspace",
    runtimeId: "test-runtime",
    projectId: "test-project",
    shotId: "test-shot",
    taskId: "test-task",
    materializationId: "test-materialization",
    runtimeIdempotencyKey: "test-key",
    requestId: "test-request",
    attempt: 1,
    dispatchAttemptId: "test-attempt",
    sequence: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    intentFingerprint: "test-intent",
    executionFingerprint: "test-execution",
    blueprint: {
      blueprintId: "test-blueprint",
      version: 1,
      blueprintDigest: "test-digest",
      frameAspectRatio: 16 / 9,
      camera,
      nodes: [],
    },
    renderIntent: {
      profile: "proxy_previs",
      width: 160,
      height: 90,
      backgroundPolicy: "neutral_studio",
      rendererContractVersion: "spatial_reference_render/v2",
      rendererBuildDigest: "sha256:test",
      renderSpecDigest: "test-spec",
    },
    sourceGrants: [],
    outputUploadGrant: { purpose: "output_upload", grantToken: "unused", artifactId: "frame" },
    motionReferenceUploadGrant: {
      purpose: "output_upload",
      grantToken: "unused",
      artifactId: "motion",
    },
    callback: {
      path: "/v1/control/media-gen/runtime/spatial-reference/callback",
      controlApiBaseUrl: "https://unused.invalid",
    },
    motionReference: {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs: 84,
      encodedDurationMs: 167,
      evaluatorVersion: "spatial_frame_eval/v4",
      frames: [
        { timeMs: 0, snapshotDigest: "f0", camera, nodes: [] },
        { timeMs: 84, snapshotDigest: "f1", camera, nodes: [] },
      ],
      referenceFrames: [
        {
          slot: "start_frame",
          ordinal: 0,
          sourceTimeMs: 0,
          snapshotDigest: "start",
          camera,
          nodes: [],
        },
        {
          slot: "end_frame",
          ordinal: 0,
          sourceTimeMs: 84,
          snapshotDigest: "end",
          camera,
          nodes: [],
        },
        { slot: "topdown_frame", ordinal: 0, snapshotDigest: "top", camera, nodes: [] },
        {
          slot: "keyframe",
          ordinal: 2,
          sourceTimeMs: 42,
          snapshotDigest: "key",
          camera,
          nodes: [],
        },
      ],
    },
  };
}

describe("spatial v2 missing output plan", () => {
  it("enumerates the closed full package and permits a sparse recovery subset", () => {
    const frozen = input();
    expect(expectedSpatialReferenceV2Outputs(frozen)).toEqual([
      { slot: "composition_frame", ordinal: 0 },
      { slot: "motion_reference_video", ordinal: 0 },
      { slot: "start_frame", ordinal: 0 },
      { slot: "end_frame", ordinal: 0 },
      { slot: "topdown_frame", ordinal: 0 },
      { slot: "keyframe", ordinal: 2 },
    ]);
    expect(() =>
      assertSpatialReferenceV2MissingOutputs(frozen, [
        { slot: "motion_reference_video", ordinal: 0 },
        { slot: "keyframe", ordinal: 2 },
      ]),
    ).not.toThrow();
  });

  it("rejects an already-finalized-shaped duplicate or invented slot before a worker starts", () => {
    const frozen = input();
    expect(() =>
      assertSpatialReferenceV2MissingOutputs(frozen, [
        { slot: "start_frame", ordinal: 0 },
        { slot: "start_frame", ordinal: 0 },
      ]),
    ).toThrow("spatial_v2_missing_output_plan_invalid");
    expect(() =>
      assertSpatialReferenceV2MissingOutputs(frozen, [{ slot: "keyframe", ordinal: 3 }]),
    ).toThrow("spatial_v2_missing_output_plan_invalid");
  });

  it("projects no tenant, callback, or grant secret into the worker payload", () => {
    const serialized = JSON.stringify(createSpatialReferenceV2RenderInput(input()));
    for (const forbidden of [
      "test-workspace",
      "test-runtime",
      "unused",
      "grantToken",
      "sourceGrants",
      "controlApiBaseUrl",
      "callback",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("blueprint");
    expect(serialized).toContain("motionReference");
  });
});
