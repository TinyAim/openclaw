import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeSourceSlot, MediaGenRuntimeVendorInput } from "./types.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";

function subjectSlot(byte: number, ordinal: number): MediaGenRuntimeSourceSlot {
  return {
    role: "subject",
    ordinal,
    source: { bytes: Buffer.from([byte]), mimeType: "image/png" },
  };
}

function input(overrides: Partial<MediaGenRuntimeVendorInput> = {}): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-1",
    presetId: "vidu",
    mode: "text2video",
    prompt: "keep the subject consistent",
    ...overrides,
  };
}

describe("Vidu runtime vendor", () => {
  it("keeps local multi-reference support without advertising an unpinned image route", () => {
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key" });
    expect(vendor.supportsMultiReference).toBe(true);
    expect(vendor.presetId).toBe("vidu");
    expect(vendor.isConfigured()).toBe(true);
    expect(vendor.capabilityRouteClaims).toEqual([
      expect.objectContaining({
        presetId: "vidu",
        mode: "text2video",
        adapterRevision: "openclaw-vidu-q1-text2video-runtime/v2",
      }),
    ]);
  });

  it("rejects unfrozen multi-reference instead of sending it to a legacy endpoint", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });

    const job = await vendor.submit(
      input({ sources: [subjectSlot(1, 0), subjectSlot(2, 1), subjectSlot(3, 2)] }),
    );

    expect(job).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-subject role rather than mis-placing it as a subject image", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });

    const job = await vendor.submit(
      input({
        sources: [
          subjectSlot(1, 0),
          { role: "style", ordinal: 1, source: { bytes: Buffer.from([9]), mimeType: "image/png" } },
        ],
      }),
    );

    expect(job).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects more than 7 subject images fail-closed", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });
    const sources = Array.from({ length: 8 }, (_, i) => subjectSlot(i + 1, i));

    const job = await vendor.submit(input({ sources }));

    expect(job).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a single legacy source onto images[1]", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ task_id: "vidu-task-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });

    await vendor.submit(
      input({ mode: "image2video", source: { bytes: Buffer.from([7]), mimeType: "image/jpeg" } }),
    );

    const [calledUrl, init] = (
      fetchImpl as unknown as {
        mock: { calls: [string, RequestInit][] };
      }
    ).mock.calls[0];
    expect(calledUrl).toBe("https://api.vidu.com/ent/v2/img2video");
    const body = JSON.parse(typeof init.body === "string" ? init.body : "") as {
      images?: string[];
    };
    expect(body.images).toHaveLength(1);
  });

  it("blocks image2video without any source bytes", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });

    const job = await vendor.submit(input({ mode: "image2video" }));

    expect(job).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies auth failures from the create call", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });

    const job = await vendor.submit(input());

    expect(job).toMatchObject({ state: "failed", reason: "auth" });
  });

  it("reports a succeeded poll with the creation url", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ state: "success", creations: [{ url: "https://cdn.vidu/out.mp4" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });

    const job = await vendor.poll("vidu-task-1");

    expect(job).toMatchObject({
      state: "succeeded",
      vendorJobId: "vidu-task-1",
      output: { mediaRef: "https://cdn.vidu/out.mp4", mimeType: "video/mp4" },
    });
    const [calledUrl] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(calledUrl).toBe("https://api.vidu.com/ent/v2/tasks/vidu-task-1/creations");
  });
});
