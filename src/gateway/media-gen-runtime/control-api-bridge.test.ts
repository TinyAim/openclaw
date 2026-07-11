import { describe, expect, it, vi } from "vitest";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";

function dispatch(): MediaGenRuntimeDispatch {
  return {
    op: "submit",
    taskId: "task-1",
    workspaceId: "ws-1",
    correlationId: "corr-1",
    presetId: "kling",
    mode: "image2video",
    prompt: "make a clip",
    reference: { kind: "artifact", artifactId: "artifact-source" },
    consent: { subjectType: "portrait", authorized: true },
    consentRef: "mediagen-consent-1",
  };
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("OpenClaw media-generation Control API bridge", () => {
  it("redeems an artifact grant into bounded source bytes", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/v1/control/media-gen/runtime/reference-grant")) {
        return new Response(
          JSON.stringify({
            data: {
              grantToken: "grant-1",
              mimeType: "image/png",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(Buffer.from("source"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    const bridge = createControlApiMediaGenBridge({
      controlApiUrl: "https://control.example/",
      runtimeId: "runtime-1",
      token: "token-1",
      fetchImpl,
      maxReferenceBytes: 16,
    });

    const source = await bridge.resolveArtifactReference({
      dispatch: dispatch(),
      artifactId: "artifact-source",
    });

    expect(source.bytes.equals(Buffer.from("source"))).toBe(true);
    expect(source.mimeType).toBe("image/png");
    expect(calls).toMatchObject([
      {
        url: "https://control.example/v1/control/media-gen/runtime/reference-grant",
        body: {
          workspaceId: "ws-1",
          runtimeId: "runtime-1",
          taskId: "task-1",
          reference: { kind: "artifact", artifactId: "artifact-source" },
        },
      },
      {
        url: "https://control.example/v1/control/media-gen/runtime/reference-redeem",
        body: {
          grantToken: "grant-1",
          workspaceId: "ws-1",
          runtimeId: "runtime-1",
        },
      },
    ]);
  });

  it("threads the slot role into the reference grant request (CP3 §4.2.4)", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/v1/control/media-gen/runtime/reference-grant")) {
        return new Response(
          JSON.stringify({ data: { grantToken: "grant-1", mimeType: "image/png" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(Buffer.from("source"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    const bridge = createControlApiMediaGenBridge({
      controlApiUrl: "https://control.example/",
      runtimeId: "runtime-1",
      token: "token-1",
      fetchImpl,
      maxReferenceBytes: 16,
    });

    await bridge.resolveArtifactReference({
      dispatch: dispatch(),
      artifactId: "artifact-source",
      role: "pose_face",
    });

    expect(calls[0]).toMatchObject({
      url: "https://control.example/v1/control/media-gen/runtime/reference-grant",
      body: { role: "pose_face", reference: { kind: "artifact", artifactId: "artifact-source" } },
    });
  });

  it("advertises supportsMultiReference on register only when true", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const bridge = createControlApiMediaGenBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-1",
      token: "token-1",
      fetchImpl,
    });

    await bridge.register({
      workspaceId: "ws-1",
      supportedPresetIds: ["vidu"],
      enforcesModeration: true,
      appliesLabeling: true,
      supportsMultiReference: true,
    });
    await bridge.register({
      workspaceId: "ws-2",
      supportedPresetIds: ["kling"],
      enforcesModeration: true,
      appliesLabeling: true,
    });

    expect(calls[0]!.body).toMatchObject({ supportsMultiReference: true });
    expect((calls[1]!.body as Record<string, unknown>).supportsMultiReference).toBeUndefined();
  });

  it("fails closed when a reference redeem response streams past the local byte limit", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/v1/control/media-gen/runtime/reference-grant")) {
        return new Response(
          JSON.stringify({ data: { grantToken: "grant-1", mimeType: "image/png" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        streamFromChunks([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]),
        { status: 200, headers: { "content-type": "image/png" } },
      );
    }) as unknown as typeof fetch;
    const bridge = createControlApiMediaGenBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-1",
      token: "token-1",
      fetchImpl,
      maxReferenceBytes: 4,
    });

    await expect(
      bridge.resolveArtifactReference({ dispatch: dispatch(), artifactId: "artifact-source" }),
    ).rejects.toThrow("media-gen reference redeem exceeds max bytes");
  });
});
