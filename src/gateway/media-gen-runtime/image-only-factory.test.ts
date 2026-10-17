import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";
import { protectedImageEnv } from "./protected-image.test-helpers.js";

vi.mock("../../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../media-generation/registry.js", async () => {
  const { protectedImageModelAuth } = await import("./protected-image.test-helpers.js");
  const { buildOpenAIImageGenerationProvider } =
    await import("../../../extensions/openai/image-generation-provider.js");
  return {
    getImageGenerationProvider: (provider: string) =>
      provider === "openai"
        ? buildOpenAIImageGenerationProvider(protectedImageModelAuth)
        : undefined,
  };
});

describe("image-only factory", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wisclaw-image-only-factory-"));
    for (const key of ["OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"])
      vi.stubEnv(key, undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("constructs and registers per-workspace image facts without video vendor or webhook credentials", async () => {
    const registrations: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: protectedImageEnv(stateDir),
      fetchImpl,
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error(result.reason);
    expect(result.imageExecutor).toBeDefined();
    expect(result).toMatchObject({
      supportedPresetIds: ["image-route-1"],
      enforcesModeration: false,
      appliesLabeling: false,
      capabilityRouteClaims: [],
      modelServingClaims: [],
    });
    const stop = result.startHeartbeat();
    try {
      await vi.waitFor(() => expect(registrations).toHaveLength(2));
      const own = registrations.find((row) => row.workspaceId === "workspace-1")!;
      const other = registrations.find((row) => row.workspaceId === "workspace-2")!;
      expect(own.imageCapabilityBindings).toHaveLength(1);
      expect(own.imageExecutionEvidence).toEqual([
        expect.objectContaining({
          readinessReceipt: expect.objectContaining({
            ready: false,
            activeExecutionAllowed: false,
            transport: false,
            artifactIngest: false,
            cancellation: false,
          }),
        }),
      ]);
      expect(other.imageCapabilityBindings).toEqual([]);
      expect(other.imageExecutionEvidence).toEqual([]);
      expect(JSON.stringify(registrations)).not.toMatch(
        /synthetic-domain-d-image-key|apiKey|tenant-1|user-1/,
      );
    } finally {
      stop();
    }
  });

  it("retains the image reader after slot withdrawal and closes malformed image routes", () => {
    const env = protectedImageEnv(stateDir);
    delete env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON;
    expect(createOpenClawMediaGenRuntimeFromEnv({ env })).toMatchObject({
      enabled: true,
      imageExecutor: expect.any(Object),
    });
    expect(
      createOpenClawMediaGenRuntimeFromEnv({
        env: { ...env, OPENCLAW_MEDIA_GEN_IMAGE_ROUTE_JSON: "{}" },
      }),
    ).toMatchObject({ enabled: false });
  });
});
