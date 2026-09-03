import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendor } from "./types.js";

function dispatch(overrides: Partial<MediaGenRuntimeDispatch> = {}): MediaGenRuntimeDispatch {
  return {
    op: "submit",
    taskId: "task-1",
    workspaceId: "ws-1",
    correlationId: "corr-1",
    presetId: "kling",
    mode: "text2video",
    prompt: "a short drama scene",
    ...overrides,
  };
}

describe("OpenClaw media-generation runtime executor", () => {
  it("downloads vendor output, hands bytes to Control API, and reports honest hooks", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(async ({ sha256, output }) => ({
        artifactId: "artifact-1",
        sha256,
        mimeType: output.mimeType,
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
      poll: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
    };
    const fetchImpl = vi.fn(async () => {
      return new Response(Buffer.from("video-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl,
      allowedMediaHosts: ["cdn.example"],
      moderation: {
        screenInput: vi.fn(async () => ({ allowed: true })),
        screenOutput: vi.fn(async () => ({ allowed: true })),
      },
      labeler: {
        applyLabel: vi.fn(async (output) => ({ ...output, applied: true })),
      },
      now: () => new Date("2026-06-21T10:00:00.000Z"),
    });

    const submitted = await executor.dispatch(dispatch());
    expect(submitted).toMatchObject({ status: "processing", runtimeJobId: "job-1" });

    const polled = await executor.dispatch(dispatch({ op: "poll", runtimeJobId: "job-1" }));
    expect(polled).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-1", mimeType: "video/mp4" },
      snapshot: {
        executionOwner: "user_runtime",
        moderationStatus: "runtime_enforced",
        labelingStatus: "runtime_applied",
      },
    });
    expect(bridge.handoffArtifact).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example/out.mp4", expect.anything());
  });

  it("does not claim moderation or labeling without real hooks", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(async ({ output }) => ({
        artifactId: "artifact-1",
        mimeType: output.mimeType,
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response("video", { status: 200, headers: { "content-type": "video/mp4" } }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
    });

    const result = await executor.dispatch(dispatch());
    expect(result.snapshot).toMatchObject({
      moderationStatus: "not_enforced",
      labelingStatus: "absent",
    });
  });

  it("requires a persisted consentRef before executing a consented reference job", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(async () => ({
        bytes: Buffer.from("source"),
        mimeType: "image/png",
      })),
      handoffArtifact: vi.fn(async ({ output }) => ({
        artifactId: "artifact-1",
        mimeType: output.mimeType,
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response("video", { status: 200, headers: { "content-type": "video/mp4" } }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
    });

    const rejected = await executor.dispatch(
      dispatch({
        mode: "image2video",
        reference: { kind: "artifact", artifactId: "art-1" },
        consent: { subjectType: "portrait", authorized: true },
      }),
    );
    expect(rejected).toMatchObject({
      status: "failed",
      failureReason: "internal",
    });
    expect(vendor.submit).not.toHaveBeenCalled();

    const accepted = await executor.dispatch(
      dispatch({
        mode: "image2video",
        reference: { kind: "artifact", artifactId: "art-1" },
        consent: { subjectType: "portrait", authorized: true },
        consentRef: "mediagen-consent-1",
      }),
    );
    expect(accepted.snapshot).toMatchObject({ consentRef: "mediagen-consent-1" });
    expect(vendor.submit).toHaveBeenCalledTimes(1);
  });

  it("treats persisted consentRef as the retry authorization proof for moderation", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(async () => ({
        bytes: Buffer.from("source"),
        mimeType: "image/png",
      })),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "processing" as const,
        vendorJobId: "job-retry",
      })),
      poll: vi.fn(),
    };
    const moderation = {
      screenInput: vi.fn(async () => ({ allowed: true })),
      screenOutput: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      moderation,
    });

    const result = await executor.dispatch(
      dispatch({
        op: "retry",
        mode: "image2video",
        reference: { kind: "artifact", artifactId: "art-1" },
        consentRef: "mediagen-consent-1",
      }),
    );

    expect(result).toMatchObject({ status: "processing", runtimeJobId: "job-retry" });
    expect(moderation.screenInput).toHaveBeenCalledWith(
      expect.objectContaining({
        hasSource: true,
        consentAuthorized: true,
      }),
    );
  });

  it("reuses a still-processing runtimeJobId on retry instead of creating a duplicate vendor job", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(),
      poll: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-existing" })),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });

    const result = await executor.dispatch(
      dispatch({
        op: "retry",
        mode: "image2video",
        runtimeJobId: "job-existing",
        reference: { kind: "artifact", artifactId: "art-1" },
        consentRef: "mediagen-consent-1",
      }),
    );

    expect(result).toMatchObject({ status: "processing", runtimeJobId: "job-existing" });
    expect(vendor.poll).toHaveBeenCalledWith("job-existing");
    expect(vendor.submit).not.toHaveBeenCalled();
  });

  it("materializes an already-succeeded runtimeJobId on retry before creating a new vendor job", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(async ({ output }) => ({
        artifactId: "artifact-existing",
        mimeType: output.mimeType,
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(),
      poll: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-existing",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response("video", { status: 200, headers: { "content-type": "video/mp4" } }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
    });

    const result = await executor.dispatch(
      dispatch({
        op: "retry",
        mode: "image2video",
        runtimeJobId: "job-existing",
        reference: { kind: "artifact", artifactId: "art-1" },
        consentRef: "mediagen-consent-1",
      }),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      runtimeJobId: "job-existing",
      artifact: { artifactId: "artifact-existing" },
      snapshot: { consentRef: "mediagen-consent-1" },
    });
    expect(vendor.poll).toHaveBeenCalledWith("job-existing");
    expect(vendor.submit).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).toHaveBeenCalledTimes(1);
  });

  it("polls by runtimeJobId after a restart without relying on in-memory jobs", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(async ({ output }) => ({
        artifactId: "artifact-1",
        mimeType: output.mimeType,
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(),
      poll: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-after-restart",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response("video", { status: 200, headers: { "content-type": "video/mp4" } }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
    });

    const result = await executor.dispatch(
      dispatch({
        op: "poll",
        runtimeJobId: "job-after-restart",
        consentRef: "mediagen-consent-1",
      }),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      snapshot: { consentRef: "mediagen-consent-1" },
    });
    expect(vendor.poll).toHaveBeenCalledWith("job-after-restart");
  });

  it("rejects non-media vendor output instead of materializing an error page", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response("<html>expired</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
    });

    const result = await executor.dispatch(dispatch());

    expect(result).toMatchObject({
      status: "failed",
      failureReason: "download_failed",
    });
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });

  it("quality rejected: never calls handoffArtifact", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(async () => ({
        artifactId: "should-not",
        mimeType: "video/mp4",
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response(Buffer.from("video-bytes"), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
      validateMediaBytes: async () => ({
        ok: false as const,
        code: "black_frame_dominant",
        message: "media is predominantly black frames",
      }),
    });
    const result = await executor.dispatch(dispatch());
    expect(result).toMatchObject({
      status: "failed",
      failureReason: "vendor_rejected",
      failureMessage: "media is predominantly black frames",
    });
    expect(bridge.handoffArtifact).toHaveBeenCalledTimes(0);
  });

  it("quality infrastructure failure maps to internal, not vendor_rejected", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response(Buffer.from("video-bytes"), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
      validateMediaBytes: async () => ({
        ok: false as const,
        code: "tool_missing",
        message: "ffprobe is not available on this runtime",
      }),
    });
    const result = await executor.dispatch(dispatch());
    expect(result).toMatchObject({
      status: "failed",
      failureReason: "internal",
    });
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });

  it("quality canceled returns status=canceled (not failureReason cancelled)", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response(Buffer.from("video-bytes"), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
      validateMediaBytes: async () => ({
        ok: false as const,
        code: "canceled",
        message: "media quality validation canceled",
      }),
    });
    const result = await executor.dispatch(dispatch());
    expect(result.status).toBe("canceled");
    expect(result.failureReason).toBeUndefined();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });

  it("quality passed: handoffArtifact called once", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(async ({ output }) => ({
        artifactId: "artifact-1",
        mimeType: output.mimeType,
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response(Buffer.from("video-bytes"), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
      validateMediaBytes: async () => ({ ok: true as const }),
    });
    const result = await executor.dispatch(dispatch());
    expect(result.status).toBe("succeeded");
    expect(bridge.handoffArtifact).toHaveBeenCalledTimes(1);
  });

  it("enforces max bytes while streaming vendor output without trusting Content-Length", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      ) as unknown as typeof fetch,
      allowedMediaHosts: ["cdn.example"],
      maxMediaBytes: 4,
    });

    const result = await executor.dispatch(dispatch());

    expect(result).toMatchObject({
      status: "failed",
      failureReason: "download_failed",
    });
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });
});
