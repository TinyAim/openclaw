import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../media-studio-spatial-environment-render/index.js", () => ({
  renderModelFreePanorama: async () => ({
    panoramaPng: Buffer.from("panorama"),
    generatedRegionMaskPng: Buffer.from("mask"),
    qualityReport: { qualityGate: { passed: true } },
  }),
}));

import type { SpatialEnvironmentPanoramaRuntimeRequest } from "../media-studio-spatial-environment-render-http.js";
import {
  createFilePanoramaCallbackOutbox,
  createInMemoryPanoramaCallbackOutbox,
} from "./panorama-callback-outbox.js";
import { createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor } from "./panorama-executor.js";

function request(): SpatialEnvironmentPanoramaRuntimeRequest {
  const source = Buffer.from("source");
  const expiresAt = "2026-08-09T12:15:00.000Z";
  return {
    kind: "media_studio.spatial_environment_panorama",
    contractVersion: "spatial_environment_panorama/model_free_v1",
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
      expectedSha256Hex: createHash("sha256").update(source).digest("hex"),
      maxBytes: 1024,
      expiresAt,
    },
    outputUploadGrants: [
      ["environment_panorama", "image/png"],
      ["generated_region_mask", "image/png"],
      ["quality_report", "application/json"],
    ].map(([slot, mimeType]) => ({
      grantToken: `output-${slot}`,
      purpose: "output_upload" as const,
      slot: slot as "environment_panorama" | "generated_region_mask" | "quality_report",
      artifactId: `artifact-${slot}`,
      allowedMimeTypes: [mimeType!],
      maxBytes: 2048,
      expiresAt,
    })),
    horizontalFovDegrees: 75,
    outputWidth: 256,
  };
}

