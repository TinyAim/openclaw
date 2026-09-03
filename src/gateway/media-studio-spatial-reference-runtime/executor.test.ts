import { describe, expect, it, vi } from "vitest";
import type { SpatialReferenceRelayDispatch } from "../media-studio-spatial-reference-render-http.js";
import { createMediaStudioSpatialReferenceRuntimeExecutor } from "./executor.js";

function dispatch(): SpatialReferenceRelayDispatch {
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

describe("Media Studio Spatial reference Runtime executor", () => {
  it("renders, uploads bytes, and posts receipt-only callback", async () => {
    const callbacks: Array<Record<string, unknown>> = [];
    let uploaded: Buffer | undefined;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/upload")) {
        uploaded = init?.body as unknown as Buffer;
        const { createHash } = await import("node:crypto");
        const sha256Hex = createHash("sha256").update(uploaded).digest("hex");
        return new Response(
          JSON.stringify({
            data: {
              artifactId: "artifact-frame-1",
              storageKey: "artifacts/spatial/frame.png",
              size: uploaded.length,
              sha256Hex,
              mimeType: "image/png",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.endsWith("/spatial-reference/callback")) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { accepted: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const executor = createMediaStudioSpatialReferenceRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-1",
      token: "runtime-token",
      fetchImpl,
    });

    const ack = await executor.dispatch(dispatch());
    expect(ack).toMatchObject({
      ok: true,
      accepted: true,
      deferredSettlement: true,
      taskId: "task-1",
    });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));

    expect(uploaded?.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(callbacks[0]).toMatchObject({
      kind: "media_studio.spatial_reference_render.callback",
      status: "succeeded",
      taskId: "task-1",
      materializationId: "msfc_demo_t0",
      receipt: {
        artifactId: "artifact-frame-1",
        mimeType: "image/png",
        profile: "proxy_previs",
        rendererContractVersion: "spatial_reference_render/v1",
      },
    });
    expect(JSON.stringify(callbacks[0])).not.toMatch(/pngBase64|"png"|"bytes"/);
    const uploadCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/spatial-reference/upload"),
    );
    expect(uploadCall?.[1]?.headers).toMatchObject({
      "x-wisclaw-media-gen-runtime-token": "runtime-token",
      "x-wisclaw-spatial-upload-grant": "upload-grant-1",
    });
  });

  it("deduplicates a repeated runtime idempotency key", async () => {
    let uploadCount = 0;
    let callbackCount = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/spatial-reference/upload")) {
        uploadCount += 1;
        const bytes = init?.body as unknown as Buffer;
        const { createHash } = await import("node:crypto");
        return new Response(
          JSON.stringify({
            data: {
              artifactId: "artifact-frame-1",
              storageKey: "artifacts/spatial/frame.png",
              size: bytes.length,
              sha256Hex: createHash("sha256").update(bytes).digest("hex"),
              mimeType: "image/png",
            },
          }),
          { status: 200 },
        );
      }
      callbackCount += 1;
      return new Response(JSON.stringify({ data: { accepted: true } }), {
        status: 200,
      });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const executor = createMediaStudioSpatialReferenceRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-1",
      token: "runtime-token",
      fetchImpl,
    });
    const input = dispatch();

    const first = await executor.dispatch(input);
    const second = await executor.dispatch(input);
    expect(second).toEqual(first);
    await vi.waitFor(() => expect(callbackCount).toBe(1));
    expect(uploadCount).toBe(1);
  });
});
