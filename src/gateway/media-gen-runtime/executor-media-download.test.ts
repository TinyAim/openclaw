import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { downloadMedia } from "./executor-media-download.js";

async function serve(
  mode: "mime" | "size" | "status" | "success" | "streamSize" | "bodyTimeout" | "exactSize",
) {
  const sockets = new Set<Socket>();
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((_req, res) => {
    res.once("close", closed);
    res.writeHead(mode === "status" ? 503 : 200, {
      "content-type": mode === "mime" ? "application/json" : "video/mp4",
      ...(mode === "size" ? { "content-length": "10000" } : {}),
    });
    if (mode === "success") res.end("real-transfer-bytes");
    else if (mode === "exactSize") res.end(Buffer.alloc(64, 97));
    else if (mode === "streamSize") res.write(Buffer.alloc(65, 97));
    else res.write("prefix"); // Deliberately unending rejected body.
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
  if (!address || typeof address === "string") throw new Error("test address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/output`,
    responseClosed,
    async cleanup() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const options = {
  fetchImpl: globalThis.fetch,
  timeoutMs: 5000,
  maxBytes: 64,
  allowedHosts: ["127.0.0.1"],
  allowInsecure: true,
};
describe("Runtime output download transfer cleanup", () => {
  it.each(["mime", "size", "status"] as const)(
    "closes an unending body rejected for %s",
    async (mode) => {
      const h = await serve(mode);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          downloadMedia({ mediaRef: h.url, mimeType: "video/mp4" }, options),
        ).rejects.toThrow();
        const didClose = await Promise.race([
          h.responseClosed.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 500);
          }),
        ]);
        expect(didClose).toBe(true);
      } finally {
        if (timer) clearTimeout(timer);
        await h.cleanup();
      }
    },
  );
  it("keeps successfully downloaded bytes after transfer cleanup", async () => {
    const h = await serve("success");
    try {
      const result = await downloadMedia({ mediaRef: h.url, mimeType: "video/mp4" }, options);
      expect(result.bytes).toEqual(Buffer.from("real-transfer-bytes"));
      expect(result.mimeType).toBe("video/mp4");
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await h.cleanup();
    }
  });
});

describe("Runtime output streaming and deadline boundaries", () => {
  it.each(["streamSize", "bodyTimeout"] as const)(
    "rejects and closes %s after receiving headers",
    async (mode) => {
      const h = await serve(mode);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          downloadMedia(
            { mediaRef: h.url, mimeType: "video/mp4" },
            { ...options, timeoutMs: mode === "bodyTimeout" ? 150 : options.timeoutMs },
          ),
        ).rejects.toThrow(mode === "streamSize" ? "exceeds max bytes" : /abort/iu);
        const didClose = await Promise.race([
          h.responseClosed.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 500);
          }),
        ]);
        expect(didClose).toBe(true);
      } finally {
        if (timer) clearTimeout(timer);
        await h.cleanup();
      }
    },
  );
  it("accepts exactly the maximum streamed bytes and computes their actual digest", async () => {
    const h = await serve("exactSize");
    try {
      const result = await downloadMedia({ mediaRef: h.url, mimeType: "video/mp4" }, options);
      const expected = Buffer.alloc(options.maxBytes, 97);
      expect(result.bytes).toEqual(expected);
      expect(result.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
    } finally {
      await h.cleanup();
    }
  });
  it("rejects a hostname outside the allowlist before starting a transfer", async () => {
    const fetchImpl = vi.fn(async () => new Response("unexpected transfer"));
    await expect(
      downloadMedia(
        { mediaRef: "https://other.test/output", mimeType: "video/mp4" },
        { ...options, allowedHosts: ["allowed.test"], fetchImpl },
      ),
    ).rejects.toThrow("not allowlisted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
