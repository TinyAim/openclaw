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
    prompt: "scene",
    ...overrides,
  };
}

function bridge(): MediaGenRuntimeBridge {
  return {
    runtimeId: "runtime-1",
    register: vi.fn(async () => undefined),
    resolveArtifactReference: vi.fn(async () => ({
      bytes: Buffer.from("unused"),
      mimeType: "image/png",
    })),
    handoffArtifact: vi.fn(async ({ sha256, output }) => ({
      artifactId: "unused",
      sha256,
      mimeType: output.mimeType,
    })),
  };
}

describe("OpenClaw executor cancel honesty", () => {
  it.each(["requested", "failed", "unknown"] as const)(
    "keeps the tracked job after an unconfirmed %s outcome",
    async (state) => {
      const vendor: MediaGenRuntimeVendor = {
        presetId: "kling",
        isConfigured: () => true,
        submit: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
        poll: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
        cancel: vi.fn(async () => ({ state })),
      };
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge: bridge(),
        vendors: [vendor],
      });
      await executor.dispatch(dispatch());
      const canceled = await executor.dispatch(
        dispatch({ op: "cancel", runtimeJobId: "job-1", correlationId: "cancel" }),
      );
      expect(canceled).toMatchObject({
        status: "canceled",
        runtimeJobId: "job-1",
        runtimeStopOutcome: { state },
      });
      const polled = await executor.dispatch(
        dispatch({ op: "poll", runtimeJobId: "job-1", correlationId: "poll" }),
      );
      expect(polled).toMatchObject({ status: "processing", runtimeJobId: "job-1" });
    },
  );

  it("deletes tracking only after explicit confirmation", async () => {
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
      poll: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
      cancel: vi.fn(async () => ({ state: "confirmed" as const })),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [vendor],
    });
    await executor.dispatch(dispatch());
    await expect(
      executor.dispatch(dispatch({ op: "cancel", runtimeJobId: "job-1", correlationId: "cancel" })),
    ).resolves.toMatchObject({
      status: "canceled",
      runtimeStopOutcome: { state: "confirmed" },
    });
    await expect(
      // Direct executor call intentionally omits the public-wire job receipt to
      // inspect process-local tracking deletion. The HTTP parser rejects this;
      // supplying the job would test the restart-reconstruction seam instead.
      executor.dispatch(dispatch({ op: "poll", correlationId: "poll" })),
    ).resolves.toMatchObject({ status: "failed", failureReason: "internal" });
  });

  it("reconciles an auth failure without creating a replacement job", async () => {
    const submit = vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" }));
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit,
      poll: vi.fn(),
      reconcile: vi.fn(async () => ({
        state: "failed" as const,
        vendorJobId: "job-1",
        reason: "auth" as const,
        message: "credential rejected",
        retryDisposition: "reconcile_only" as const,
      })),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [vendor],
    });
    await executor.dispatch(dispatch());
    await expect(
      executor.dispatch(dispatch({ op: "retry", runtimeJobId: "job-1", correlationId: "retry" })),
    ).resolves.toMatchObject({ status: "failed", failureReason: "auth" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("retries stop against the same job until the provider confirms", async () => {
    const cancel = vi
      .fn()
      .mockResolvedValueOnce({ state: "unknown" as const })
      .mockResolvedValueOnce({ state: "confirmed" as const });
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
      poll: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
      cancel,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [vendor],
    });
    await executor.dispatch(dispatch());

    await expect(
      executor.dispatch(
        dispatch({ op: "cancel", runtimeJobId: "job-1", correlationId: "cancel-1" }),
      ),
    ).resolves.toMatchObject({ runtimeStopOutcome: { state: "unknown" } });
    await expect(
      executor.dispatch(
        dispatch({ op: "cancel", runtimeJobId: "job-1", correlationId: "cancel-2" }),
      ),
    ).resolves.toMatchObject({ runtimeStopOutcome: { state: "confirmed" } });
    expect(cancel).toHaveBeenNthCalledWith(1, "job-1");
    expect(cancel).toHaveBeenNthCalledWith(2, "job-1");
  });

  it("fails closed on task/job mismatch with zero vendor stop I/O", async () => {
    const cancel = vi.fn();
    const reconcile = vi.fn();
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
      poll: vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" })),
      reconcile,
      cancel,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [vendor],
    });
    await executor.dispatch(dispatch());

    await expect(
      executor.dispatch(dispatch({ op: "cancel", runtimeJobId: "job-2", correlationId: "cancel" })),
    ).resolves.toMatchObject({
      status: "canceled",
      runtimeJobId: "job-2",
      runtimeStopOutcome: { state: "failed" },
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("uses stop-only reconcile for terminal jobs without handoff or replacement", async () => {
    const runtimeBridge = bridge();
    const submit = vi.fn(async () => ({ state: "processing" as const, vendorJobId: "job-1" }));
    const cancel = vi.fn();
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit,
      poll: vi.fn(),
      reconcile: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-1",
        output: { mediaRef: "https://media.example/out.mp4", mimeType: "video/mp4" },
      })),
      cancel,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: runtimeBridge,
      vendors: [vendor],
    });
    await executor.dispatch(dispatch());

    await expect(
      executor.dispatch(dispatch({ op: "cancel", runtimeJobId: "job-1", correlationId: "cancel" })),
    ).resolves.toMatchObject({ runtimeStopOutcome: { state: "confirmed" } });
    expect(cancel).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(runtimeBridge.handoffArtifact).not.toHaveBeenCalled();
  });
});
