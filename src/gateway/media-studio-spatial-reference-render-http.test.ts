import { describe, expect, it } from "vitest";
import { parseSpatialReferenceRelayDispatch } from "./media-studio-spatial-reference-render-http.js";

function relay(contractVersion: "spatial_reference_render/v1" | "spatial_reference_render/v2") {
  const camera = {
    position: { x: 0, y: 1, z: 4 },
    targetPoint: { x: 0, y: 1, z: 0 },
    worldAimTarget: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
  };
  return {
    kind: "media_studio.spatial_reference_render",
    contractVersion,
    workspaceId: "ws_1",
    runtimeId: "runtime_1",
    projectId: "project_1",
    shotId: "shot_1",
    taskId: "task_1",
    materializationId: "mat_1",
    runtimeIdempotencyKey: "spatial:mat_1:disp_1:a1",
    requestId: "request_1",
    attempt: 1,
    dispatchAttemptId: "disp_1",
    sequence: 1,
    leaseExpiresAt: "2027-01-01T00:00:00.000Z",
    intentFingerprint: "intent_1",
    executionFingerprint: "exec_1",
    blueprint: {
      blueprintId: "bp_1",
      version: 1,
      blueprintDigest: "sha256:bp",
      frameAspectRatio: 16 / 9,
      camera,
      nodes: [],
    },
    renderIntent: {
      profile: "proxy_previs",
      width: 320,
      height: 180,
      backgroundPolicy: "neutral_studio",
      rendererContractVersion: contractVersion,
      rendererBuildDigest: "sha256:renderer",
      renderSpecDigest: "sha256:render",
    },
    sourceGrants: [],
    outputUploadGrant: {
      grantToken: "output_frame",
      purpose: "output_upload",
      artifactId: "artifact_frame",
    },
    callback: { path: "/v1/control/media-gen/runtime/spatial-reference/callback" },
  };
}

