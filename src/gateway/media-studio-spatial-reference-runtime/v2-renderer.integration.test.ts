import { describe, expect, it } from "vitest";
import type { SpatialReferenceRelayDispatch } from "../media-studio-spatial-reference-render-http.js";
import { createSpatialReferenceV2Renderer } from "./v2-renderer.js";

// Opt-in isolated real tools: never opens the user's browser or installs binaries.
const executable = process.env.SPATIAL_TEST_CHROMIUM;
const html = process.env.SPATIAL_TEST_REFERENCE_HTML;
const config = { chromiumExecutablePath: executable ?? "", referenceRenderHtmlPath: html ?? "" };

function input(
  duration: number,
): Extract<SpatialReferenceRelayDispatch, { contractVersion: "spatial_reference_render/v2" }> {
  const camera = {
    position: { x: 0, y: 2, z: 5 },
    targetPoint: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
  };
  const nodes = [
    {
      nodeId: "wall",
      kind: "prop_placeholder",
      position: { x: 0, y: 1, z: -2 },
      scale: { x: 4, y: 2, z: 0.2 },
    },
    { nodeId: "actor-left", kind: "character_placeholder", position: { x: -0.8, y: 0, z: 0 } },
    { nodeId: "actor-right", kind: "character_placeholder", position: { x: 0.8, y: 0, z: -1 } },
  ];
  const count = Math.ceil((duration * 12) / 1000);
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
      nodes,
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
    outputUploadGrant: {
      purpose: "output_upload",
      grantToken: "unused-test",
      artifactId: "test-frame",
    },
    motionReferenceUploadGrant: {
      purpose: "output_upload",
      grantToken: "unused-test",
      artifactId: "test-motion",
    },
    callback: {
      path: "/v1/control/media-gen/runtime/spatial-reference/callback",
      controlApiBaseUrl: "https://unused.invalid",
    },
    motionReference: {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs: duration,
      encodedDurationMs: Math.round((count * 1000) / 12),
      evaluatorVersion: "spatial_frame_eval/v4",
      frames: Array.from({ length: count }, (_, i) => ({
        timeMs: i === count - 1 ? duration : Math.round((i * 1000) / 12),
        snapshotDigest: `frame-${i}`,
        camera,
        nodes,
      })),
      referenceFrames: [
        {
          slot: "start_frame",
          ordinal: 0,
          sourceTimeMs: 0,
          snapshotDigest: "start",
          camera,
          nodes,
        },
        {
          slot: "end_frame",
          ordinal: 0,
          sourceTimeMs: duration,
          snapshotDigest: "end",
          camera,
          nodes,
        },
        { slot: "topdown_frame", ordinal: 0, snapshotDigest: "top", camera, nodes },
      ],
    },
  };
}

describe.skipIf(!executable || !html)("Spatial isolated real Chromium/Babylon/FFmpeg", () => {
  for (const duration of [1, 83, 84, 9999, 10000]) {
    it(`renders and fully decodes ${duration}ms`, async () => {
      const result = await createSpatialReferenceV2Renderer(config).render(
        input(duration),
        new AbortController().signal,
      );
      expect(result.frameCount).toBe(Math.ceil((duration * 12) / 1000));
      expect(result.motionMp4.subarray(4, 8).toString()).toBe("ftyp");
      expect(result.compositionPng.length).toBeGreaterThan(100);
      expect(result.referencePngs).toHaveLength(3);
      expect(result.evaluatorVersion).toBe("spatial_frame_eval/v4");
    }, 120_000);
  }
  it("rejects 10001ms before browser launch", async () => {
    await expect(
      createSpatialReferenceV2Renderer(config).render(input(10001), new AbortController().signal),
    ).rejects.toThrow("spatial_v2_motion_limits_invalid");
  });
  it("draws geometry rather than only a valid blank PNG and reproduces frozen pixels", async () => {
    const renderer = createSpatialReferenceV2Renderer(config);
    const scene = input(83);
    const first = await renderer.render(scene, new AbortController().signal);
    const again = await renderer.render(scene, new AbortController().signal);
    const empty = input(83);
    empty.blueprint.nodes = [];
    empty.motionReference.frames.forEach((frame) => {
      frame.nodes = [];
    });
    empty.motionReference.referenceFrames?.forEach((frame) => {
      frame.nodes = [];
    });
    const blank = await renderer.render(empty, new AbortController().signal);
    expect(first.compositionPng.equals(blank.compositionPng)).toBe(false);
    expect(first.compositionPng.equals(again.compositionPng)).toBe(true);
    expect(first.referencePngs[0].png.equals(first.compositionPng)).toBe(true);
  }, 120_000);
});
