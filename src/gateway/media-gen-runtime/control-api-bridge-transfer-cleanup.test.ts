import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createControlApiMediaGenBridge } from "./control-api-bridge.js";

type Mode = "status" | "declaredSize" | "streamSize" | "success";
const bytes = Buffer.from("test-ref");
const dispatch: MediaGenRuntimeDispatch = {
  op: "submit",
  taskId: "test-task",
  workspaceId: "test-workspace",
  correlationId: "test-correlation",
  presetId: "kling",
  mode: "image2video",
  prompt: "A lantern beside a canal.",
};
async function harness(mode: Mode) {
  const sockets = new Set<Socket>();
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/reference-grant")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { grantToken: "test-only-grant", mimeType: "image/png" } }));
      return;
    }
    res.once("close", closed);
    res.writeHead(mode === "status" ? 503 : 200, {
      "content-type": "image/png",
      ...(mode === "declaredSize" ? { "content-length": "1024" } : {}),
    });
    if (mode === "success") res.end(bytes);
    else res.write(mode === "streamSize" ? Buffer.alloc(17, 97) : bytes);
  });
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
    throw new Error("controlled reference HTTP address missing");
  const bridge = createControlApiMediaGenBridge({
    controlApiUrl: `http://127.0.0.1:${address.port}`,
    runtimeId: "test-runtime",
    token: "test-only-token",
    maxReferenceBytes: 16,
  });
  return {
    bridge,
    responseClosed,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("Host reference redeem rejected transfer cleanup", () => {
  it.each(["status", "declaredSize", "streamSize"] as const)(
    "closes rejected unending reference transfer for %s",
    async (mode) => {
      const h = await harness(mode);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          h.bridge.resolveArtifactReference({ dispatch, artifactId: "test-reference" }),
        ).rejects.toThrow(mode === "status" ? "status 503" : "exceeds max bytes");
        const didClose = await Promise.race([
          h.responseClosed.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 500);
          }),
        ]);
        expect(didClose).toBe(true);
      } finally {
        if (timer) clearTimeout(timer);
        await h.close();
      }
    },
  );
  it("keeps successful reference bytes and their actual checksum", async () => {
    const h = await harness("success");
    try {
      expect(
        await h.bridge.resolveArtifactReference({ dispatch, artifactId: "test-reference" }),
      ).toMatchObject({
        bytes,
        mimeType: "image/png",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await h.close();
    }
  });
});
