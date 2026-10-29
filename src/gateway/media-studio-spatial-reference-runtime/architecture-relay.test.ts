import { describe, expect, it } from "vitest";
import { parseSpatialReferenceRelayDispatch } from "../media-studio-spatial-reference-render-http.js";
import { parseSpatialReferenceComponentSpec } from "./component-spec.js";
import { spatialReferenceWorldGeometryWithinBudget } from "./world-geometry-budget.js";
import type { MediaSpatialComponentSpec } from "./world-spec-types.js";

const window: MediaSpatialComponentSpec = {
  schemaVersion: 1,
  kind: "architecture",
  profile: "window_wall",
  size: { x: 4, y: 3, z: 0.2 },
  openingWidthM: 1.2,
  openingHeightM: 1,
  sillHeightM: 1,
};
const roof: MediaSpatialComponentSpec = {
  schemaVersion: 1,
  kind: "architecture",
  profile: "gable_roof",
  size: { x: 6, y: 1.4, z: 8 },
  thicknessM: 0.2,
};
const node = (componentSpec: unknown) => ({
  nodeId: "architecture",
  kind: "primitive",
  primitiveType: "box",
  position: { x: 0, y: 3, z: 0 },
  componentSpec,
});
function request(n: ReturnType<typeof node>) {
  const camera = {
    position: { x: 0, y: 2, z: 4 },
    targetPoint: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
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
      nodes: [n],
    },
    {
      slot: "end_frame",
      ordinal: 0,
      sourceTimeMs: 83,
      snapshotDigest: "sha256:end",
      camera,
      nodes: [n],
    },
    { slot: "topdown_frame", ordinal: 0, snapshotDigest: "sha256:topdown", camera, nodes: [n] },
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
      nodes: [n],
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
          nodes: [{ nodeId: n.nodeId, kind: "primitive", position: { x: 1, y: 3, z: 0 } }],
        },
      ],
    },
    callback: { path: "/v1/control/media-gen/runtime/spatial-reference/callback" },
  };
}

describe("Native v2 closed architecture recipe admission", () => {
  it.each([window, roof])(
    "retains $profile through blueprint and frozen reference frames",
    (spec) => {
      expect(parseSpatialReferenceComponentSpec(spec)).toEqual(spec);
      const parsed = parseSpatialReferenceRelayDispatch(request(node(spec)));
      expect(parsed?.contractVersion).toBe("spatial_reference_render/v2");
      if (parsed?.contractVersion !== "spatial_reference_render/v2")
        throw Error("architecture fixture rejected");
      expect(parsed.blueprint.nodes[0]?.componentSpec).toEqual(spec);
      expect(parsed.motionReference.referenceFrames?.[0]?.nodes[0]?.componentSpec).toEqual(spec);
    },
  );
  it("rejects unknown parameters, invalid dimensions, profiles and carrier combinations", () => {
    for (const spec of [
      { ...window, profile: "arched_window" },
      { ...window, vertices: [] },
      { ...window, openingWidthM: 4 },
      { ...window, openingHeightM: 3 },
      { ...window, sillHeightM: 0 },
      { ...window, sillHeightM: 2.1 },
      { ...roof, thicknessM: 1.4 },
      { ...roof, thicknessM: 0 },
      { ...roof, size: { x: 6, y: 1.4, z: 0.1 } },
    ]) {
      expect(parseSpatialReferenceComponentSpec(spec)).toBeUndefined();
      expect(parseSpatialReferenceRelayDispatch(request(node(spec)))).toBeNull();
    }
    for (const patch of [
      { primitiveType: "floor" },
      { kind: "prop_placeholder", propType: "rock" },
      {
        terrainSurface: {
          schemaVersion: 1,
          kind: "heightfield",
          origin: { x: 0, y: 0, z: 0 },
          widthM: 4,
          lengthM: 3,
          depthM: 0.2,
          rows: 2,
          columns: 2,
          heightsM: [0, 0, 0, 0],
        },
      },
    ]) {
      expect(parseSpatialReferenceRelayDispatch(request({ ...node(window), ...patch }))).toBeNull();
    }
  });
  it("charges four actual parts per recipe and does not hide excess parts in at most 64 logical nodes", () => {
    expect(
      spatialReferenceWorldGeometryWithinBudget(Array(64).fill({ componentSpec: window })),
    ).toBe(true);
    const tree: MediaSpatialComponentSpec = {
      schemaVersion: 1,
      kind: "tree",
      trunk: {
        partId: "trunk",
        start: { x: 0, y: 0, z: 0 },
        end: { x: 0, y: 3, z: 0 },
        startRadiusM: 0.2,
        endRadiusM: 0.1,
      },
      branches: [],
      roots: [],
      crowns: Array.from({ length: 8 }, (_, i) => ({
        partId: `crown_${i}`,
        center: { x: 0, y: 2, z: 0 },
        radiiM: { x: 1, y: 1, z: 1 },
      })),
    };
    expect(parseSpatialReferenceComponentSpec(tree)).toBeDefined();
    const nodes = [
      ...Array(60).fill({ componentSpec: window }),
      { componentSpec: tree },
      { componentSpec: tree },
    ];
    expect(nodes).toHaveLength(62);
    expect(spatialReferenceWorldGeometryWithinBudget(nodes)).toBe(false);
    expect(spatialReferenceWorldGeometryWithinBudget(Array(65).fill({ componentSpec: roof }))).toBe(
      false,
    );
  });
});
