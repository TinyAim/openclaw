import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";

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
    const expectedSha256 = createHash("sha256").update("source").digest("hex");
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
              sha256: expectedSha256,
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
    expect(source.sha256).toBe(expectedSha256);
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

  it("threads the exact slot role and ordinal into the reference grant request", async () => {
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
      ordinal: 3,
    });

    expect(calls[0]).toMatchObject({
      url: "https://control.example/v1/control/media-gen/runtime/reference-grant",
      body: {
        role: "pose_face",
        ordinal: 3,
        reference: { kind: "artifact", artifactId: "artifact-source" },
      },
    });
  });

  it("advertises exact route claims and supportsMultiReference on register", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
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
      capabilityRouteClaims: [
        {
          presetId: "vidu",
          mode: "image2video",
          route: {
            schemaVersion: 1,
            routeId: "vidu.enterprise.v2.img2video",
            providerId: "vidu_enterprise",
            modelId: "viduq1",
            endpointId: "vidu.ent.v2.img2video",
            region: "unknown",
            accountTier: "unknown",
          },
          adapterRevision: "openclaw-vidu-runtime/v1",
        },
      ],
    });
    await bridge.register({
      workspaceId: "ws-2",
      supportedPresetIds: ["kling"],
      enforcesModeration: true,
      appliesLabeling: true,
    });

    expect(calls[0]!.body).toMatchObject({
      supportsMultiReference: true,
      capabilityRouteClaims: [expect.objectContaining({ presetId: "vidu", mode: "image2video" })],
    });
    expect((calls[1]!.body as Record<string, unknown>).supportsMultiReference).toBeUndefined();
  });

  it("binds Artifact handoff to the exact runtime job attempt", async () => {
    let seenUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      seenUrl = String(url);
      return new Response(
        JSON.stringify({
          data: {
            artifact: {
              artifactId: "artifact-output-1",
              mimeType: "video/mp4",
              sha256: "a".repeat(64),
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const bridge = createControlApiMediaGenBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "runtime-1",
      token: "token-1",
      fetchImpl,
    });

    await bridge.handoffArtifact({
      dispatch: dispatch(),
      runtimeJobId: "seedance-v2:image2video:ark-job-1",
      output: { mediaRef: "https://cdn.example/video.mp4", mimeType: "video/mp4" },
      bytes: Buffer.from("video"),
      sha256: "a".repeat(64),
    });

    const url = new URL(seenUrl);
    expect(url.searchParams.get("taskId")).toBe("task-1");
    expect(url.searchParams.get("runtimeJobId")).toBe("seedance-v2:image2video:ark-job-1");
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
