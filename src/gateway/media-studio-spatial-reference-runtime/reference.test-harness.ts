import type { SpatialReferenceRelayDispatch } from "../media-studio-spatial-reference-render-http.js";
export function dispatch(): SpatialReferenceRelayDispatch {
  return {
    kind: "media_studio.spatial_reference_render",
    contractVersion: "spatial_reference_render/v1",
    workspaceId: "ws-1",
    runtimeId: "runtime-1",
    projectId: "project-1",
    shotId: "shot-1",
    taskId: "task-1",
    materializationId: "msfc_demo_t0",
    runtimeIdempotencyKey: "spatial:demo:attempt-1:a1",
    requestId: "request-1",
    attempt: 1,
    dispatchAttemptId: "attempt-1",
    sequence: 1,
    leaseExpiresAt: "2026-07-29T12:00:00.000Z",
    intentFingerprint: "intent-1",
    executionFingerprint: "execution-1",
    blueprint: {
      blueprintId: "blueprint-1",
      version: 1,
      blueprintDigest: "blueprint-digest-1",
      frameAspectRatio: 16 / 9,
      camera: {
        position: { x: 0, y: 1.6, z: 5 },
        targetPoint: { x: 0, y: 1, z: 0 },
        focalLengthMm: 35,
        sensorWidthMm: 36,
      },
      nodes: [
        {
          nodeId: "actor-1",
          kind: "character_placeholder",
          position: { x: 0, y: 0, z: 0 },
        },
      ],
    },
    renderIntent: {
      profile: "proxy_previs",
      width: 320,
      height: 180,
      backgroundPolicy: "neutral_studio",
      rendererContractVersion: "spatial_reference_render/v1",
      rendererBuildDigest: "sha256:build-1",
      renderSpecDigest: "render-spec-1",
    },
    sourceGrants: [],
    outputUploadGrant: {
      grantToken: "upload-grant-1",
      purpose: "output_upload",
      artifactId: "artifact-frame-1",
    },
    callback: {
      path: "/v1/control/media-gen/runtime/spatial-reference/callback",
      controlApiBaseUrl: "https://ignored.example",
    },
  };
}

export function v2Dispatch(): Extract<
  SpatialReferenceRelayDispatch,
  { contractVersion: "spatial_reference_render/v2" }
> {
  const v1 = dispatch();
  return {
    ...v1,
    contractVersion: "spatial_reference_render/v2",
    motionReference: {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs: 83,
      encodedDurationMs: 83,
      evaluatorVersion: "frame-evaluator/v1",
      frames: [
        {
          timeMs: 83,
          snapshotDigest: "frame-1",
          camera: v1.blueprint.camera,
          nodes: v1.blueprint.nodes,
        },
      ],
      referenceFrames: [
        {
          slot: "start_frame",
          ordinal: 0,
          sourceTimeMs: 0,
          snapshotDigest: "reference-start",
          camera: v1.blueprint.camera,
          nodes: v1.blueprint.nodes,
        },
        {
          slot: "end_frame",
          ordinal: 0,
          sourceTimeMs: 83,
          snapshotDigest: "reference-end",
          camera: v1.blueprint.camera,
          nodes: v1.blueprint.nodes,
        },
        {
          slot: "topdown_frame",
          ordinal: 0,
          snapshotDigest: "reference-topdown",
          camera: v1.blueprint.camera,
          nodes: v1.blueprint.nodes,
        },
      ],
    },
    motionReferenceUploadGrant: {
      grantToken: "upload-grant-motion-1",
      purpose: "output_upload",
      artifactId: "artifact-motion-1",
    },
    expectedOutputs: [
      {
        slot: "composition_frame",
        ordinal: 0,
        artifactId: "artifact-frame-1",
        mimeType: "image/png",
      },
      {
        slot: "motion_reference_video",
        ordinal: 0,
        artifactId: "artifact-motion-1",
        mimeType: "video/mp4",
      },
      {
        slot: "start_frame",
        ordinal: 0,
        sourceTimeMs: 0,
        artifactId: "artifact-start-1",
        mimeType: "image/png",
      },
      {
        slot: "end_frame",
        ordinal: 0,
        sourceTimeMs: 83,
        artifactId: "artifact-end-1",
        mimeType: "image/png",
      },
      {
        slot: "topdown_frame",
        ordinal: 0,
        artifactId: "artifact-topdown-1",
        mimeType: "image/png",
      },
    ],
    outputUploadGrants: [
      {
        grantToken: "upload-grant-1",
        purpose: "output_upload",
        artifactId: "artifact-frame-1",
        slot: "composition_frame",
        ordinal: 0,
      },
      {
        grantToken: "upload-grant-motion-1",
        purpose: "output_upload",
        artifactId: "artifact-motion-1",
        slot: "motion_reference_video",
        ordinal: 0,
      },
      {
        grantToken: "upload-grant-start-1",
        purpose: "output_upload",
        artifactId: "artifact-start-1",
        slot: "start_frame",
        ordinal: 0,
        sourceTimeMs: 0,
      },
      {
        grantToken: "upload-grant-end-1",
        purpose: "output_upload",
        artifactId: "artifact-end-1",
        slot: "end_frame",
        ordinal: 0,
        sourceTimeMs: 83,
      },
      {
        grantToken: "upload-grant-topdown-1",
        purpose: "output_upload",
        artifactId: "artifact-topdown-1",
        slot: "topdown_frame",
        ordinal: 0,
      },
    ],
  };
}
