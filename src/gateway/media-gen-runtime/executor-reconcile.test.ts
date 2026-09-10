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
  it("retains the exact Spatial acceptance across same-process reconcile", async () => {
    const acceptance = {
      schemaVersion: 1 as const,
      envelopeDigest: `spa_env:sha256:${"a".repeat(64)}`,
      references: [
        {
          artifactId: "artifact-spatial",
          checksum: `sha256:${"b".repeat(64)}`,
          role: "composition_frame",
          ordinal: 0,
        },
      ],
      executionAttempt: 1,
      frozenPlanDigest: `sha256:${"c".repeat(64)}`,
      runtimeJobId: "seedance-job-1",
      providerRequestDigest: `sha256:${"d".repeat(64)}`,
    };
    const reconcile = vi.fn(async () => ({
      state: "processing" as const,
      vendorJobId: "seedance-job-1",
    }));
    const submit = vi.fn(async () => ({
      state: "processing" as const,
      vendorJobId: "seedance-job-1",
      spatialInputAcceptance: acceptance,
    }));
    const v: MediaGenRuntimeVendor = {
      presetId: "seedance",
      isConfigured: () => true,
      submit,
      poll: vi.fn(async () => ({
        state: "processing" as const,
        vendorJobId: "seedance-job-1",
      })),
      reconcile,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v],
    });

    await executor.dispatch(dispatch("submit"));
    await expect(executor.dispatch(dispatch("reconcile"))).resolves.toMatchObject({
      status: "processing",
      spatialInputAcceptance: acceptance,
    });
  });

  it("durably records Spatial acceptance before returning the provider receipt", async () => {
    const acceptance = {
      schemaVersion: 1 as const,
      envelopeDigest: `spa_env:sha256:${"a".repeat(64)}`,
      references: [
        {
          artifactId: "artifact-spatial",
          checksum: `sha256:${"b".repeat(64)}`,
          role: "composition_frame" as const,
          ordinal: 0,
        },
      ],
      executionAttempt: 1,
      frozenPlanDigest: `sha256:${"c".repeat(64)}`,
      runtimeJobId: "seedance-job-1",
      providerRequestDigest: `sha256:${"d".repeat(64)}`,
    };
    const submit = vi.fn(async () => ({
      state: "processing" as const,
      vendorJobId: "seedance-job-1",
      spatialInputAcceptance: acceptance,
    }));
    const v: MediaGenRuntimeVendor = {
      presetId: "seedance",
      isConfigured: () => true,
      submit,
      poll: vi.fn(async () => ({
        state: "processing" as const,
        vendorJobId: "seedance-job-1",
      })),
    };
    const persisted: unknown[] = [];
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v],
      persistSpatialInputAcceptance: vi.fn((input, value) => {
        persisted.push({ input, value });
      }),
    });

    await expect(
      executor.dispatch(
        dispatch("submit", {
          executionAttempt: 1,
          frozenPlanDigest: acceptance.frozenPlanDigest,
          spatialInputEnvelope: {
            schemaVersion: 1,
            envelopeDigest: acceptance.envelopeDigest,
            references: acceptance.references,
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "processing",
      runtimeJobId: acceptance.runtimeJobId,
    });
    expect(persisted).toEqual([
      expect.objectContaining({
        value: acceptance,
      }),
    ]);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("returns submission_unknown and does not bind a receipt when durable acceptance fails", async () => {
    const acceptance = {
      schemaVersion: 1 as const,
      envelopeDigest: `spa_env:sha256:${"a".repeat(64)}`,
      references: [],
      executionAttempt: 1,
      frozenPlanDigest: `sha256:${"c".repeat(64)}`,
      runtimeJobId: "seedance-job-unknown",
      providerRequestDigest: `sha256:${"d".repeat(64)}`,
    };
    const submit = vi.fn(async () => ({
      state: "processing" as const,
      vendorJobId: acceptance.runtimeJobId,
      spatialInputAcceptance: acceptance,
    }));
    const reconcile = vi.fn();
    const v: MediaGenRuntimeVendor = {
      presetId: "seedance",
      isConfigured: () => true,
      submit,
      poll: vi.fn(),
      reconcile,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge: bridge(),
      vendors: [v],
      persistSpatialInputAcceptance: () => {
        throw new Error("durable store unavailable");
      },
    });

    await expect(
      executor.dispatch(
        dispatch("submit", {
          executionAttempt: 1,
          frozenPlanDigest: acceptance.frozenPlanDigest,
          spatialInputEnvelope: {
            schemaVersion: 1,
            envelopeDigest: acceptance.envelopeDigest,
            references: acceptance.references,
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "submission_unknown",
      failureReason: "internal",
      providerRequestDigest: acceptance.providerRequestDigest,
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(
      await executor.dispatch(
        dispatch("reconcile", {
          executionAttempt: 1,
          frozenPlanDigest: acceptance.frozenPlanDigest,
          spatialInputEnvelope: {
            schemaVersion: 1,
            envelopeDigest: acceptance.envelopeDigest,
            references: acceptance.references,
          },
        }),
      ),
    ).toMatchObject({ status: "submission_unknown" });
    expect(reconcile).not.toHaveBeenCalled();
  });

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
