import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { downloadMedia } from "./executor-media-download.js";

const options = {
  timeoutMs: 1000,
  maxBytes: 64,
  allowedHosts: ["media.test"],
  allowInsecure: false,
};
const output = { mediaRef: "https://media.test/output", mimeType: "video/mp4" };

describe("Runtime output redirect boundaries", () => {
  it.each([
    ["https://outside.test/output", "not allowlisted"],
    ["http://media.test/output", "must be HTTPS"],
    ["file:///output", "must be HTTPS"],
  ])("rejects a redirect to %s before fetching the target", async (location, error) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(downloadMedia(output, { ...options, fetchImpl })).rejects.toThrow(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows relative redirects and retains private headers only on the same origin", async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/final" } }))
      .mockResolvedValueOnce(new Response("media", { headers: { "content-type": "video/mp4" } }));
    const contentHeaders = { authorization: "Bearer private-serving-token" };
    const result = await downloadMedia({ ...output, contentHeaders }, { ...options, fetchImpl });
    expect(result.bytes).toEqual(Buffer.from("media"));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://media.test/output",
      "https://media.test/final",
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual(contentHeaders);
  });

  it("does not forward any private content header across origins or restore it after returning", async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://cdn.media.test/output" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://media.test/final" } }),
      )
      .mockResolvedValueOnce(new Response("media", { headers: { "content-type": "video/mp4" } }));
    await downloadMedia(
      {
        ...output,
        contentHeaders: { authorization: "Bearer serving-token", "x-private-key": "key" },
      },
      { ...options, fetchImpl },
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer serving-token",
    });
    expect(fetchImpl.mock.calls.slice(1).every(([, init]) => init?.headers === undefined)).toBe(
      true,
    );
  });

  it("bounds redirect loops without starting the final transfer", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 302, headers: { location: "/output" } }),
    );
    await expect(downloadMedia(output, { ...options, fetchImpl })).rejects.toThrow(/redirect/iu);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("cancels an unread redirect body before fetching its validated target", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: "/final" },
        }),
      )
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledTimes(1);
        return new Response("media", { headers: { "content-type": "video/mp4" } });
      });
    await downloadMedia(output, { ...options, fetchImpl });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("blocks a real HTTP redirect from an allowed host to an unallowlisted host", async () => {
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/output") {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("missing address");
        }
        res.writeHead(302, { location: `http://localhost:${address.port}/forbidden` });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end("unexpected transfer");
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing address");
    }
    try {
      await expect(
        downloadMedia(
          { ...output, mediaRef: `http://127.0.0.1:${address.port}/output` },
          {
            ...options,
            allowedHosts: ["127.0.0.1"],
            allowInsecure: true,
            fetchImpl: globalThis.fetch,
          },
        ),
      ).rejects.toThrow("not allowlisted");
      expect(requests).toEqual(["/output"]);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