describe("Spatial reference Runtime relay parser", () => {
  it("keeps v1 composition-only and rejects state(t) fields", () => {
    const v1 = relay("spatial_reference_render/v1");
    expect(parseSpatialReferenceRelayDispatch(v1)?.contractVersion).toBe(
      "spatial_reference_render/v1",
    );
    expect(
      parseSpatialReferenceRelayDispatch({
        ...v1,
        motionReference: { schemaVersion: 1 },
      }),
    ).toBeNull();
  });

  it("requires a complete frozen v2 package while permitting sparse missing-only grants", () => {
    const v2 = relay("spatial_reference_render/v2");
    const parsed = parseSpatialReferenceRelayDispatch({
      ...v2,
      motionReference: {
        schemaVersion: 1,
        fps: 12,
        sourceDurationMs: 83,
        encodedDurationMs: 83,
        evaluatorVersion: "frame-evaluator/v1",
        frames: [
          {
            timeMs: 83,
            snapshotDigest: "sha256:frame",
            camera: v2.blueprint.camera,
            nodes: [],
          },
        ],
        referenceFrames: [
          {
            slot: "start_frame",
            ordinal: 0,
            sourceTimeMs: 0,
            snapshotDigest: "sha256:start",
            camera: v2.blueprint.camera,
            nodes: [],
          },
          {
            slot: "end_frame",
            ordinal: 0,
            sourceTimeMs: 83,
            snapshotDigest: "sha256:end",
            camera: v2.blueprint.camera,
            nodes: [],
          },
          {
            slot: "topdown_frame",
            ordinal: 0,
            snapshotDigest: "sha256:topdown",
            camera: v2.blueprint.camera,
            nodes: [],
          },
        ],
      },
      motionReferenceUploadGrant: {
        grantToken: "output_motion",
        purpose: "output_upload",
        artifactId: "artifact_motion",
      },
      expectedOutputs: [
        {
          slot: "composition_frame",
          ordinal: 0,
          artifactId: "artifact_frame",
          mimeType: "image/png",
        },
        {
          slot: "motion_reference_video",
          ordinal: 0,
          artifactId: "artifact_motion",
          mimeType: "video/mp4",
        },
        {
          slot: "start_frame",
          ordinal: 0,
          sourceTimeMs: 0,
          artifactId: "artifact_start",
          mimeType: "image/png",
        },
        {
          slot: "end_frame",
          ordinal: 0,
          sourceTimeMs: 83,
          artifactId: "artifact_end",
          mimeType: "image/png",
        },
        {
          slot: "topdown_frame",
          ordinal: 0,
          artifactId: "artifact_topdown",
          mimeType: "image/png",
        },
      ],
      outputUploadGrants: [
        {
          grantToken: "output_frame",
          purpose: "output_upload",
          artifactId: "artifact_frame",
          slot: "composition_frame",
          ordinal: 0,
          mimeType: "image/png",
        },
        {
          grantToken: "output_motion",
          purpose: "output_upload",
          artifactId: "artifact_motion",
          slot: "motion_reference_video",
          ordinal: 0,
          mimeType: "video/mp4",
        },
        {
          grantToken: "output_start",
          purpose: "output_upload",
          artifactId: "artifact_start",
          slot: "start_frame",
          ordinal: 0,
          sourceTimeMs: 0,
          mimeType: "image/png",
        },
        {
          grantToken: "output_end",
          purpose: "output_upload",
          artifactId: "artifact_end",
          slot: "end_frame",
          ordinal: 0,
          sourceTimeMs: 83,
          mimeType: "image/png",
        },
        {
          grantToken: "output_topdown",
          purpose: "output_upload",
          artifactId: "artifact_topdown",
          slot: "topdown_frame",
          ordinal: 0,
          mimeType: "image/png",
        },
      ],
    });

    expect(parsed).toMatchObject({
      contractVersion: "spatial_reference_render/v2",
      motionReference: {
        fps: 12,
        frames: [{ timeMs: 83 }],
        referenceFrames: [
          { slot: "start_frame", ordinal: 0, sourceTimeMs: 0 },
          { slot: "end_frame", ordinal: 0, sourceTimeMs: 83 },
          { slot: "topdown_frame", ordinal: 0 },
        ],
      },
      motionReferenceUploadGrant: { artifactId: "artifact_motion" },
    });
    expect(
      parseSpatialReferenceRelayDispatch({
        ...v2,
        motionReference: {
          schemaVersion: 1,
          fps: 12,
          sourceDurationMs: 83,
          encodedDurationMs: 83,
          evaluatorVersion: "frame-evaluator/v1",
          frames: [
            { timeMs: 83, snapshotDigest: "sha256:frame", camera: v2.blueprint.camera, nodes: [] },
          ],
          referenceFrames: [],
        },
        motionReferenceUploadGrant: {
          grantToken: "motion",
          purpose: "output_upload",
          artifactId: "motion",
        },
        outputUploadGrants: [],
      }),
    ).toBeNull();
  });

  it("accepts a fully finalized v2 package with no upload grant", () => {
    const v2 = relay("spatial_reference_render/v2");
    const { outputUploadGrant: _outputUploadGrant, ...terminal } = v2;
    const expectedOutputs = [
      {
        slot: "composition_frame",
        ordinal: 0,
        artifactId: "artifact_frame",
        mimeType: "image/png",
      },
      {
        slot: "motion_reference_video",
        ordinal: 0,
        artifactId: "artifact_motion",
        mimeType: "video/mp4",
      },
      {
        slot: "start_frame",
        ordinal: 0,
        sourceTimeMs: 0,
        artifactId: "artifact_start",
        mimeType: "image/png",
      },
      {
        slot: "end_frame",
        ordinal: 0,
        sourceTimeMs: 83,
        artifactId: "artifact_end",
        mimeType: "image/png",
      },
      { slot: "topdown_frame", ordinal: 0, artifactId: "artifact_topdown", mimeType: "image/png" },
    ] as const;
    const parsed = parseSpatialReferenceRelayDispatch({
      ...terminal,
      motionReference: {
        schemaVersion: 1,
        fps: 12,
        sourceDurationMs: 83,
        encodedDurationMs: 83,
        evaluatorVersion: "frame-evaluator/v1",
        frames: [
          { timeMs: 83, snapshotDigest: "sha256:frame", camera: v2.blueprint.camera, nodes: [] },
        ],
        referenceFrames: [
          {
            slot: "start_frame",
            ordinal: 0,
            sourceTimeMs: 0,
            snapshotDigest: "sha256:start",
            camera: v2.blueprint.camera,
            nodes: [],
          },
          {
            slot: "end_frame",
            ordinal: 0,
            sourceTimeMs: 83,
            snapshotDigest: "sha256:end",
            camera: v2.blueprint.camera,
            nodes: [],
          },
          {
            slot: "topdown_frame",
            ordinal: 0,
            snapshotDigest: "sha256:topdown",
            camera: v2.blueprint.camera,
            nodes: [],
          },
        ],
      },
      expectedOutputs,
      outputUploadGrants: [],
      knownFinalizedReceipts: expectedOutputs.map((output, index) => ({
        ...output,
        size: index + 1,
        sha256Hex: `${index}`.padStart(64, "a"),
        storageKey: `safe/${output.slot}`,
      })),
    });
    expect(parsed).toMatchObject({
      contractVersion: "spatial_reference_render/v2",
      outputUploadGrants: [],
      knownFinalizedReceipts: expect.arrayContaining([
        expect.objectContaining({ slot: "composition_frame", artifactId: "artifact_frame" }),
      ]),
    });
  });
});
