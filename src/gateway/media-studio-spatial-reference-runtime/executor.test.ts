import { describe, expect, it, vi } from "vitest";
import { createMediaStudioSpatialReferenceRuntimeExecutor } from "./executor.js";
import { dispatch, v2Dispatch } from "./reference.test-harness.js";

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

  it("uses the frozen v2 package and emits receipt-only uploads for every frame", async () => {
    const callbacks: Array<Record<string, unknown>> = [];
    const uploadedMimeTypes: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/spatial-reference/upload")) {
        const bytes = init?.body as unknown as Buffer;
        const headers = init?.headers as Record<string, string>;
        const mimeType = String(headers["content-type"]);
        uploadedMimeTypes.push(mimeType);
        const artifactIdByGrant: Record<string, string> = {
          "upload-grant-1": "artifact-frame-1",
          "upload-grant-motion-1": "artifact-motion-1",
          "upload-grant-start-1": "artifact-start-1",
          "upload-grant-end-1": "artifact-end-1",
          "upload-grant-topdown-1": "artifact-topdown-1",
        };
        const artifactId = artifactIdByGrant[headers["x-wisclaw-spatial-upload-grant"]];
        if (!artifactId) throw new Error("unexpected upload grant");
        const { createHash } = await import("node:crypto");
        return new Response(
          JSON.stringify({
            data: {
              artifactId,
              storageKey: `artifacts/spatial/${artifactId}`,
              size: bytes.length,
              sha256Hex: createHash("sha256").update(bytes).digest("hex"),
              mimeType,
            },
          }),
          { status: 200 },
        );
      }
      callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
    });
    const render = vi.fn(async (_input, _signal, lifecycle) => {
      const executionScope = lifecycle?.executionScope;
      if (!executionScope) throw new Error("missing persisted execution scope");
      const worker = { pid: 1, startTime: 2, ...executionScope };
      await lifecycle?.onLaunched?.(worker);
      await lifecycle?.onExited?.(worker, "completed");
      return {
        compositionPng: Buffer.from([137, 80, 78, 71, 0, 0, 0, 0]),
        compositionPixelDigest: "sha256:pixel",
        width: 320,
        height: 180,
        motionMp4: Buffer.from("motion-mp4"),
        fps: 12 as const,
        frameCount: 1,
        durationMs: 83,
        evaluatorVersion: "frame-evaluator/v1",
        referencePngs: [
          {
            slot: "start_frame" as const,
            ordinal: 0,
            sourceTimeMs: 0,
            png: Buffer.from([137, 80, 78, 71]),
          },
          {
            slot: "end_frame" as const,
            ordinal: 0,
            sourceTimeMs: 83,
            png: Buffer.from([137, 80, 78, 71]),
          },
          { slot: "topdown_frame" as const, ordinal: 0, png: Buffer.from([137, 80, 78, 71]) },
        ],
      };
    });
    const executor = createMediaStudioSpatialReferenceRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-1",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      v2Renderer: { render },
    });

    await executor.dispatch(v2Dispatch());
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ contractVersion: "spatial_reference_render/v2" }),
      expect.any(AbortSignal),
      expect.objectContaining({ onLaunched: expect.any(Function), onExited: expect.any(Function) }),
    );
    expect(uploadedMimeTypes).toEqual([
      "image/png",
      "video/mp4",
      "image/png",
      "image/png",
      "image/png",
    ]);
    expect(callbacks[0]).toMatchObject({
      status: "succeeded",
      receipt: { artifactId: "artifact-frame-1", mimeType: "image/png" },
      motionReferenceReceipt: {
        artifactId: "artifact-motion-1",
        mimeType: "video/mp4",
        fps: 12,
        frameCount: 1,
      },
      referenceFileReceipts: [
        { artifactId: "artifact-start-1", slot: "start_frame", ordinal: 0, sourceTimeMs: 0 },
        { artifactId: "artifact-end-1", slot: "end_frame", ordinal: 0, sourceTimeMs: 83 },
        { artifactId: "artifact-topdown-1", slot: "topdown_frame", ordinal: 0 },
      ],
    });
  });

  it("terminal-handoffs a fully finalized v2 package without rendering or minting an upload", async () => {
    const callbacks: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/spatial-reference/upload")) {
        throw new Error("all-finalized output must not upload again");
      }
      callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
    });
    const render = vi.fn();
    const input = v2Dispatch();
    input.outputUploadGrants = [];
    delete input.outputUploadGrant;
    delete input.motionReferenceUploadGrant;
    input.knownFinalizedReceipts = input.expectedOutputs.map((output, index) => ({
      ...output,
      size: index + 1,
      sha256Hex: `${index}`.padStart(64, "a"),
      storageKey: `artifacts/spatial/${output.artifactId}`,
    }));
    const executor = createMediaStudioSpatialReferenceRuntimeExecutor({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-1",
      token: "runtime-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      v2Renderer: { render },
    });

    await executor.dispatch(input);
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));

    expect(render).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/spatial-reference/upload")),
    ).toBe(false);
    expect(callbacks[0]).toMatchObject({
      status: "succeeded",
      receipt: { artifactId: "artifact-frame-1", storageKey: "artifacts/spatial/artifact-frame-1" },
      motionReferenceReceipt: { artifactId: "artifact-motion-1" },
      referenceFileReceipts: expect.arrayContaining([
        expect.objectContaining({ artifactId: "artifact-start-1" }),
      ]),
    });
  });
});
