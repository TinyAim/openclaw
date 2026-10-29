import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileSeedanceV2Request,
  SEEDANCE_V2_LEGACY_TEXT_PROFILE,
  SEEDANCE_V2_PROFILE_DIGESTS,
} from "./seedance-v2-compiler.js";
import { createSeedanceV2RuntimeVendor } from "./seedance-vendor-v2.js";
import type { MediaGenRuntimeVendorInput } from "./types.js";

const job = "seedance-v2:text2video:ark-job-1";

function input(): MediaGenRuntimeVendorInput {
  const prompt = "a quiet sunrise";
  const frozenPlan = {
    schemaVersion: 2,
    presetId: "seedance",
    mode: "text2video",
    adapterRevision: "openclaw-seedance-runtime/v2",
    providerRouteRef: {
      providerId: "volcengine_ark",
      modelId: "doubao-seedance-2-0-260128",
      endpointId: "ark.v3.contents.generations.tasks",
      region: "cn-beijing",
      accountTier: "online",
      routeId: "volcengine.ark.seedance2.text2video",
    },
    capabilityProfileRef: {
      profileId: "seedance.openclaw-runtime.text2video.v4",
      revision: 4,
      digest: SEEDANCE_V2_PROFILE_DIGESTS.text2video,
    },
    generationIntent: {
      legacyMode: "text2video",
      compiledPrompt: prompt,
      outputAudioPolicy: "silent",
      references: [],
      output: {
        shotCount: 1,
        durationSec: 6,
        aspectRatio: "16:9",
        resolution: "1080p",
      },
    },
  } as unknown as MediaGenRuntimeFrozenPlanV2;
  return {
    taskId: "task-1",
    presetId: "seedance",
    mode: "text2video",
    prompt,
    durationSec: 6,
    resolution: "1080p",
    params: { ratio: "16:9" },
    sources: [],
    frozenPlan,
  };
}

describe("Seedance V2 transient and cancel honesty", () => {
  it("keeps historical V3 frozen text receipts executable without advertising them", () => {
    const historical = input();
    historical.frozenPlan!.capabilityProfileRef = {
      ...SEEDANCE_V2_LEGACY_TEXT_PROFILE,
    };
    expect(compileSeedanceV2Request(input())).toMatchObject({ ok: true });
    expect(compileSeedanceV2Request(historical)).toMatchObject({ ok: true });
  });

  it.each([408, 500, 502, 503, 504])(
    "maps create HTTP %s to submission_unknown without a provider job id",
    async (status) => {
      const vendor = createSeedanceV2RuntimeVendor({
        apiKey: "key",
        fetchImpl: vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch,
      });
      const result = await vendor.submit(input());
      expect(result).toMatchObject({
        state: "submission_unknown",
        providerRequestDigest: expect.stringMatching(/^sha256:/u),
        providerObservation: {
          operation: "submit",
          outcome: "submission_unknown",
        },
      });
      expect("vendorJobId" in result).toBe(false);
    },
  );

  it.each([204, 408, 429, 500, 502, 503, 504])(
    "keeps a known job processing when poll HTTP %s is not terminal proof",
    async (status) => {
      const vendor = createSeedanceV2RuntimeVendor({
        apiKey: "key",
        fetchImpl: vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch,
      });
      await expect(vendor.poll(job)).resolves.toMatchObject({
        state: "processing",
        vendorJobId: job,
        providerObservation: { operation: "poll", outcome: "processing" },
      });
    },
  );

  it("classifies explicit and uncertain cancel outcomes without raw errors", async () => {
    const cases = [
      [204, "confirmed", "canceled"],
      [401, "failed", "processing"],
      [403, "failed", "processing"],
      [408, "unknown", "processing"],
      [429, "failed", "processing"],
      [500, "unknown", "processing"],
    ] as const;
    for (const [status, state, outcome] of cases) {
      const vendor = createSeedanceV2RuntimeVendor({
        apiKey: "key",
        fetchImpl: vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch,
      });
      await expect(vendor.cancel!(job)).resolves.toMatchObject({
        state,
        providerObservation: { operation: "cancel", outcome },
      });
    }

    const networkVendor = createSeedanceV2RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private connection reset");
      }) as unknown as typeof fetch,
    });
    const result = await networkVendor.cancel!(job);
    expect(result).toMatchObject({
      state: "unknown",
      providerObservation: { operation: "cancel", outcome: "processing" },
    });
    expect(JSON.stringify(result)).not.toContain("connection reset");
  });

  it("retries the exact DELETE receipt without creating replacement work", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const vendor = createSeedanceV2RuntimeVendor({
      apiKey: "key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(vendor.cancel!(job)).resolves.toMatchObject({ state: "unknown" });
    await expect(vendor.cancel!(job)).resolves.toMatchObject({ state: "confirmed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0]!;
    const [secondUrl, secondInit] = fetchImpl.mock.calls[1]!;
    expect(firstUrl).toBe(secondUrl);
    expect(firstInit).toMatchObject({ method: "DELETE" });
    expect(secondInit).toMatchObject({ method: "DELETE" });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
