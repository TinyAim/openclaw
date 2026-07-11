import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  MEDIA_STUDIO_ASSEMBLY_RENDER_CANCEL_PATH,
  MEDIA_STUDIO_ASSEMBLY_RENDER_PATH,
  parseAssemblyRenderCancel,
  parseAssemblyRenderDispatch,
  type MediaStudioAssemblyRenderHttpExecutor,
} from "./media-studio-assembly-render-http.js";
import {
  AUTH_TOKEN,
  createTestGatewayServer,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";
import { installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const AUTH_PASSWORD: ResolvedGatewayAuth = {
  mode: "password",
  token: undefined,
  password: "gateway-password",
  allowTailscale: false,
};

function baseDispatch(overrides: Record<string, unknown> = {}) {
  return {
    kind: "media_studio.assembly_render",
    workspaceId: "ws-1",
    projectId: "p-1",
    assemblyId: "asm-1",
    renderId: "r-1",
    dispatchEpoch: 2,
    dispatchAttemptId: "rda_1",
    timeline: [{ shotId: "s1", artifactId: "a1", durationSec: 3 }],
    callbackContract: {
      progressPath: "/v1/control/media-gen/runtime/render/progress",
      completePath: "/v1/control/media-gen/runtime/render/complete",
    },
    ...overrides,
  };
}

async function startServer(params: {
  auth?: ResolvedGatewayAuth;
  executor?: MediaStudioAssemblyRenderHttpExecutor;
}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createTestGatewayServer({
    resolvedAuth: params.auth ?? AUTH_TOKEN,
    overrides: {
      mediaStudioAssemblyRenderExecutor: params.executor,
    },
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
  path: string,
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer test-token" },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
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

describe("media-studio assembly-render parser", () => {
  it("accepts valid Control API relay body", () => {
    const parsed = parseAssemblyRenderDispatch(baseDispatch());
    expect(parsed?.renderId).toBe("r-1");
    expect(parsed?.timeline).toHaveLength(1);
    expect(parsed?.callbackContract?.completePath).toContain("render/complete");
  });

  it("rejects empty timeline and wrong kind", () => {
    expect(parseAssemblyRenderDispatch(baseDispatch({ timeline: [] }))).toBeNull();
    expect(
      parseAssemblyRenderDispatch(baseDispatch({ kind: "other" })),
    ).toBeNull();
  });

  it("parses cancel body", () => {
    const cancel = parseAssemblyRenderCancel({
      kind: "media_studio.assembly_render.cancel",
      workspaceId: "ws-1",
      renderId: "r-1",
      dispatchEpoch: 2,
    });
    expect(cancel?.renderId).toBe("r-1");
    expect(cancel?.dispatchEpoch).toBe(2);
  });
});

describe("media-studio assembly-render gateway endpoint", () => {
  it("is wired and rejects missing auth", async () => {
    await withGatewayTempConfig("asm-render-auth", async () => {
      const server = await startServer({});
      try {
        const res = await fetch(
          `${server.url}${MEDIA_STUDIO_ASSEMBLY_RENDER_PATH}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(baseDispatch()),
          },
        );
        expect(res.status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });

  it("fail-closed without executor (accepted=false)", async () => {
    await withGatewayTempConfig("asm-render-no-exec", async () => {
      const server = await startServer({});
      try {
        const res = await post(
          server.url,
          MEDIA_STUDIO_ASSEMBLY_RENDER_PATH,
          baseDispatch(),
        );
        expect(res.status).toBe(200);
        expect(res.body.accepted).toBe(false);
        expect(res.body.messageKey).toBe(
          "media_studio.render.runtime_executor_not_configured",
        );
      } finally {
        await server.close();
      }
    });
  });

  it("accepts when executor is configured", async () => {
    await withGatewayTempConfig("asm-render-exec", async () => {
      const seen: string[] = [];
      const server = await startServer({
        executor: {
          dispatch(input) {
            seen.push(input.renderId);
            return { accepted: true };
          },
        },
      });
      try {
        const res = await post(
          server.url,
          MEDIA_STUDIO_ASSEMBLY_RENDER_PATH,
          baseDispatch(),
        );
        expect(res.status).toBe(200);
        expect(res.body.accepted).toBe(true);
        expect(seen).toEqual(["r-1"]);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects invalid body with 400", async () => {
    await withGatewayTempConfig("asm-render-bad", async () => {
      const server = await startServer({});
      try {
        const res = await post(
          server.url,
          MEDIA_STUDIO_ASSEMBLY_RENDER_PATH,
          { kind: "media_studio.assembly_render", renderId: "only" },
        );
        expect(res.status).toBe(400);
      } finally {
        await server.close();
      }
    });
  });

  it("cancel path works with password auth", async () => {
    await withGatewayTempConfig("asm-render-cancel", async () => {
      let cancelled: string | undefined;
      const server = await startServer({
        auth: AUTH_PASSWORD,
        executor: {
          dispatch: () => ({ accepted: true }),
          cancel(input) {
            cancelled = input.renderId;
            return { cancelled: true };
          },
        },
      });
      try {
        const res = await post(
          server.url,
          MEDIA_STUDIO_ASSEMBLY_RENDER_CANCEL_PATH,
          {
            kind: "media_studio.assembly_render.cancel",
            workspaceId: "ws-1",
            renderId: "r-9",
          },
          { "x-wisclaw-gateway-password": "gateway-password" },
        );
        expect(res.status).toBe(200);
        expect(res.body.cancelled).toBe(true);
        expect(cancelled).toBe("r-9");
      } finally {
        await server.close();
      }
    });
  });
});
