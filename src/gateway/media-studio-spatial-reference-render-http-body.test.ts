import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMediaStudioSpatialReferenceRenderHttpRequest,
  MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH,
  MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH,
  type MediaStudioSpatialReferenceRenderHttpOptions,
  type SpatialReferenceRelayDispatch,
} from "./media-studio-spatial-reference-render-http.js";

const MIB = 1024 * 1024;

function movingPackage() {
  const camera = {
    position: { x: 0, y: 2, z: 6 },
    targetPoint: { x: 0, y: 1, z: 0 },
    worldAimTarget: { x: 0, y: 1, z: 0 },
    focalLengthMm: 35,
    sensorWidthMm: 36,
  };
  const nodes = Array.from({ length: 25 }, (_, index) => ({
    nodeId: `moving-node-${index}`,
    kind: "primitive",
    primitiveType: "box",
    label: `Moving scene component ${index}`,
    position: { x: index, y: 0, z: 0 },
    orientationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 2, z: 1 },
  }));
  const frame = (timeMs: number) => ({
    timeMs,
    snapshotDigest: `snapshot-${timeMs}`,
    camera,
    nodes: nodes.map((node) => ({ ...node, position: { ...node.position, z: timeMs / 30_000 } })),
  });
  const outputs = [
    { slot: "composition_frame", ordinal: 0, artifactId: "composition", mimeType: "image/png" },
    { slot: "motion_reference_video", ordinal: 0, artifactId: "motion", mimeType: "video/mp4" },
    {
      slot: "start_frame",
      ordinal: 0,
      artifactId: "start",
      mimeType: "image/png",
      sourceTimeMs: 0,
    },
    {
      slot: "end_frame",
      ordinal: 0,
      artifactId: "end",
      mimeType: "image/png",
      sourceTimeMs: 30_000,
    },
    { slot: "topdown_frame", ordinal: 0, artifactId: "topdown", mimeType: "image/png" },
  ];
  const grants = outputs.map((output) => ({
    ...output,
    purpose: "output_upload",
    grantToken: `grant-${output.artifactId}`,
  }));
  return {
    kind: "media_studio.spatial_reference_render",
    contractVersion: "spatial_reference_render/v2",
    workspaceId: "workspace",
    runtimeId: "runtime",
    projectId: "project",
    shotId: "shot",
    taskId: "task",
    materializationId: "materialization",
    runtimeIdempotencyKey: "runtime-key",
    requestId: "request",
    attempt: 1,
    dispatchAttemptId: "dispatch",
    sequence: 1,
    leaseExpiresAt: "2027-01-01T00:00:00.000Z",
    intentFingerprint: "intent",
    executionFingerprint: "execution",
    blueprint: {
      blueprintId: "blueprint",
      version: 1,
      blueprintDigest: "sha256:blueprint",
      frameAspectRatio: 16 / 9,
      camera,
      nodes,
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
    outputUploadGrant: grants[0],
    outputUploadGrants: grants,
    motionReferenceUploadGrant: grants[1],
    expectedOutputs: outputs,
    motionReference: {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs: 30_000,
      encodedDurationMs: 30_000,
      evaluatorVersion: "spatial_frame_eval/v4",
      frames: Array.from({ length: 360 }, (_, index) =>
        frame(index === 359 ? 30_000 : Math.round((index * 1000) / 12)),
      ),
      referenceFrames: [
        { ...frame(0), slot: "start_frame", ordinal: 0, sourceTimeMs: 0 },
        { ...frame(30_000), slot: "end_frame", ordinal: 0, sourceTimeMs: 30_000 },
        { ...frame(0), slot: "topdown_frame", ordinal: 0 },
      ],
    },
    callback: { path: "/v1/control/media-gen/runtime/spatial-reference/callback" },
  };
}

describe("Spatial reference render HTTP body budget", () => {
  const dispatch = vi.fn((input: SpatialReferenceRelayDispatch) => ({
    ok: true as const,
    accepted: true as const,
    deferredSettlement: true as const,
    runtimeId: input.runtimeId,
    executionId: "execution-id",
    taskId: input.taskId,
    materializationId: input.materializationId,
    attempt: input.attempt,
    dispatchAttemptId: input.dispatchAttemptId,
    sequence: input.sequence,
    leaseExpiresAt: input.leaseExpiresAt,
    intentFingerprint: input.intentFingerprint,
    executionFingerprint: input.executionFingerprint,
    blueprintDigest: input.blueprint.blueprintDigest,
  }));
  const cancel = vi.fn(() => ({ acknowledged: true, terminal: false }));
  const options: MediaStudioSpatialReferenceRenderHttpOptions = {
    auth: { mode: "token", token: "test-token", allowTailscale: false },
    executor: { dispatch, cancel },
  };
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleMediaStudioSpatialReferenceRenderHttpRequest(req, res, options)
        .then((handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end();
          }
        })
        .catch(() => {
          res.statusCode = 500;
          res.end();
        });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  beforeEach(() => {
    dispatch.mockClear();
    cancel.mockClear();
    delete options.maxBodyBytes;
  });
  const post = (path: string, body: string, authorized = true) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: "Bearer test-token" } : {}),
      },
      body,
    });

  it("accepts the complete 30-second, 360-frame package above the old 1 MiB ceiling", async () => {
    const input = movingPackage();
    const body = JSON.stringify(input);
    expect(Buffer.byteLength(body)).toBeGreaterThan(MIB);
    const response = await post(MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH, body);
    expect(response.status).toBe(202);
    expect(dispatch).toHaveBeenCalledOnce();
    const accepted = dispatch.mock.calls[0]![0];
    expect(accepted.motionReference?.frames).toHaveLength(360);
    expect(accepted.motionReference?.frames.at(-1)?.timeMs).toBe(30_000);
    expect(accepted.motionReference?.frames.at(-1)?.nodes).toEqual(
      input.motionReference.frames.at(-1)?.nodes,
    );
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    [MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH, 8 * MIB],
    [MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH, MIB],
  ])("keeps the bounded ceiling for %s", async (path, maxBytes) => {
    const response = await post(path, JSON.stringify({ padding: "x".repeat(maxBytes) }));
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(dispatch).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("still authenticates a large render request before parsing or dispatching", async () => {
    const response = await post(
      MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH,
      JSON.stringify(movingPackage()),
      false,
    );
    expect(response.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("preserves a caller-supplied stricter body limit", async () => {
    options.maxBodyBytes = 512;
    const response = await post(
      MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH,
      JSON.stringify(movingPackage()),
    );
    expect(response.status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
