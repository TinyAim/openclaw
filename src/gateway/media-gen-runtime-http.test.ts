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
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const AUTH_PASSWORD: ResolvedGatewayAuth = {
  mode: "password",
  token: undefined,
  password: "gateway-password",
  allowTailscale: false,
};

function baseDispatch(overrides: Partial<MediaGenRuntimeDispatch> = {}): MediaGenRuntimeDispatch {
  return {
    op: "submit",
    taskId: "task-1",
    workspaceId: "workspace-1",
    correlationId: "corr-1",
    presetId: "kling",
    mode: "text2video",
    prompt: "a calm product demo",
    ...overrides,
  };
}

async function startServer(params: {
  auth?: ResolvedGatewayAuth;
  executor?: MediaGenRuntimeHttpExecutor;
}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createTestGatewayServer({
    resolvedAuth: params.auth ?? AUTH_TOKEN,
    overrides: { mediaGenRuntimeExecutor: params.executor },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function post(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer test-token" },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${MEDIA_GEN_RUNTIME_DISPATCH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function withMediaGenServer(
  name: string,
  params: Parameters<typeof startServer>[0],
  run: (server: Awaited<ReturnType<typeof startServer>>) => Promise<void>,
): Promise<void> {
  await withGatewayTempConfig(name, async () => {
    const server = await startServer(params);
    try {
      await run(server);
    } finally {
      await server.close();
    }
  });
}

describe("media-generation runtime gateway endpoint", () => {
  it("is wired into the gateway request stages and rejects missing auth", async () => {
    await withMediaGenServer("media-gen-runtime-auth", {}, async ({ url }) => {
      const res = await fetch(`${url}${MEDIA_GEN_RUNTIME_DISPATCH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseDispatch()),
      });

      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Unauthorized");
    });
  });

  it("accepts the gateway password header", async () => {
    const executor = {
      dispatch: vi.fn((input: MediaGenRuntimeDispatch) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing" as const,
        runtimeJobId: "runtime-job-1",
      })),
    };

    await withMediaGenServer(
      "media-gen-runtime-password",
      { auth: AUTH_PASSWORD, executor },
      async ({ url }) => {
        const res = await post(url, baseDispatch(), {
          "x-wisclaw-gateway-password": "gateway-password",
        });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("processing");
        expect(res.body.runtimeJobId).toBe("runtime-job-1");
        expect(executor.dispatch).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("rejects requests carrying both bearer token and gateway password", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-double-auth", { executor }, async ({ url }) => {
      const res = await post(url, baseDispatch(), {
        authorization: "Bearer test-token",
        "x-wisclaw-gateway-password": "gateway-password",
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("either bearer token or gateway password");
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("rejects invalid dispatch shapes before the executor", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-invalid", { executor }, async ({ url }) => {
      const res = await post(url, { ...baseDispatch(), mode: "audio2video" });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("Invalid media-generation runtime dispatch");
      expect(executor.dispatch).not.toHaveBeenCalled();

      const badConsentRef = await post(url, { ...baseDispatch(), consentRef: 42 });
      expect(badConsentRef.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("passes consentRef through with image2video reference dispatches", async () => {
    const executor = {
      dispatch: vi.fn((input: MediaGenRuntimeDispatch) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing" as const,
      })),
    };
    await withMediaGenServer("media-gen-runtime-consent-ref", { executor }, async ({ url }) => {
      const res = await post(
        url,
        baseDispatch({
          mode: "image2video",
          reference: { kind: "artifact", artifactId: "art-1" },
          consent: { subjectType: "portrait", authorized: true },
          consentRef: "mediagen-consent-1",
        }),
      );

      expect(res.status).toBe(200);
      expect(executor.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ consentRef: "mediagen-consent-1" }),
      );
    });
  });

  it("rejects credential and raw-byte smuggling before the executor", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-smuggle", { executor }, async ({ url }) => {
      const res = await post(
        url,
        baseDispatch({
          params: { nested: { apiKey: "sk-should-not-cross-boundary" } },
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        type: "invalid_request_error",
        path: "$.params.nested.apiKey",
      });
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("blocks image2video without reference and authorized consent", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-consent", { executor }, async ({ url }) => {
      const res = await post(url, baseDispatch({ mode: "image2video" }));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toBe("content_blocked");
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("does not re-require image2video reference/consent on poll and cancel", async () => {
    const executor = {
      dispatch: vi.fn((input: MediaGenRuntimeDispatch) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: input.op === "cancel" ? ("canceled" as const) : ("processing" as const),
      })),
    };
    await withMediaGenServer("media-gen-runtime-poll-cancel-no-source", { executor }, async ({ url }) => {
      const poll = await post(
        url,
        baseDispatch({ op: "poll", mode: "image2video", runtimeJobId: "job-1" }),
      );
      const cancel = await post(
        url,
        baseDispatch({ op: "cancel", mode: "image2video", runtimeJobId: "job-1" }),
      );

      expect(poll.status).toBe(200);
      expect(poll.body.status).toBe("processing");
      expect(cancel.status).toBe(200);
      expect(cancel.body.status).toBe("canceled");
      expect(executor.dispatch).toHaveBeenCalledTimes(2);
    });
  });

  it("allows image2video retry with a stored reference and persisted consentRef", async () => {
    const executor = {
      dispatch: vi.fn((input: MediaGenRuntimeDispatch) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing" as const,
      })),
    };
    await withMediaGenServer("media-gen-runtime-retry-consent-ref", { executor }, async ({ url }) => {
      const res = await post(
        url,
        baseDispatch({
          op: "retry",
          mode: "image2video",
          reference: { kind: "artifact", artifactId: "art-1" },
          consentRef: "mediagen-consent-1",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("processing");
      expect(executor.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          op: "retry",
          reference: { kind: "artifact", artifactId: "art-1" },
          consentRef: "mediagen-consent-1",
        }),
      );
    });
  });

  it("forwards a multi-slot references[] dispatch to the executor", async () => {
    const executor = {
      dispatch: vi.fn((input: MediaGenRuntimeDispatch) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing" as const,
      })),
    };
    await withMediaGenServer("media-gen-runtime-references", { executor }, async ({ url }) => {
      const res = await post(
        url,
        baseDispatch({
          presetId: "vidu",
          references: [
            { kind: "artifact", artifactId: "ref-a", role: "subject", ordinal: 0 },
            { kind: "artifact", artifactId: "ref-b", role: "subject", ordinal: 1 },
          ],
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("processing");
      expect(executor.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          references: [
            expect.objectContaining({ artifactId: "ref-a", role: "subject", ordinal: 0 }),
            expect.objectContaining({ artifactId: "ref-b", role: "subject", ordinal: 1 }),
          ],
        }),
      );
    });
  });

  it("passes a per-slot consentRefs set through to the executor", async () => {
    const executor = {
      dispatch: vi.fn((input: MediaGenRuntimeDispatch) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing" as const,
      })),
    };
    await withMediaGenServer("media-gen-runtime-consent-refs", { executor }, async ({ url }) => {
      const res = await post(
        url,
        baseDispatch({
          presetId: "vidu",
          mode: "image2video",
          references: [
            {
              kind: "artifact",
              artifactId: "ref-a",
              role: "subject",
              ordinal: 0,
              consent: { subjectType: "portrait", authorized: true },
            },
          ],
          consentRefs: ["mediagen-consent-0", "mediagen-consent-1"],
        }),
      );

      expect(res.status).toBe(200);
      expect(executor.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          consentRefs: ["mediagen-consent-0", "mediagen-consent-1"],
        }),
      );
    });
  });

  it("rejects a malformed consentRefs set before the executor", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-consent-refs-bad", { executor }, async ({ url }) => {
      // A blank member rejects the whole set (fail-closed, mirrors the contract).
      const blankMember = await post(url, {
        ...baseDispatch(),
        consentRefs: ["ok", ""],
      });
      expect(blankMember.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();

      const notArray = await post(url, { ...baseDispatch(), consentRefs: "nope" });
      expect(notArray.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("rejects a dispatch carrying both a singular reference and references[]", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-ref-both", { executor }, async ({ url }) => {
      const res = await post(
        url,
        baseDispatch({
          reference: { kind: "artifact", artifactId: "art-1" },
          references: [{ kind: "artifact", artifactId: "ref-a", role: "subject", ordinal: 0 }],
        }),
      );

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("Invalid media-generation runtime dispatch");
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("rejects a references[] slot with an unknown role", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-ref-role", { executor }, async ({ url }) => {
      const res = await post(
        url,
        baseDispatch({
          references: [
            { kind: "artifact", artifactId: "ref-a", role: "mascot" } as unknown as never,
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("rejects an empty references[] array", async () => {
    const executor = { dispatch: vi.fn() };
    await withMediaGenServer("media-gen-runtime-ref-empty", { executor }, async ({ url }) => {
      const res = await post(url, baseDispatch({ references: [] }));

      expect(res.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("returns a productized fail-closed result when no runtime executor is configured", async () => {
    await withMediaGenServer("media-gen-runtime-shell", {}, async ({ url }) => {
      const res = await post(url, baseDispatch());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        taskId: "task-1",
        workspaceId: "workspace-1",
        correlationId: "corr-1",
        status: "failed",
        failureReason: "internal",
      });
      expect(String(res.body.failureMessage)).toContain("not configured");
    });
  });

  it("normalizes malformed executor results to failed/internal", async () => {
    const executor = {
      dispatch: vi.fn(() => ({
        taskId: "different-task",
        workspaceId: "workspace-1",
        correlationId: "corr-1",
        status: "totally_done",
      })),
    } as unknown as MediaGenRuntimeHttpExecutor;
    await withMediaGenServer("media-gen-runtime-bad-result", { executor }, async ({ url }) => {
      const res = await post(url, baseDispatch());

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toBe("internal");
      expect(String(res.body.failureMessage)).toContain("invalid result");
    });
  });

  it("flows through startGatewayServer GatewayServerOptions", async () => {
    const { startGatewayServer } = await import("./server.js");
    const port = await getFreePort();
    const executor = {
      dispatch: vi.fn((input: MediaGenRuntimeDispatch) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing" as const,
        runtimeJobId: "runtime-job-from-server-options",
      })),
    };
    const server = await startGatewayServer(port, {
      host: "127.0.0.1",
      auth: { mode: "token", token: "secret" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      mediaGenRuntimeExecutor: executor,
    });
    try {
      const res = await post(`http://127.0.0.1:${port}`, baseDispatch(), {
        authorization: "Bearer secret",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("processing");
      expect(res.body.runtimeJobId).toBe("runtime-job-from-server-options");
      expect(executor.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await server.close({ reason: "media-gen runtime option test done" });
    }
  });
});
