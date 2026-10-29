import { describe, expect, it, vi } from "vitest";
import { compileKlingApiKeyI2VRequest } from "./kling-apikey-i2v-compiler.js";
import { klingFixture } from "./kling-apikey-i2v-test-fixture.js";
import { createKlingApiKeyI2VVendor } from "./kling-apikey-i2v-vendor.js";
import { inspectKlingSourceFrames } from "./kling-source-inspection.js";

describe("Kling frozen input compiler", () => {
  it("maps a prepared source and retained attempt correlation", () => {
    const { input, prepared } = klingFixture();
    expect(compileKlingApiKeyI2VRequest(input, prepared)).toMatchObject({
      ok: true,
      body: {
        contents: [
          { type: "prompt", text: "A small boat at dawn" },
          { type: "first_frame", url: "https://prepared.example/frame" },
        ],
        settings: { duration: 5, resolution: "720p", audio: "off" },
        options: { external_task_id: "attempt-123" },
      },
    });
  });
  it("rejects missing preparation, a different profile, and altered source bytes", () => {
    const { input, prepared } = klingFixture();
    expect(compileKlingApiKeyI2VRequest(input).ok).toBe(false);
    const wrong = structuredClone(input);
    wrong.frozenPlan!.capabilityProfileRef.digest = `sha256:${"0".repeat(64)}`;
    expect(compileKlingApiKeyI2VRequest(wrong, prepared).ok).toBe(false);
    const slot = input.sources![0]!;
    expect(
      compileKlingApiKeyI2VRequest(
        {
          ...input,
          sources: [
            {
              ...slot,
              source: {
                bytes: Buffer.from("tampered"),
                mimeType: "image/png",
                sha256: slot.source.sha256,
              },
            },
          ],
        },
        prepared,
      ).ok,
    ).toBe(false);
  });
  it("uses the trusted preparation result before submitting and never posts without it", async () => {
    const { input, prepared } = klingFixture();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: { id: "provider-task" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const missing = createKlingApiKeyI2VVendor({ apiKey: "test", fetchImpl });
    expect(missing.isConfigured()).toBe(false);
    expect(missing.capabilityRouteClaims).toEqual([]);
    expect(await missing.submit(input)).toMatchObject({ state: "failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const bindRequest = vi.fn();
    const bindVendorJob = vi.fn();
    const prepareSubmission = vi.fn(async () => ({
      kind: "created" as const,
      prepared,
      bindRequest,
      bindVendorJob,
    }));
    const ready = createKlingApiKeyI2VVendor({ apiKey: "test", fetchImpl, prepareSubmission });
    const invalid = structuredClone(input);
    invalid.frozenPlan!.capabilityProfileRef.digest = `sha256:${"0".repeat(64)}`;
    expect(await ready.submit(invalid)).toMatchObject({ state: "failed" });
    expect(prepareSubmission).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await ready.submit(input)).toMatchObject({
      state: "processing",
      vendorJobId: "provider-task",
    });
    expect(prepareSubmission).toHaveBeenCalledWith(input);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bindRequest).toHaveBeenCalledWith(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
    expect(bindVendorJob).toHaveBeenCalledWith("provider-task");
    expect(bindRequest.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[0]!,
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.options.external_task_id).toBe("attempt-123");
  });
  it("inspects real source image content and rejects forged preparation dimensions", async () => {
    const { input, prepared } = klingFixture();
    expect(await inspectKlingSourceFrames(input)).toMatchObject({ ok: true });
    const slot = input.sources![0]!;
    expect(
      await inspectKlingSourceFrames({
        ...input,
        sources: [
          { ...slot, source: { bytes: Buffer.from("not an image"), mimeType: "image/jpeg" } },
        ],
      }),
    ).toEqual({ ok: false });
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    const vendor = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl,
      prepareSubmission: async () => ({
        kind: "created",
        prepared: {
          ...prepared,
          frames: prepared.frames.map((frame) => ({ ...frame, width: frame.width + 1 })),
        },
        bindRequest: () => {},
        bindVendorJob: () => {},
      }),
    });
    expect(await vendor.submit(input)).toMatchObject({ state: "failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("never posts an existing attempt or one whose request binding fails", async () => {
    const { input, prepared } = klingFixture();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    const existing = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl,
      prepareSubmission: async () => ({ kind: "existing" }),
    });
    await expect(existing.submit(input)).rejects.toThrow(
      "Kling preparation outcome requires owner reconciliation",
    );
    const digest = `sha256:${"a".repeat(64)}`;
    const existingBound = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl,
      prepareSubmission: async () => ({ kind: "existing", providerRequestDigest: digest }),
    });
    expect(await existingBound.submit(input)).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: digest,
    });
    const noBind = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl,
      prepareSubmission: async () => ({
        kind: "created",
        prepared,
        bindRequest: () => {
          throw new Error("lost owner");
        },
        bindVendorJob: () => {},
      }),
    });
    expect(await noBind.submit(input)).toMatchObject({ state: "submission_unknown" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retains an unknown outcome if a successful provider receipt cannot be durably bound", async () => {
    const { input, prepared } = klingFixture();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ code: 0, data: { id: "provider-task" } }),
    );
    const vendor = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl,
      prepareSubmission: async () => ({
        kind: "created",
        prepared,
        bindRequest: () => {},
        bindVendorJob: () => {
          throw new Error("write failed");
        },
      }),
    });
    expect(await vendor.submit(input)).toMatchObject({ state: "submission_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
