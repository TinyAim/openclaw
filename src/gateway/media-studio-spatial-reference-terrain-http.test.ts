import { describe, expect, it } from "vitest";
import { parseSpatialReferenceRelayDispatch } from "./media-studio-spatial-reference-render-http.js";
import { mergeSpatialFrozenNodes } from "./media-studio-spatial-reference-runtime/frozen-scene.js";

const terrain = {
  schemaVersion: 1,
  points: [
    { x: 0, y: 0.5, z: 0 },
    { x: 20, y: 8, z: 10 },
  ],
  widthM: 6,
  depthM: 2,
};

function request() {
  const camera = {
    position: { x: 0, y: 2, z: 4 },
    targetPoint: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
  };
  const node = {
    nodeId: "ground",
    kind: "primitive",
    primitiveType: "floor",
    position: { x: 0, y: 0, z: 0 },
    terrainProfile: terrain,
  };
  const grant = (artifactId: string) => ({
    artifactId,
    purpose: "output_upload",
    grantToken: `grant_${artifactId}`,
  });
  const referenceFrames = [
    {
      slot: "start_frame",
      ordinal: 0,
      sourceTimeMs: 0,
      snapshotDigest: "sha256:start",
      camera,
      nodes: [node],
    },
    {
      slot: "end_frame",
      ordinal: 0,
      sourceTimeMs: 83,
      snapshotDigest: "sha256:end",
      camera,
      nodes: [node],
    },
    { slot: "topdown_frame", ordinal: 0, snapshotDigest: "sha256:topdown", camera, nodes: [node] },
  ];
  const expectedOutputs = [
    { slot: "composition_frame", ordinal: 0, artifactId: "frame", mimeType: "image/png" },
    { slot: "motion_reference_video", ordinal: 0, artifactId: "video", mimeType: "video/mp4" },
    ...referenceFrames.map(({ slot, ordinal, sourceTimeMs }) => ({
      slot,
      ordinal,
      artifactId: slot,
      mimeType: "image/png",
      ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
    })),
  ];
  return {
    kind: "media_studio.spatial_reference_render",
    contractVersion: "spatial_reference_render/v2",
    workspaceId: "ws",
    runtimeId: "runtime",
    projectId: "project",
    shotId: "shot",
    taskId: "task",
    materializationId: "materialization",
    runtimeIdempotencyKey: "intent",
    requestId: "request",
    attempt: 1,
    dispatchAttemptId: "dispatch",
    sequence: 1,
    leaseExpiresAt: "2027-01-01T00:00:00.000Z",
    intentFingerprint: "intent_digest",
    executionFingerprint: "execution_digest",
    blueprint: {
      blueprintId: "blueprint",
      version: 1,
      blueprintDigest: "sha256:blueprint",
      frameAspectRatio: 16 / 9,
      camera,
      nodes: [node],
    },
    renderIntent: {
      profile: "proxy_previs",
      width: 320,
      height: 180,
      backgroundPolicy: "neutral_studio",
      rendererContractVersion: "spatial_reference_render/v2",
      rendererBuildDigest: "sha256:renderer",
      renderSpecDigest: "sha256:spec",
    },
    sourceGrants: [],
    outputUploadGrant: grant("frame"),
    motionReferenceUploadGrant: grant("video"),
    expectedOutputs,
    outputUploadGrants: expectedOutputs.map((output) => ({
      ...grant(output.artifactId),
      ...output,
    })),
    motionReference: {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs: 83,
      encodedDurationMs: 83,
      evaluatorVersion: "frame-evaluator/v4",
      referenceFrames,
      frames: [
        {
          timeMs: 83,
          snapshotDigest: "sha256:frame",
          camera,
          nodes: [{ nodeId: "ground", kind: "primitive", position: { x: 1, y: 0, z: 0 } }],
        },
      ],
    },
    callback: { path: "/v1/control/media-gen/runtime/spatial-reference/callback" },
  };
}

describe("terrain relay admission and frozen geometry inheritance", () => {
  it("retains closed static geometry and inherits it when a frozen frame changes only TRS", () => {
    const parsed = parseSpatialReferenceRelayDispatch(request());
    expect(parsed?.contractVersion).toBe("spatial_reference_render/v2");
    if (!parsed || parsed.contractVersion !== "spatial_reference_render/v2")
      throw new Error("terrain fixture rejected");
    expect(parsed.blueprint.nodes[0]?.terrainProfile).toEqual(terrain);
    expect(parsed.motionReference.referenceFrames?.[0]?.nodes[0]?.terrainProfile).toEqual(terrain);
    const merged = mergeSpatialFrozenNodes(
      parsed.blueprint.nodes,
      parsed.motionReference.frames[0].nodes,
    );
    expect(merged[0]?.terrainProfile).toEqual(terrain);
    expect(merged[0]?.position).toEqual({ x: 1, y: 0, z: 0 });
    expect(parsed.blueprint.nodes[0]?.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it.each([
    { ...terrain, schemaVersion: 2 },
    { ...terrain, widthM: 101 },
    { ...terrain, depthM: -1 },
    {
      ...terrain,
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 2, z: 0 },
      ],
    },
    { ...terrain, meshUrl: "https://untrusted.invalid/mesh" },
    {
      ...terrain,
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 1, z: 0 },
        { x: 0, y: 2, z: 0 },
      ],
    },
    {
      ...terrain,
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 1, z: 0 },
        { x: 5, y: 2, z: 0 },
      ],
    },
  ])("rejects invalid or smuggled terrain rather than silently dropping it", (profile) => {
    const body = request();
    expect(
      parseSpatialReferenceRelayDispatch({
        ...body,
        blueprint: {
          ...body.blueprint,
          nodes: [{ ...body.blueprint.nodes[0], terrainProfile: profile }],
        },
      }),
    ).toBeNull();
  });

  it("rejects profiles on non-floor nodes and malformed per-frame geometry", () => {
    const body = request();
    expect(
      parseSpatialReferenceRelayDispatch({
        ...body,
        blueprint: {
          ...body.blueprint,
          nodes: [{ ...body.blueprint.nodes[0], primitiveType: "box" }],
        },
      }),
    ).toBeNull();
    expect(
      parseSpatialReferenceRelayDispatch({
        ...body,
        motionReference: {
          ...body.motionReference,
          frames: [
            {
              ...body.motionReference.frames[0],
              nodes: [{ ...body.blueprint.nodes[0], terrainProfile: { ...terrain, points: [] } }],
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("refuses legacy v1 terrain composition before rendering", () => {
    const body = request();
    const {
      motionReference: _motion,
      motionReferenceUploadGrant: _motionGrant,
      expectedOutputs: _outputs,
      outputUploadGrants: _grants,
      ...v1
    } = body;
    expect(
      parseSpatialReferenceRelayDispatch({
        ...v1,
        contractVersion: "spatial_reference_render/v1",
        renderIntent: {
          ...v1.renderIntent,
          rendererContractVersion: "spatial_reference_render/v1",
        },
      }),
    ).toBeNull();
  });
});
