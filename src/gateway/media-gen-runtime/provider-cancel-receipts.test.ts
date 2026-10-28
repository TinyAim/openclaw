import { describe, expect, it, vi } from "vitest";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { createHailuoH3RuntimeVendor } from "./hailuo-h3-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendor } from "./types.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";

function executor(vendor: MediaGenRuntimeVendor) {
  const handoffArtifact = vi.fn();
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: "runtime-1",
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact,
  };
  return {
    runtime: createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] }),
    handoffArtifact,
  };
}

function cancel(presetId: string) {
  return {
    op: "cancel" as const,
    taskId: "task-1",
    workspaceId: "workspace-1",
    correlationId: "cancel-1",
    presetId,
    mode: "image2video" as const,
    runtimeJobId: "job-1",
  };
}

describe("Provider cancellation receipts through the shared executor", () => {
  it.each([
    [{ task_id: "job-1", action: "cancelled", status: "cancelled" }, "confirmed"],
    [{ task_id: "job-1", action: "deleted", status: "deleted" }, "unknown"],
    [{ task_id: "different-job", action: "cancelled", status: "cancelled" }, "unknown"],
  ] as const)("maps the MiniMax receipt %j to %s", async (receipt, expected) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            init?.method === "DELETE"
              ? receipt
              : { task: { id: "job-1", model: "MiniMax-H3", status: "queued" } },
          ),
        ),
    );
    const { runtime, handoffArtifact } = executor(
      createHailuoH3RuntimeVendor({ apiKey: "minimax-key", fetchImpl }),
    );
    await expect(runtime.dispatch(cancel("hailuo"))).resolves.toMatchObject({
      runtimeStopOutcome: { state: expected },
    });
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "DELETE"]);
    expect(handoffArtifact).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "confirmed"],
    [
      { code: 400, reason: "BadRequest", message: "task state is scheduled, can not cancel" },
      "failed",
    ],
    [null, "unknown"],
    [[], "unknown"],
  ] as const)("maps the Vidu HTTP 200 body %j to %s", async (receipt, expected) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Response(JSON.stringify(init?.method === "POST" ? receipt : { state: "processing" })),
    );
    const { runtime, handoffArtifact } = executor(
      createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl }),
    );
    await expect(runtime.dispatch(cancel("vidu"))).resolves.toMatchObject({
      runtimeStopOutcome: { state: expected },
    });
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
    expect(handoffArtifact).not.toHaveBeenCalled();
  });
});
