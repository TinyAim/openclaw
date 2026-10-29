import { describe, expect, it } from "vitest";
import { klingFixture } from "./kling-apikey-i2v-test-fixture.js";
import { createKlingApiKeyI2VVendor } from "./kling-apikey-i2v-vendor.js";

describe("Kling 2.6 submission and query identity", () => {
  it.each([
    () => Promise.reject(new Error("timeout")),
    () => Promise.resolve(new Response("broken", { status: 502 })),
    () => Promise.resolve(Response.json({ code: 1, message: "failure" }, { status: 503 })),
    () => Promise.resolve(Response.json({ code: 0, data: {} })),
    () => Promise.resolve(Response.json({ unexpected: true })),
  ])("preserves an ambiguous submission instead of creating a replacement", async (fetchImpl) => {
    const { input, prepared } = klingFixture();
    const vendor = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl,
      prepareSubmission: async () => ({
        kind: "created" as const,
        prepared,
        bindRequest: () => {},
        bindVendorJob: () => {},
      }),
    });
    expect(await vendor.submit(input)).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("never substitutes another task when the queried identity is missing", async () => {
    const vendor = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl: async () =>
        Response.json({ code: 0, data: { tasks: [{ id: "other", status: "failed" }] } }),
    });
    expect(await vendor.poll("expected")).toMatchObject({
      state: "processing",
      vendorJobId: "expected",
    });
  });

  it("keeps duplicate task identities pending", async () => {
    const vendor = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl: async () =>
        Response.json({
          code: 0,
          data: {
            tasks: [
              { id: "expected", status: "failed" },
              { id: "expected", status: "succeeded" },
            ],
          },
        }),
    });
    expect(await vendor.poll("expected")).toMatchObject({
      state: "processing",
      vendorJobId: "expected",
    });
  });
  it.each([
    () => Promise.reject(new Error("timeout")),
    () => Promise.resolve(Response.json(null)),
    () => Promise.resolve(Response.json({ code: 5000 }, { status: 503 })),
    () => Promise.resolve(new Response("invalid", { status: 200 })),
  ])("does not turn an uncertain query into a terminal job failure", async (fetchImpl) => {
    const vendor = createKlingApiKeyI2VVendor({ apiKey: "test", fetchImpl });
    expect(await vendor.poll("original")).toMatchObject({
      state: "processing",
      vendorJobId: "original",
    });
  });
  it("treats malformed succeeded output as a recoverable download failure", async () => {
    const vendor = createKlingApiKeyI2VVendor({
      apiKey: "test",
      fetchImpl: async () =>
        Response.json({ code: 0, data: [{ id: "original", status: "succeeded", outputs: {} }] }),
    });
    expect(await vendor.poll("original")).toMatchObject({
      state: "failed",
      reason: "download_failed",
      retryDisposition: "reconcile_only",
    });
  });
});
