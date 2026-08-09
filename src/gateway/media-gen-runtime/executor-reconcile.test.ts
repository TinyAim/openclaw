import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendor } from "./types.js";

function dispatch(
  op: MediaGenRuntimeDispatch["op"],
  overrides: Partial<MediaGenRuntimeDispatch> = {},
): MediaGenRuntimeDispatch {
  return {
    op,
    taskId: "task-reconcile",
    workspaceId: "workspace-reconcile",
    correlationId: `correlation-${op}`,
    presetId: "seedance",
    mode: "text2video",
    prompt: "one existing provider attempt",
    ...overrides,
  } as MediaGenRuntimeDispatch;
}

function bridge(): MediaGenRuntimeBridge {
  return {
    runtimeId: "runtime-reconcile",
    register: vi.fn(async () => undefined),
    resolveArtifactReference: vi.fn(async () => ({
      bytes: Buffer.from("unused"),
      mimeType: "image/png",
    })),
    handoffArtifact: vi.fn(async ({ sha256, output }) => ({
      artifactId: "artifact-reconciled",
      sha256,
      mimeType: output.mimeType,
    })),
  };
}

function vendor(input: { reconcile?: MediaGenRuntimeVendor["reconcile"] }) {
  const submit = vi.fn(async () => ({
    state: "processing" as const,
    vendorJobId: "seedance-job-1",
  }));
  const poll = vi.fn(async () => ({
    state: "processing" as const,
    vendorJobId: "seedance-job-1",
  }));
  const implementation: MediaGenRuntimeVendor = {
    presetId: "seedance",
    isConfigured: () => true,
    submit,
    poll,
    ...(input.reconcile ? { reconcile: input.reconcile } : {}),
  };
  return { implementation, submit, poll };
}

describe("OpenClaw executor reconcile honesty", () => {
  it("keeps reconcile closed at the public parser without weakening poll/cancel", () => {
    expect(parseDispatch(dispatch("reconcile"))).toMatchObject({ op: "reconcile" });
    expect(parseDispatch(dispatch("reconcile", { runtimeJobId: "seedance-job-1" }))).toMatchObject({
      op: "reconcile",
      runtimeJobId: "seedance-job-1",
    });
    expect(
      parseDispatch(
        dispatch("reconcile", {
          executionAttempt: 2,
          frozenPlanDigest: `sha256:${"a".repeat(64)}`,
        }),
      ),
    ).toMatchObject({ executionAttempt: 2, frozenPlanDigest: `sha256:${"a".repeat(64)}` });
    expect(parseDispatch(dispatch("reconcile", { executionAttempt: 2 }))).toBeNull();
    expect(parseDispatch(dispatch("poll"))).toBeNull();
    expect(parseDispatch(dispatch("cancel"))).toBeNull();
    expect(parseDispatch({ ...dispatch("reconcile"), op: "unknown" })).toBeNull();
  });

  it("binds a terminal provider failure to the explicit runtimeJobId without creating a job", async () => {
    const reconcile = vi.fn(async () => ({
      state: "failed" as const,
      vendorJobId: "seedance-job-1",
      reason: "vendor_failed" as const,
      message: "The original provider job failed.",
      retryDisposition: "reconcile_only" as const,
    }));
    const v = vendor({ reconcile });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v.implementation],
    });

    await expect(
      executor.dispatch(dispatch("reconcile", { runtimeJobId: "seedance-job-1" })),
    ).resolves.toMatchObject({
      status: "failed",
      runtimeJobId: "seedance-job-1",
      failureReason: "vendor_failed",
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith("seedance-job-1");
    expect(v.submit).not.toHaveBeenCalled();
    expect(v.poll).not.toHaveBeenCalled();
  });

  it("recovers the tracked original receipt by taskId when runtimeJobId is absent", async () => {
    const reconcile = vi.fn(async () => ({
      state: "processing" as const,
      vendorJobId: "seedance-job-1",
    }));
    const v = vendor({ reconcile });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v.implementation],
    });
    await executor.dispatch(dispatch("submit"));

    await expect(executor.dispatch(dispatch("reconcile"))).resolves.toMatchObject({
      status: "processing",
      runtimeJobId: "seedance-job-1",
    });
    expect(reconcile).toHaveBeenCalledWith("seedance-job-1");
    expect(v.submit).toHaveBeenCalledTimes(1);
    expect(v.poll).not.toHaveBeenCalled();
  });

  it("falls back to poll for an explicit receipt when the vendor has no reconcile method", async () => {
    const v = vendor({});
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v.implementation],
    });

    await expect(
      executor.dispatch(dispatch("reconcile", { runtimeJobId: "seedance-job-1" })),
    ).resolves.toMatchObject({ status: "processing", runtimeJobId: "seedance-job-1" });
    expect(v.poll).toHaveBeenCalledWith("seedance-job-1");
    expect(v.submit).not.toHaveBeenCalled();
  });

  it("returns submission_unknown with zero vendor I/O when no receipt exists", async () => {
    const reconcile = vi.fn();
    const v = vendor({ reconcile });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v.implementation],
    });

    await expect(executor.dispatch(dispatch("reconcile"))).resolves.toMatchObject({
      status: "submission_unknown",
      failureReason: "internal",
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(v.poll).not.toHaveBeenCalled();
    expect(v.submit).not.toHaveBeenCalled();
  });

  it("uses an exact owner-bound receipt after restart without creating a job", async () => {
    const reconcile = vi.fn(async () => ({
      state: "processing" as const,
      vendorJobId: "seedance-job-manually-bound",
    }));
    const v = vendor({ reconcile });
    const resolveReconcileJobReceipt = vi.fn(() => "seedance-job-manually-bound");
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v.implementation],
      resolveReconcileJobReceipt,
    });

    await expect(
      executor.dispatch(
        dispatch("reconcile", {
          executionAttempt: 1,
          frozenPlanDigest: `sha256:${"a".repeat(64)}`,
        }),
      ),
    ).resolves.toMatchObject({
      status: "processing",
      runtimeJobId: "seedance-job-manually-bound",
    });
    expect(resolveReconcileJobReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-reconcile",
        taskId: "task-reconcile",
        presetId: "seedance",
        mode: "text2video",
        executionAttempt: 1,
        frozenPlanDigest: `sha256:${"a".repeat(64)}`,
      }),
    );
    expect(reconcile).toHaveBeenCalledWith("seedance-job-manually-bound");
    expect(v.submit).not.toHaveBeenCalled();
    expect(v.poll).not.toHaveBeenCalled();
  });

  it("fails closed on task/job mismatch with zero reconciliation I/O", async () => {
    const reconcile = vi.fn();
    const v = vendor({ reconcile });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v.implementation],
    });
    await executor.dispatch(dispatch("submit"));

    await expect(
      executor.dispatch(dispatch("reconcile", { runtimeJobId: "seedance-job-other" })),
    ).resolves.toMatchObject({ status: "failed", failureReason: "internal" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(v.poll).not.toHaveBeenCalled();
    expect(v.submit).toHaveBeenCalledTimes(1);
  });
});
