import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  compileKlingApiKeyI2VRequest,
  KLING_APIKEY_2_6_I2V_ROUTE_ID,
  KLING_APIKEY_2_6_I2V_ADAPTER_REVISION,
} from "./kling-apikey-i2v-compiler.js";
import { createKlingApiKeyI2VVendor } from "./kling-apikey-i2v-vendor.js";
import type { MediaGenRuntimeVendorInput } from "./types.js";

function sha(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeVendorInput(
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-kling-26-001",
    presetId: "kling",
    mode: "image2video",
    prompt: "A sleek spaceship landing on neon cyber pad",
    durationSec: 5,
    resolution: "720p",
    sources: [
      {
        slotKey: "first_frame:0",
        role: "first_frame",
        ordinal: 0,
        assetRefId: "asset-ff-1",
        artifactId: "art-ff-1",
        mimeType: "image/png",
        sourceDigest: `sha256:${sha("first-frame-bytes")}`,
        required: true,
        sourceUrl: "https://storage.wisclaw.ai/assets/first-frame.png",
      },
    ],
    ...overrides,
  };
}

describe("Kling API Key 2.6 Image-to-Video Compiler & Vendor", () => {
  describe("compileKlingApiKeyI2VRequest", () => {
    it("compiles first_frame_to_video with prompt, first_frame url, duration 5 and resolution 720p", () => {
      const input = makeVendorInput();
      const result = compileKlingApiKeyI2VRequest(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.body.contents).toEqual([
        { type: "prompt", text: "A sleek spaceship landing on neon cyber pad" },
        { type: "first_frame", url: "https://storage.wisclaw.ai/assets/first-frame.png" },
      ]);
      expect(result.body.settings).toEqual({
        duration: 5,
        resolution: "720p",
        audio: "off",
      });
      expect(result.body.options?.external_task_id).toBe("task-kling-26-001");
      expect(result.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("enforces 1080p resolution and compiles both frames for first_last_frame_to_video", () => {
      const input = makeVendorInput({
        resolution: "720p", // should be promoted to 1080p for last frame
        durationSec: 10,
        outputAudioPolicy: "native" as any,
        sources: [
          {
            slotKey: "first_frame:0",
            role: "first_frame",
            ordinal: 0,
            assetRefId: "asset-ff-1",
            artifactId: "art-ff-1",
            mimeType: "image/png",
            sourceDigest: `sha256:${sha("first-frame")}`,
            required: true,
            sourceUrl: "https://storage.wisclaw.ai/assets/first-frame.png",
          },
          {
            slotKey: "last_frame:0",
            role: "last_frame",
            ordinal: 0,
            assetRefId: "asset-lf-1",
            artifactId: "art-lf-1",
            mimeType: "image/png",
            sourceDigest: `sha256:${sha("last-frame")}`,
            required: true,
            sourceUrl: "https://storage.wisclaw.ai/assets/last-frame.png",
          },
        ],
      });

      const result = compileKlingApiKeyI2VRequest(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.body.contents).toEqual([
        { type: "prompt", text: "A sleek spaceship landing on neon cyber pad" },
        { type: "first_frame", url: "https://storage.wisclaw.ai/assets/first-frame.png" },
        { type: "last_frame", url: "https://storage.wisclaw.ai/assets/last-frame.png" },
      ]);
      expect(result.body.settings.resolution).toBe("1080p");
      expect(result.body.settings.duration).toBe(10);
      expect(result.body.settings.audio).toBe("native");
    });

    it("fails closed when mode is not image2video or required first frame is missing", () => {
      const nonI2V = makeVendorInput({ mode: "text2video" as any });
      const nonI2VResult = compileKlingApiKeyI2VRequest(nonI2V);
      expect(nonI2VResult.ok).toBe(false);

      const missingFrame = makeVendorInput({ sources: [] });
      const missingFrameResult = compileKlingApiKeyI2VRequest(missingFrame);
      expect(missingFrameResult.ok).toBe(false);
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
        fetchImpl: mockFetch as any,
      });

      expect(vendor.capabilityRouteClaims[0]?.route.routeId).toBe(KLING_APIKEY_2_6_I2V_ROUTE_ID);

      const input = makeVendorInput();
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

      const pollResult = await vendor.poll({
        state: "processing",
        vendorJobId: "CgABCd09012847291029",
      });

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
        fetchImpl: mockFetch as any,
      });

      const input = makeVendorInput();
      const failResult = await vendor.submit(input);

      expect(failResult.state).toBe("failed");
      if (failResult.state === "failed") {
        expect((failResult as any).reason).toBe("auth");
      }
    });
  });
});
