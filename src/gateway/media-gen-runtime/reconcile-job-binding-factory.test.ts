import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MediaGenRuntimeDispatch,
  MediaGenRuntimeHttpExecutor,
  MediaGenRuntimeResult,
} from "../media-gen-runtime-http.js";
import type { MediaGenRuntimeExecutorOptions } from "./executor.js";

const executorHarness = vi.hoisted(() => ({
  options: undefined as MediaGenRuntimeExecutorOptions | undefined,
}));

vi.mock("./executor.js", () => ({
  createOpenClawMediaGenRuntimeExecutor: (
    options: MediaGenRuntimeExecutorOptions,
  ): MediaGenRuntimeHttpExecutor => {
    executorHarness.options = options;
    return {
      async dispatch(dispatch: MediaGenRuntimeDispatch): Promise<MediaGenRuntimeResult> {
        const runtimeJobId = options.resolveReconcileJobReceipt?.(dispatch);
        return {
          taskId: dispatch.taskId,
          workspaceId: dispatch.workspaceId,
          correlationId: dispatch.correlationId,
          status: runtimeJobId ? "processing" : "submission_unknown",
          ...(runtimeJobId ? { runtimeJobId } : {}),
        };
      },
    };
  },
}));

import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";

const FROZEN_PLAN_DIGEST = `sha256:${"a".repeat(64)}`;

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "workspace-reconcile",
    taskId: "task-reconcile",
    presetId: "kling",
    mode: "text2video",
    executionAttempt: 1,
    frozenPlanDigest: FROZEN_PLAN_DIGEST,
    runtimeJobId: "text2video-v2:provider-job-1",
    ...overrides,
  };
}

function enabledEnv(bindings: unknown): Record<string, string> {
  return {
    OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
    OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
    OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-reconcile-bind",
    OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-reconcile-bind",
    OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "workspace-reconcile",
    KLING_ACCESS_KEY: "kling-access",
    KLING_SECRET: "kling-secret",
    OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
    OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeling.example/apply",
    OPENCLAW_MEDIA_GEN_RECONCILE_JOB_BINDINGS_JSON: JSON.stringify(bindings),
  };
}

function dispatch(overrides: Partial<MediaGenRuntimeDispatch> = {}): MediaGenRuntimeDispatch {
  return {
    op: "reconcile",
    taskId: "task-reconcile",
    workspaceId: "workspace-reconcile",
    correlationId: "correlation-reconcile",
    presetId: "kling",
    mode: "text2video",
    executionAttempt: 1,
    frozenPlanDigest: FROZEN_PLAN_DIGEST,
    ...overrides,
  };
}

describe("owner-only reconcile job binding factory", () => {
  beforeEach(() => {
    executorHarness.options = undefined;
  });

  it("binds only the exact task-attempt and frozen-plan identity", async () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv([binding()]),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;

    await expect(result.executor.dispatch(dispatch())).resolves.toMatchObject({
      status: "processing",
      runtimeJobId: "text2video-v2:provider-job-1",
    });
    await expect(
      result.executor.dispatch(dispatch({ workspaceId: "workspace-other" })),
    ).resolves.toMatchObject({ status: "submission_unknown" });
    await expect(
      result.executor.dispatch(dispatch({ mode: "image2video" })),
    ).resolves.toMatchObject({ status: "submission_unknown" });
    await expect(
      result.executor.dispatch(dispatch({ executionAttempt: 2 })),
    ).resolves.toMatchObject({ status: "submission_unknown" });
    await expect(
      result.executor.dispatch(dispatch({ frozenPlanDigest: `sha256:${"b".repeat(64)}` })),
    ).resolves.toMatchObject({ status: "submission_unknown" });
  });

  it.each([
    "not-json",
    JSON.stringify([]),
    JSON.stringify([{ workspaceId: "workspace-reconcile" }]),
    JSON.stringify([binding({ workspaceId: "workspace-other" })]),
    JSON.stringify([binding({ mode: "unknown" })]),
    JSON.stringify([binding({ runtimeJobId: "https://unsafe.example/job" })]),
    JSON.stringify([binding({ executionAttempt: 0 })]),
    JSON.stringify([binding({ frozenPlanDigest: "sha256:bad" })]),
  ])("disables the executor for an invalid binding document", (raw) => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        ...enabledEnv([]),
        OPENCLAW_MEDIA_GEN_RECONCILE_JOB_BINDINGS_JSON: raw,
      },
    });
    expect(result).toEqual({
      enabled: false,
      reason: "OPENCLAW_MEDIA_GEN_RECONCILE_JOB_BINDINGS_JSON is invalid",
    });
  });
});
