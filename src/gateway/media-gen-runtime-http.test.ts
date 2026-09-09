import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  MEDIA_GEN_RUNTIME_DISPATCH_PATH,
  type MediaGenRuntimeDispatch,
  type MediaGenRuntimeHttpExecutor,
} from "./media-gen-runtime-http.js";
import {
  AUTH_TOKEN,
  createTestGatewayServer,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";

function dispatchBody(): MediaGenRuntimeDispatch {
  return {
    op: "submit",
    taskId: "task-1",
    workspaceId: "workspace-1",
    correlationId: "corr-1",
    presetId: "kling",
    mode: "text2video",
    prompt: "a calm product demo",
  };
}

async function withServer(
  params: { auth?: ResolvedGatewayAuth; executor?: MediaGenRuntimeHttpExecutor },
  run: (url: string) => Promise<void>,
): Promise<void> {
  await withGatewayTempConfig("media-gen-runtime-http", async () => {
    const server: Server = createTestGatewayServer({
      resolvedAuth: params.auth ?? AUTH_TOKEN,
      overrides: { mediaGenRuntimeExecutor: params.executor },
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

async function post(
  url: string,
  authorization?: string,
  body: MediaGenRuntimeDispatch | Record<string, unknown> = dispatchBody(),
): Promise<Response> {
  return await fetch(`${url}${MEDIA_GEN_RUNTIME_DISPATCH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("media-generation runtime gateway registration", () => {
  it("mounts the route behind gateway authentication", async () => {
    const executor = { dispatch: vi.fn() };
    await withServer({ executor }, async (url) => {
      const response = await post(url);
      expect(response.status).toBe(401);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("dispatches through the injected executor", async () => {
    const executor: MediaGenRuntimeHttpExecutor = {
      dispatch: vi.fn((input) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing" as const,
        runtimeJobId: "runtime-job-1",
      })),
    };
    await withServer({ executor }, async (url) => {
      const response = await post(url, "Bearer test-token");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "processing",
        runtimeJobId: "runtime-job-1",
      });
      expect(executor.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects an unnegotiated Spatial envelope before an executor can run", async () => {
    const executor = { dispatch: vi.fn() };
    await withServer({ executor }, async (url) => {
      const response = await post(url, "Bearer test-token", {
        ...dispatchBody(),
        spatialInputEnvelope: {
          schemaVersion: 1,
          envelopeDigest: `spa_env:sha256:${"a".repeat(64)}`,
        },
      });
      expect(response.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("keeps the route fail-closed when no executor is configured", async () => {
    await withServer({}, async (url) => {
      const response = await post(url, "Bearer test-token");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "failed",
        failureReason: "internal",
      });
    });
  });
});
