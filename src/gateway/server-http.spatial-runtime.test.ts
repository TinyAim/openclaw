/** Verifies Spatial Runtime handlers are mounted through the real gateway HTTP pipeline. */
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };

async function listen(server: ReturnType<typeof createGatewayHttpServer>): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function closeServer(server: ReturnType<typeof createGatewayHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => {
  delete process.env.OPENCLAW_GATEWAY_PORT;
});

describe("gateway Spatial Runtime route mounting", () => {
  it("routes both Spatial endpoints to their strict parsers", async () => {
    await withTempConfig({
      cfg: { gateway: { auth: { mode: "none" } } },
      run: async () => {
        const server = createGatewayHttpServer({
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
          spatialReferenceRuntimeExecutor: {
            dispatch: async () => {
              throw new Error("invalid payload must not reach executor");
            },
            cancel: () => ({ acknowledged: true, terminal: false }),
          },
          spatialEnvironmentPanoramaRuntimeExecutor: {
            dispatch: async () => {
              throw new Error("invalid payload must not reach executor");
            },
            cancel: () => ({ acknowledged: true, terminal: false }),
          },
        });
        const port = await listen(server);
        try {
          for (const path of [
            "/v1/runtime/media-studio/spatial-reference/render",
            "/v1/runtime/media-studio/spatial-environment/panorama",
          ]) {
            const response = await fetch(`http://127.0.0.1:${port}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            });
            expect(response.status, path).toBe(400);
          }
        } finally {
          await closeServer(server);
        }
      },
    });
  });
});
