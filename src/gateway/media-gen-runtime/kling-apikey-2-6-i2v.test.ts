import { describe, expect, it, vi } from "vitest";
import {
  compileKlingApiKeyI2VRequest,
  KLING_APIKEY_2_6_I2V_ROUTE_ID,
} from "./kling-apikey-i2v-compiler.js";
import { klingFixture, klingTwoFrameFixture } from "./kling-apikey-i2v-test-fixture.js";
import { createKlingApiKeyI2VVendor } from "./kling-apikey-i2v-vendor.js";

describe("Kling API Key 2.6 Image-to-Video Compiler & Vendor", () => {
  describe("compileKlingApiKeyI2VRequest", () => {
    it("compiles first_frame_to_video with prompt, prepared first frame, duration 5 and 720p", () => {
      const { input, prepared } = klingFixture();
      const result = compileKlingApiKeyI2VRequest(input, prepared);
      expect(result).toMatchObject({
        ok: true,
        body: {
          contents: [
            { type: "prompt", text: input.prompt },
            { type: "first_frame", url: "https://prepared.example/frame" },
          ],
          settings: { duration: 5, resolution: "720p", audio: "off" },
          options: { external_task_id: "attempt-123" },
        },
      });
      if (result.ok) expect(result.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
    it("compiles both frames and native audio only at the frozen 1080p setting", () => {
      const { input, prepared } = klingTwoFrameFixture();
      expect(compileKlingApiKeyI2VRequest(input, prepared)).toMatchObject({
        ok: true,
        body: {
          contents: [
            { type: "prompt", text: input.prompt },
            { type: "first_frame", url: "https://prepared.example/frame" },
            { type: "last_frame", url: "https://prepared.example/last" },
          ],
          settings: { duration: 10, resolution: "1080p", audio: "native" },
        },
      });
      expect(compileKlingApiKeyI2VRequest({ ...input, resolution: "720p" }, prepared).ok).toBe(
        false,
      );
    });
    it("fails closed when mode is not image2video or required first frame is missing", () => {
      const { input, prepared } = klingFixture();
      expect(compileKlingApiKeyI2VRequest({ ...input, mode: "text2video" }, prepared).ok).toBe(
        false,
      );
      expect(compileKlingApiKeyI2VRequest({ ...input, sources: [] }, prepared).ok).toBe(false);
    });
  });

  describe("createKlingApiKeyI2VVendor", () => {
    it("submits task with Bearer authorization and extracts task_id string", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          message: "SUCCEED",
          data: {
            id: "CgABCd09012847291029",
          },
        }),
      });

      const vendor = createKlingApiKeyI2VVendor({
        apiKey: "test-kling-api-key",
        prepareSubmission: async () => ({
          kind: "created" as const,
          prepared: klingFixture().prepared,
          bindRequest: () => {},
          bindVendorJob: () => {},
        }),
        fetchImpl: mockFetch as any,
      });

      expect(vendor.capabilityRouteClaims[0]?.route.routeId).toBe(KLING_APIKEY_2_6_I2V_ROUTE_ID);

      const { input } = klingFixture();
      const submitResult = await vendor.submit(input);

      expect(submitResult.state).toBe("processing");
      expect(submitResult.vendorJobId).toBe("CgABCd09012847291029");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api-singapore.klingai.com/image-to-video/kling-2.6",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer test-kling-api-key",
            "content-type": "application/json",
          }),
        }),
      );
    });

    it("polls task status and parses completed video url", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          message: "SUCCEED",
          data: {
            tasks: [
              {
                id: "CgABCd09012847291029",
                status: "succeeded",
                outputs: [
                  {
                    type: "video",
                    url: "https://kling-cdn.com/output.mp4",
                  },
                ],
              },
            ],
          },
        }),
      });

      const vendor = createKlingApiKeyI2VVendor({
        apiKey: "test-kling-api-key",
        fetchImpl: mockFetch as any,
      });

      const pollResult = await vendor.poll("CgABCd09012847291029");

      expect(pollResult.state).toBe("succeeded");
      if (pollResult.state === "succeeded") {
        expect(pollResult.output.mediaRef).toBe("https://kling-cdn.com/output.mp4");
      }
    });

    it("does not define remote cancel", () => {
      const vendor = createKlingApiKeyI2VVendor({
        apiKey: "test-kling-api-key",
      });

      expect(vendor.cancel).toBeUndefined();
    });

    it("maps business error codes correctly on submit failure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          code: 1001,
          message: "Unauthorized",
        }),
      });

      const vendor = createKlingApiKeyI2VVendor({
        apiKey: "invalid-key",
        prepareSubmission: async () => ({
          kind: "created" as const,
          prepared: klingFixture().prepared,
          bindRequest: () => {},
          bindVendorJob: () => {},
        }),
        fetchImpl: mockFetch as any,
      });

      const { input } = klingFixture();
      const failResult = await vendor.submit(input);

      expect(failResult.state).toBe("failed");
      if (failResult.state === "failed") {
        expect((failResult as any).reason).toBe("auth");
      }
    });
  });
});