describe("grant-based panorama Runtime executor", () => {
  it("redeems source, uploads three outputs, and posts receipts without bytes", async () => {
    const callbacks: Record<string, unknown>[] = [];
    const uploads: string[] = [];
    let terminalUploadCallback: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/source")) {
        return new Response(Buffer.from("source"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (href.includes("/spatial-reference/upload")) {
        const grant = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-upload-grant"],
        );
        const slot = grant.replace("output-", "");
        const bytes = init?.body as unknown as Buffer;
        uploads.push(slot);
        const terminalHeader = (init?.headers as Record<string, string>)[
          "x-wisclaw-spatial-terminal-callback"
        ];
        if (terminalHeader) {
          terminalUploadCallback = JSON.parse(
            Buffer.from(terminalHeader, "base64url").toString("utf8"),
          ) as Record<string, unknown>;
        }
        return new Response(
          JSON.stringify({
            data: {
              artifactId: `artifact-${slot}`,
              size: bytes.length,
              sha256Hex: createHash("sha256").update(bytes).digest("hex"),
              mimeType: (init?.headers as Record<string, string>)["content-type"],
            },
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/spatial-environment-panorama/callback")) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { accepted: true } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const executor = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const ack = await executor.dispatch(request());
    expect(ack).toMatchObject({ accepted: true, deferredSettlement: true });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(uploads.sort()).toEqual([
      "environment_panorama",
      "generated_region_mask",
      "quality_report",
    ]);
    expect(callbacks[0]).toMatchObject({
      status: "succeeded",
      receipts: expect.arrayContaining([expect.objectContaining({ slot: "quality_report" })]),
    });
    expect(terminalUploadCallback).toEqual(callbacks[0]);
    expect(JSON.stringify(terminalUploadCallback)).not.toContain("grantToken");
    expect(JSON.stringify(callbacks[0])).not.toMatch(/pngBase64|imageBase64|"bytes"/);
    expect(JSON.stringify(callbacks[0])).not.toContain("source-secret");
    expect(JSON.stringify(callbacks[0])).not.toContain("output-environment_panorama");
  });

  it("fails closed when Control API upload receipt digest differs from uploaded bytes", async () => {
    const callbacks: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/source")) {
        return new Response(Buffer.from("source"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (href.includes("/spatial-reference/upload")) {
        const grant = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-upload-grant"],
        );
        const slot = grant.replace("output-", "");
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
      if (href.endsWith("/spatial-environment-panorama/callback")) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { accepted: true } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const executor = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(await executor.dispatch(request())).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(callbacks[0]).toMatchObject({
      status: "failed",
      errorCode: "upload_receipt_mismatch",
    });
    expect(callbacks[0]).not.toHaveProperty("receipts");
  });

  it("retries transient source and upload failures with the exact grant-bound bytes", async () => {
    const callbacks: Record<string, unknown>[] = [];
    let sourceAttempts = 0;
    const uploadAttempts = new Map<string, number>();
    const uploadDigests = new Map<string, Set<string>>();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/source")) {
        sourceAttempts += 1;
        if (sourceAttempts === 1) throw new TypeError("fetch failed");
        return new Response(Buffer.from("source"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (href.includes("/spatial-reference/upload")) {
        const grant = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-upload-grant"],
        );
        const slot = grant.replace("output-", "");
        const bytes = init?.body as unknown as Buffer;
        const attempt = (uploadAttempts.get(slot) ?? 0) + 1;
        uploadAttempts.set(slot, attempt);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const digests = uploadDigests.get(slot) ?? new Set<string>();
        digests.add(digest);
        uploadDigests.set(slot, digests);
        if (slot === "environment_panorama" && attempt === 1) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
          });
        }
        return new Response(
          JSON.stringify({
            data: {
              artifactId: `artifact-${slot}`,
              size: bytes.length,
              sha256Hex: digest,
              mimeType: (init?.headers as Record<string, string>)["content-type"],
            },
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/spatial-environment-panorama/callback")) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const executor = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      ioRetryDelayMs: 0,
    });

    expect(await executor.dispatch(request())).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(callbacks[0]).toMatchObject({ status: "succeeded" });
    expect(sourceAttempts).toBe(2);
    expect(uploadAttempts.get("environment_panorama")).toBe(2);
    expect(uploadDigests.get("environment_panorama")?.size).toBe(1);
  });

  it("honors cancellation after ACK without uploading outputs", async () => {
    const callbacks: Record<string, unknown>[] = [];
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/source")) {
        await sourceGate;
        return new Response(Buffer.from("source"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (href.includes("/spatial-reference/upload")) {
        throw new Error("cancelled execution must not upload outputs");
      }
      if (href.endsWith("/spatial-environment-panorama/callback")) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { accepted: true } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const executor = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(executor.dispatch(request())).toMatchObject({
      accepted: true,
      deferredSettlement: true,
    });
    expect(executor.cancel({ dispatchAttemptId: "dispatch-a" })).toEqual({
      acknowledged: true,
      terminal: false,
    });
    releaseSource();
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(callbacks[0]).toMatchObject({ status: "cancelled" });
    expect(callbacks[0]).not.toHaveProperty("receipts");
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/spatial-reference/upload")),
    ).toBe(false);
  });

  it("replays the same success receipts instead of fabricating failure when settlement is transient", async () => {
    const callbacks: Record<string, unknown>[] = [];
    let callbackAttempt = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/spatial-reference/source")) {
        return new Response(Buffer.from("source"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (href.includes("/spatial-reference/upload")) {
        const grant = String(
          (init?.headers as Record<string, string>)["x-wisclaw-spatial-upload-grant"],
        );
        const slot = grant.replace("output-", "");
        const bytes = init?.body as unknown as Buffer;
        return new Response(
          JSON.stringify({
            data: {
              artifactId: `artifact-${slot}`,
              size: bytes.length,
              sha256Hex: createHash("sha256").update(bytes).digest("hex"),
              mimeType: (init?.headers as Record<string, string>)["content-type"],
            },
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/spatial-environment-panorama/callback")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        callbacks.push(body);
        callbackAttempt += 1;
        if (callbackAttempt === 1) {
          return new Response(JSON.stringify({ error: { code: "SETTLEMENT_TEMPORARY" } }), {
            status: 503,
          });
        }
        return new Response(JSON.stringify({ data: { accepted: true } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const executor = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-a",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      callbackRetryIntervalMs: 250,
    });
    expect(executor.dispatch(request())).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    expect(callbacks.map((body) => body.status)).toEqual(["succeeded", "succeeded"]);
    expect(callbacks[1]).toEqual(callbacks[0]);
    executor.stop?.();
  });

  it("discards one top-level terminal 409 instead of replaying it forever", async () => {
    const input = request();
    const outbox = createInMemoryPanoramaCallbackOutbox();
    await outbox.enqueue({
      kind: "media_studio.spatial_environment_panorama.callback",
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
    const executor = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
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
            code: "SPATIAL_ENV_PANORAMA_CALLBACK_TERMINAL_REJECTED",
            message: "SPATIAL_ENV_PANORAMA_CALLBACK:terminal_conflict",
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

  it("survives a Runtime restart after uploads and replays the durable terminal callback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panorama-callback-outbox-"));
    const filePath = path.join(tempDir, "outbox.json");
    const callbacks: Record<string, unknown>[] = [];
    try {
      const firstFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/spatial-reference/source")) {
          return new Response(Buffer.from("source"), { status: 200 });
        }
        if (href.includes("/spatial-reference/upload")) {
          const headers = init?.headers as Record<string, string>;
          const slot = headers["x-wisclaw-spatial-upload-grant"].replace("output-", "");
          const bytes = init?.body as unknown as Buffer;
          return new Response(
            JSON.stringify({
              data: {
                artifactId: `artifact-${slot}`,
                size: bytes.length,
                sha256Hex: createHash("sha256").update(bytes).digest("hex"),
                mimeType: headers["content-type"],
              },
            }),
            { status: 200 },
          );
        }
        if (href.endsWith("/spatial-environment-panorama/callback")) {
          callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ error: { code: "gateway_down" } }), {
            status: 503,
          });
        }
        throw new Error(`unexpected URL ${href}`);
      });
      const first = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
        controlApiUrl: "https://control.example",
        runtimeId: "runtime-a",
        token: "runtime-token",
        fetchImpl: firstFetch as unknown as typeof fetch,
        callbackOutbox: createFilePanoramaCallbackOutbox({ filePath }),
        callbackRetryIntervalMs: 60_000,
      });
      expect(await first.dispatch(request())).toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      first.stop?.();

      const durableJson = await readFile(filePath, "utf8");
      expect(durableJson).toContain('"status": "succeeded"');
      expect(durableJson).not.toContain("runtime-token");
      expect(durableJson).not.toContain("source-secret");
      expect(durableJson).not.toContain("grantToken");
      expect(durableJson).not.toContain('"bytes"');

      const recoveredCallbacks: Record<string, unknown>[] = [];
      const restarted = createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
        controlApiUrl: "https://control.example",
        runtimeId: "runtime-a",
        token: "runtime-token",
        fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
          const href = String(url);
          if (!href.endsWith("/spatial-environment-panorama/callback")) {
            throw new Error(`restart must only replay callback, got ${href}`);
          }
          recoveredCallbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ data: { accepted: true } }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
        callbackOutbox: createFilePanoramaCallbackOutbox({ filePath }),
        callbackRetryIntervalMs: 60_000,
      });
      await restarted.flushCallbacksOnce?.();
      expect(recoveredCallbacks).toHaveLength(1);
      expect(recoveredCallbacks[0]).toEqual(callbacks[0]);
      expect(await createFilePanoramaCallbackOutbox({ filePath }).list()).toHaveLength(0);
      restarted.stop?.();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
