import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";

const token = "test-only-runtime-token";
const tokenHeader = "x-wisclaw-media-gen-runtime-token";
const paths = {
  register: "/v1/control/media-gen/runtime/register",
  grant: "/v1/control/media-gen/runtime/reference-grant",
  redeem: "/v1/control/media-gen/runtime/reference-redeem",
  handoff: "/v1/control/media-gen/runtime/artifact-handoff",
} as const;
type Lane = keyof typeof paths;
const dispatch: MediaGenRuntimeDispatch = {
  op: "submit",
  taskId: "test-task",
  workspaceId: "test-workspace",
  correlationId: "test-correlation",
  presetId: "kling",
  mode: "image2video",
  prompt: "A lantern beside a canal.",
};

async function listen(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("controlled HTTP test address missing");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function harness(redirectLane?: Lane) {
  const state = { foreignRequests: 0, leakedToken: false, authenticatedOriginRequests: 0 };
  const data = {
    grantToken: "test-only-grant",
    mimeType: "image/png",
    artifact: { artifactId: "test-artifact" },
  };
  const foreign = await listen(
    createServer((req, res) => {
      state.foreignRequests++;
      state.leakedToken ||= req.headers[tokenHeader] === token;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    }),
  );
  let origin;
  try {
    origin = await listen(
      createServer((req, res) => {
        if (req.headers[tokenHeader] === token) state.authenticatedOriginRequests++;
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (redirectLane && path === paths[redirectLane]) {
          res.writeHead(307, { location: `${foreign.url}/foreign` });
          res.end();
        } else if (path === paths.redeem) {
          res.writeHead(200, { "content-type": "image/png" });
          res.end("test-reference-bytes");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data }));
        }
      }),
    );
  } catch (error) {
    await foreign.close();
    throw error;
  }
  const bridge = createControlApiMediaGenBridge({
    controlApiUrl: origin.url,
    runtimeId: "test-runtime",
    token,
  });
  async function operation(lane: Lane) {
    if (lane === "register")
      return bridge.register({
        workspaceId: dispatch.workspaceId,
        supportedPresetIds: ["kling"],
        enforcesModeration: false,
        appliesLabeling: false,
      });
    if (lane === "grant" || lane === "redeem")
      return bridge.resolveArtifactReference({ dispatch, artifactId: "test-source" });
    const bytes = Buffer.from("test-output-bytes");
    return bridge.handoffArtifact({
      dispatch,
      runtimeJobId: "test-job",
      output: { mediaRef: "https://example.test/output", mimeType: "video/mp4" },
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return {
    state,
    operation,
    async close() {
      await Promise.all([origin.close(), foreign.close()]);
    },
  };
}

describe("Host Control API bridge runtime token redirect boundary", () => {
  it.each(["register", "grant", "redeem", "handoff"] as const)(
    "%s refuses redirect without sending runtime token to another origin",
    async (lane) => {
      const h = await harness(lane);
      try {
        const resolved = await h.operation(lane).then(
          () => true,
          () => false,
        );
        expect.soft(resolved).toBe(false);
        expect.soft(h.state.foreignRequests).toBe(0);
        expect(h.state.leakedToken).toBe(false);
      } finally {
        await h.close();
      }
    },
  );
  it("keeps canonical authenticated registration, reference redemption and Artifact handoff working", async () => {
    const h = await harness();
    try {
      await h.operation("register");
      const source = await h.operation("redeem");
      expect(source).toMatchObject({
        bytes: Buffer.from("test-reference-bytes"),
        mimeType: "image/png",
      });
      expect(await h.operation("handoff")).toMatchObject({ artifactId: "test-artifact" });
      expect(h.state).toEqual({
        foreignRequests: 0,
        leakedToken: false,
        authenticatedOriginRequests: 4,
      });
    } finally {
      await h.close();
    }
  });
});
