import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../media-studio-spatial-depth-mesh-render/index.js", () => ({
  renderDeterministicDepthMesh: async () => ({
    depthMeshGlb: Buffer.from("glb"),
    generatedRegionMaskPng: Buffer.from("mask"),
    collisionJson: Buffer.from("collision"),
    qualityReport: { qualityGate: { passed: true, holesDetected: false } },
  }),
}));

import type { SpatialEnvironmentDepthMeshRuntimeRequest } from "../media-studio-spatial-depth-mesh-render-http.js";
import {
  createFileDepthMeshCallbackOutbox,
  createInMemoryDepthMeshCallbackOutbox,
} from "./depth-mesh-callback-outbox.js";
import { createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor } from "./depth-mesh-executor.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function request(): SpatialEnvironmentDepthMeshRuntimeRequest {
  const expiresAt = "2026-08-09T12:15:00.000Z";
  const source = Buffer.from("source");
  const depth = Buffer.alloc(8);
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
    sourceGrant: {
      grantToken: "source-secret",
      purpose: "source_download",
      slot: "source_image",
      artifactId: "source-artifact",
      allowedMimeTypes: ["image/png"],
      expectedSha256Hex: sha(source),
      maxBytes: 1024,
      expiresAt,
    },
    depthGrant: {
      grantToken: "depth-secret",
      purpose: "source_download",
      slot: "depth_adapter",
      artifactId: "depth-artifact",
      allowedMimeTypes: ["application/octet-stream"],
      expectedSha256Hex: sha(depth),
      maxBytes: 8,
      expiresAt,
    },
    outputUploadGrants: [
      ["environment_depth_mesh", "model/gltf-binary"],
      ["generated_region_mask", "image/png"],
      ["collision", "application/json"],
      ["quality_report", "application/json"],
    ].map(([slot, mimeType]) => ({
      grantToken: `output-${slot}`,
      purpose: "output_upload" as const,
      slot: slot as
        | "environment_depth_mesh"
        | "generated_region_mask"
        | "collision"
        | "quality_report",
      artifactId: `artifact-${slot}`,
      allowedMimeTypes: [mimeType!],
      maxBytes: 4096,
      expiresAt,
    })),
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
      componentManifestDigest: `sha256:${"a".repeat(64)}`,
      checkpointDigests: [],
      noticeRefs: ["NOTICE.adapter"],
    },
  };
}

