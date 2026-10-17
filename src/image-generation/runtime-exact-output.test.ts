import { describe, expect, it, vi } from "vitest";
import { ImageGenerationExactOutputError } from "./normalization.js";
import type { GenerateImageParams } from "./runtime-types.js";
import { generateImage } from "./runtime.js";
import type { ImageGenerationProvider } from "./types.js";

function harness() {
  const create = vi.fn(async () => ({
    images: [{ buffer: Buffer.from("controlled-image"), mimeType: "image/png" }],
  }));
  const provider: ImageGenerationProvider = {
    id: "image-owner",
    capabilities: {
      generate: { supportsSize: true },
      edit: { enabled: false },
      geometry: { sizes: ["1536x1024", "1024x1024"] },
      output: { qualities: ["high"], formats: ["png"], backgrounds: ["opaque"] },
    },
    generateImage: create,
  };
  const run = (patch: Partial<GenerateImageParams> = {}) =>
    generateImage(
      {
        cfg: {},
        prompt: "A scene reference",
        modelOverride: "image-owner/model-1",
        requireExactOutput: true,
        autoProviderFallback: false,
        size: "1536x1024",
        quality: "high",
        outputFormat: "png",
        background: "opaque",
        count: 1,
        ...patch,
      },
      {
        getProvider: (id) => (id === provider.id ? provider : undefined),
        listProviders: () => [provider],
        log: { warn: () => undefined },
      },
    );
  return { run, create };
}

describe("frozen image output before Provider effects", () => {
  it("rejects nearest-size substitution before any paid request", async () => {
    const h = harness();
    await expect(h.run({ size: "1024x576" })).rejects.toBeInstanceOf(
      ImageGenerationExactOutputError,
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each([
    { quality: "low" as const },
    { outputFormat: "jpeg" as const },
    { background: "transparent" as const },
  ])("rejects ignored output options before any paid request: %j", async (patch) => {
    const h = harness();
    await expect(h.run(patch)).rejects.toBeInstanceOf(ImageGenerationExactOutputError);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("sends one exact supported request", async () => {
    const h = harness();
    await expect(h.run()).resolves.toMatchObject({ provider: "image-owner", model: "model-1" });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "image-owner",
        model: "model-1",
        count: 1,
        size: "1536x1024",
        quality: "high",
        outputFormat: "png",
        background: "opaque",
      }),
    );
  });

  it.each([undefined, "foreign-owner/model-1"])(
    "does not replace an absent frozen route: %s",
    async (modelOverride) => {
      const h = harness();
      await expect(h.run({ modelOverride })).rejects.toBeInstanceOf(
        ImageGenerationExactOutputError,
      );
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it("preserves the existing conversational normalization policy", async () => {
    const h = harness();
    const output = await h.run({ requireExactOutput: false, size: "1024x576" });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(output.normalization?.size).toMatchObject({ requested: "1024x576" });
  });
});
