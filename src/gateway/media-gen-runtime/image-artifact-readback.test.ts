import { describe, expect, it, vi } from "vitest";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";

const input = {
  dispatch: {
    taskId: "task-1",
    workspaceId: "workspace-1",
    presetId: "image-route-1",
    executionAttempt: 3,
    frozenPlanDigest: `sha256:${"a".repeat(64)}`,
  },
  runtimeJobId: "image:original-job",
  output: { mediaRef: "runtime-local://image:original-job", mimeType: "image/png" },
  sha256: "b".repeat(64),
  submissionCorrelationId: "original-submit",
};
function harness(data: unknown, status = 200) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ data }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  const bridge = createControlApiMediaGenBridge({
    controlApiUrl: "https://control.example.test",
    runtimeId: "runtime-1",
    token: "synthetic-registration-token",
    fetchImpl,
  });
  return { bridge, fetchImpl };
}

describe("existing Artifact endpoint Image readback", () => {
  it("GETs the original tuple and immutable submission correlation with machine auth and no request body", async () => {
    const artifact = {
      artifactId: "artifact-original",
      mimeType: input.output.mimeType,
      sha256: input.sha256,
    };
    const h = harness({ state: "committed", artifact });
    await expect(h.bridge.readImageArtifactHandoff!(input)).resolves.toEqual({
      state: "committed",
      artifact,
    });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = h.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/v1/control/media-gen/runtime/artifact-handoff");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workspaceId: "workspace-1",
      runtimeId: "runtime-1",
      taskId: "task-1",
      presetId: "image-route-1",
      runtimeJobId: input.runtimeJobId,
      executionAttempt: "3",
      frozenPlanDigest: input.dispatch.frozenPlanDigest,
      mimeType: "image/png",
      sha256: input.sha256,
      submissionCorrelationId: "original-submit",
    });
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        "x-wisclaw-media-gen-runtime-token": "synthetic-registration-token",
      },
    });
    expect(init.body).toBeUndefined();
  });
  it("keeps pending as pending without a no-effect, replacement or synthetic Artifact claim", async () => {
    const h = harness({ state: "pending" });
    await expect(h.bridge.readImageArtifactHandoff!(input)).resolves.toEqual({ state: "pending" });
  });
  it.each([
    { state: "not_submitted" },
    { state: "pending", artifact: {} },
    {
      state: "committed",
      artifact: { artifactId: "artifact-x", mimeType: "image/png", sha256: "c".repeat(64) },
    },
    {
      state: "committed",
      artifact: { artifactId: "artifact-x", mimeType: "image/jpeg", sha256: input.sha256 },
    },
    {
      state: "committed",
      artifact: {
        artifactId: "artifact-x",
        mimeType: "image/png",
        sha256: input.sha256,
        url: "https://private.example.test",
      },
    },
  ])("rejects malformed or conflicting readback %j", async (data) => {
    const h = harness(data);
    await expect(h.bridge.readImageArtifactHandoff!(input)).rejects.toThrow(
      "invalid image artifact readback",
    );
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not retry a 404 readback as a POST", async () => {
    const h = harness({ state: "pending" }, 404);
    await expect(h.bridge.readImageArtifactHandoff!(input)).rejects.toThrow("status 404");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