describe("grant-based depth mesh Runtime executor", () => {
  it("redeems source/depth, uploads four outputs, and posts secret-free receipts", async () => {
    const callbacks: Record<string, unknown>[] = [];
    const uploads: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/source")) {
        const token = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-source-grant"],
        );
        return new Response(token === "depth-secret" ? Buffer.alloc(8) : Buffer.from("source"), {
          status: 200,
          headers: {
            "content-type": token === "depth-secret" ? "application/octet-stream" : "image/png",
          },
        });
      }
      if (href.includes("/spatial-reference/upload")) {
        const token = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-upload-grant"],
        );
        const slot = token.replace("output-", "");
        const bytes = init?.body as unknown as Buffer;
        uploads.push(slot);
        return new Response(
          JSON.stringify({
            data: {
              artifactId: `artifact-${slot}`,
              size: bytes.length,
              sha256Hex: sha(bytes),
              mimeType: (init?.headers as Record<string, string>)["content-type"],
            },
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/spatial-environment-depth-mesh/callback")) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const executor = createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(await executor.dispatch(request())).toMatchObject({
      accepted: true,
      deferredSettlement: true,
    });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(uploads.sort()).toEqual([
      "collision",
      "environment_depth_mesh",
      "generated_region_mask",
      "quality_report",
    ]);
    expect(callbacks[0]).toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(callbacks[0])).not.toMatch(/secret|Base64|"bytes"/);
  });

  it("fails closed when an upload receipt digest is not the uploaded digest", async () => {
    const callbacks: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/source")) {
        const token = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-source-grant"],
        );
        return new Response(token === "depth-secret" ? Buffer.alloc(8) : Buffer.from("source"), {
          status: 200,
          headers: {
            "content-type": token === "depth-secret" ? "application/octet-stream" : "image/png",
          },
        });
      }
      if (href.includes("/spatial-reference/upload")) {
        const token = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-upload-grant"],
        );
        const slot = token.replace("output-", "");
        const bytes = init?.body as unknown as Buffer;
        return new Response(
          JSON.stringify({
            data: {
              artifactId: `artifact-${slot}`,
              size: bytes.length,
              sha256Hex: "0".repeat(64),
              mimeType: (init?.headers as Record<string, string>)["content-type"],
            },
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/spatial-environment-depth-mesh/callback")) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const executor = createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(executor.dispatch(request())).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(callbacks[0]).toMatchObject({
      status: "failed",
      errorCode: "upload_receipt_mismatch",
    });
    expect(callbacks[0]).not.toHaveProperty("receipts");
  });

  it("replays a receipt-only terminal callback from the file outbox after restart", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "wisclaw-depth-outbox-"));
    const filePath = path.join(tempDir, "outbox.json");
    try {
      const failedCallbacks: Record<string, unknown>[] = [];
      const firstFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        const headers = init?.headers as Record<string, string>;
        if (href.includes("/spatial-reference/source")) {
          const token = headers["x-wisclaw-spatial-source-grant"];
          return new Response(token === "depth-secret" ? Buffer.alloc(8) : Buffer.from("source"), {
            status: 200,
            headers: {
              "content-type": token === "depth-secret" ? "application/octet-stream" : "image/png",
            },
          });
        }
        if (href.includes("/spatial-reference/upload")) {
          const slot = headers["x-wisclaw-spatial-upload-grant"].replace("output-", "");
          const bytes = init?.body as unknown as Buffer;
          if (slot === "quality_report") {
            expect(headers["x-wisclaw-spatial-terminal-callback"]).toBeTruthy();
          }
          return new Response(
            JSON.stringify({
              data: {
                artifactId: `artifact-${slot}`,
                size: bytes.length,
                sha256Hex: sha(bytes),
                mimeType: headers["content-type"],
              },
            }),
            { status: 200 },
          );
        }
        if (href.endsWith("/spatial-environment-depth-mesh/callback")) {
          failedCallbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ error: { code: "gateway_down" } }), { status: 503 });
        }
        throw new Error(`unexpected URL ${href}`);
      });
      const first = createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor({
        controlApiUrl: "https://control.example",
        runtimeId: "runtime-a",
        token: "runtime-token",
        fetchImpl: firstFetch as unknown as typeof fetch,
        callbackOutbox: createFileDepthMeshCallbackOutbox({ filePath }),
        callbackRetryIntervalMs: 60_000,
      });
      expect(await first.dispatch(request())).toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(failedCallbacks).toHaveLength(1));
      first.stop?.();

      const durableJson = await readFile(filePath, "utf8");
      expect(durableJson).toContain('"status": "succeeded"');
      expect(durableJson).not.toContain("runtime-token");
      expect(durableJson).not.toContain("grantToken");
      expect(durableJson).not.toContain('"bytes"');

      const recoveredCallbacks: Record<string, unknown>[] = [];
      const restarted = createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor({
        controlApiUrl: "https://control.example",
        runtimeId: "runtime-a",
        token: "runtime-token",
        fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
          const href = String(url);
          if (!href.endsWith("/spatial-environment-depth-mesh/callback")) {
            throw new Error(`restart must only replay callback, got ${href}`);
          }
          recoveredCallbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
        }) as unknown as typeof fetch,
        callbackOutbox: createFileDepthMeshCallbackOutbox({ filePath }),
        callbackRetryIntervalMs: 60_000,
      });
      await restarted.flushCallbacksOnce?.();
      expect(recoveredCallbacks).toHaveLength(1);
      expect(recoveredCallbacks[0]).toEqual(failedCallbacks[0]);
      expect(await createFileDepthMeshCallbackOutbox({ filePath }).list()).toHaveLength(0);
      restarted.stop?.();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("discards a deterministic top-level 409 callback rejection once", async () => {
    const input = request();
    const outbox = createInMemoryDepthMeshCallbackOutbox();
    await outbox.enqueue({
      kind: "media_studio.spatial_environment_depth_mesh.callback",
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      materializationId: input.materializationId,
      executionId: "execution-a",
      requestFingerprint: input.requestFingerprint,
      executionFingerprint: input.executionFingerprint,
      dispatchAttemptId: input.dispatchAttemptId,
      sequence: input.sequence,
      attempt: input.attempt,
      status: "failed",
      errorCode: "render_failed",
    });
    const callbacks: Record<string, unknown>[] = [];
    const executor = createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      callbackOutbox: outbox,
      callbackRetryIntervalMs: 60_000,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            success: false,
            code: "SPATIAL_ENV_DEPTH_MESH_CALLBACK_TERMINAL_REJECTED",
            message: "SPATIAL_ENV_DEPTH_MESH_CALLBACK:payload_conflict",
            details: { retryable: false, callbackDisposition: "discard" },
          }),
          { status: 409 },
        );
      }) as typeof fetch,
    });

    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    await vi.waitFor(async () => expect(await outbox.list()).toHaveLength(0));
    await executor.flushCallbacksOnce?.();
    expect(callbacks).toHaveLength(1);
    executor.stop?.();
  });
});
