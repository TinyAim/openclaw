import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileRunwayGen4TurboRequest,
  RUNWAY_GEN4_TURBO_ADAPTER_REVISION,
  RUNWAY_GEN4_TURBO_LEGACY_PROFILE_DIGEST,
  RUNWAY_GEN4_TURBO_LEGACY_PROFILE_ID,
  RUNWAY_GEN4_TURBO_LEGACY_PROFILE_REVISION,
  RUNWAY_GEN4_TURBO_PROFILE_DIGEST,
  RUNWAY_GEN4_TURBO_PROFILE_ID,
  RUNWAY_GEN4_TURBO_PROFILE_REVISION,
  RUNWAY_GEN4_TURBO_ROUTE_ID,
} from "./runway-gen4-turbo-compiler.js";
import { createRunwayRuntimeVendor, RUNWAY_API_VERSION } from "./runway-vendor.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

const FRAME_BYTES = Buffer.from("runway-first-frame");

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function frozenPlan(
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    mimeType?: string;
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A train crosses a snow-covered viaduct.";
  return {
    schemaVersion: 2,
    previewId: "preview-runway",
    presetId: "runway",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-runway",
        shotId: "shot-runway",
        shotVersion: "R1",
        promptPackId: "pack-runway",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${sha(FRAME_BYTES)}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "artifact", artifactId: "artifact-runway-frame" },
          assetRefId: "asset-runway-frame",
          authorityRef: "artifact:runway-frame",
          authorityVerified: true,
          mimeType: overrides.mimeType ?? "image/webp",
          sourceDigest: `sha256:${sha(FRAME_BYTES)}`,
        },
      ],
      output: {
        durationSec: overrides.durationSec ?? 6,
        aspectRatio: overrides.aspectRatio ?? "21:9",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: RUNWAY_GEN4_TURBO_ROUTE_ID,
      providerId: "runway_api",
      modelId: "gen4_turbo",
      endpointId: "runway.v1.image_to_video",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: RUNWAY_GEN4_TURBO_PROFILE_ID,
      revision: RUNWAY_GEN4_TURBO_PROFILE_REVISION,
      digest: RUNWAY_GEN4_TURBO_PROFILE_DIGEST,
    },
    adapterRevision: RUNWAY_GEN4_TURBO_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-runway",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerField: "scenario",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerField: "output.audio",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: true,
        support: "prompt",
        providerField: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      {
        intentPath: "references.first_frame.0",
        sourceRef: "asset:asset-runway-frame",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerSlot: "references.first_frame",
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      },
      {
        intentPath: "output.durationSec",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native",
        providerField: "output.durationSec",
        reasonCode: "duration_native",
        messageKey: "media.duration_native",
      },
      {
        intentPath: "output.aspectRatio",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native",
        providerField: "output.aspectRatio",
        reasonCode: "output_value_native",
        messageKey: "media.output_value_native",
      },
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlot(mimeType = "image/webp"): MediaGenRuntimeSourceSlot {
  return {
    role: "first_frame",
    ordinal: 0,
    source: {
      bytes: FRAME_BYTES,
      mimeType,
      sha256: sha(FRAME_BYTES),
    },
  };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-runway",
    presetId: "runway",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    sources: [sourceSlot(plan.generationIntent.references[0]?.mimeType)],
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Runway exact Gen-4 Turbo Image-to-Video runtime", () => {
  it("compiles the official v5.13.0 fields and maps the neutral ratio exactly", async () => {
    const compiled = compileRunwayGen4TurboRequest(vendorInput());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(Object.keys(compiled.body)).toEqual([
      "model",
      "promptImage",
      "promptText",
      "ratio",
      "duration",
    ]);
    expect(compiled.body).toEqual({
      model: "gen4_turbo",
      promptImage: `data:image/webp;base64,${FRAME_BYTES.toString("base64")}`,
      promptText: "A train crosses a snow-covered viaduct.",
      ratio: "1584:672",
      duration: 6,
    });
    expect(compiled.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createRunwayRuntimeVendor({
      apiKey: "runway-secret",
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(JSON.stringify({ id: "runway-job-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await vendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: "runway-job-1",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    expect(calls[0]?.url).toBe("https://api.dev.runwayml.com/v1/image_to_video");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer runway-secret",
      "X-Runway-Version": RUNWAY_API_VERSION,
    });
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody === "string") {
      expect(JSON.parse(requestBody)).toEqual(compiled.body);
    }
  });

  it.each([
    ["16:9", "1280:720"],
    ["9:16", "720:1280"],
    ["4:3", "1104:832"],
    ["3:4", "832:1104"],
    ["1:1", "960:960"],
    ["21:9", "1584:672"],
  ])("maps the neutral %s ratio to %s", (aspectRatio, providerRatio) => {
    expect(compileRunwayGen4TurboRequest(vendorInput(frozenPlan({ aspectRatio })))).toMatchObject({
      ok: true,
      body: { ratio: providerRatio },
    });
  });

  it.each([2, 10])("accepts the frozen duration boundary %s", (durationSec) => {
    expect(compileRunwayGen4TurboRequest(vendorInput(frozenPlan({ durationSec })))).toMatchObject({
      ok: true,
      body: { duration: durationSec },
    });
  });

  it.each([1, 2.5, 11])("rejects the unfrozen duration %s", (durationSec) => {
    expect(compileRunwayGen4TurboRequest(vendorInput(frozenPlan({ durationSec })))).toMatchObject({
      ok: false,
    });
  });

  it("rejects stale profiles, raw params, unsupported MIME, and output drift", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileRunwayGen4TurboRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileRunwayGen4TurboRequest(vendorInput(frozenPlan(), { params: { seed: 7 } })),
    ).toMatchObject({ ok: false });
    expect(compileRunwayGen4TurboRequest(vendorInput(frozenPlan(), { params: {} }))).toMatchObject({
      ok: false,
    });
    expect(
      compileRunwayGen4TurboRequest(
        vendorInput(frozenPlan({ mimeType: "image/gif" }), { sources: [sourceSlot("image/gif")] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileRunwayGen4TurboRequest(
        vendorInput(frozenPlan({ durationSec: 11, aspectRatio: "2:1" })),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileRunwayGen4TurboRequest(vendorInput(frozenPlan({ prompt: "x".repeat(1_001) }))),
    ).toMatchObject({ ok: false });
    expect(compileRunwayGen4TurboRequest(vendorInput(frozenPlan({ prompt: "   " })))).toMatchObject(
      { ok: false },
    );

    const oversizedBytes = Buffer.alloc(4 * 1024 * 1024, 1);
    const oversizedPlan = frozenPlan();
    const oversizedReference = oversizedPlan.generationIntent.references[0];
    if (!oversizedReference) {
      throw new Error("missing Runway test reference");
    }
    oversizedReference.sourceDigest = `sha256:${sha(oversizedBytes)}`;
    expect(
      compileRunwayGen4TurboRequest(
        vendorInput(oversizedPlan, {
          sources: [
            {
              role: "first_frame",
              ordinal: 0,
              source: {
                bytes: oversizedBytes,
                mimeType: "image/webp",
                sha256: sha(oversizedBytes),
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("accepts the official image/jpg data URI and omits an empty optional prompt", () => {
    const jpgPlan = frozenPlan({ mimeType: "image/jpg" });
    expect(
      compileRunwayGen4TurboRequest(vendorInput(jpgPlan, { sources: [sourceSlot("image/jpg")] })),
    ).toMatchObject({
      ok: true,
      body: { promptImage: expect.stringMatching(/^data:image\/jpg;base64,/u) },
    });
    const emptyPrompt = compileRunwayGen4TurboRequest(vendorInput(frozenPlan({ prompt: "" })));
    expect(emptyPrompt).toMatchObject({ ok: true });
    if (emptyPrompt.ok) {
      expect(emptyPrompt.body).not.toHaveProperty("promptText");
    }
  });

  it("accepts only the exact historical V1 frozen profile tuple", () => {
    const legacy = frozenPlan();
    legacy.capabilityProfileRef = {
      profileId: RUNWAY_GEN4_TURBO_LEGACY_PROFILE_ID,
      revision: RUNWAY_GEN4_TURBO_LEGACY_PROFILE_REVISION,
      digest: RUNWAY_GEN4_TURBO_LEGACY_PROFILE_DIGEST,
    };
    expect(compileRunwayGen4TurboRequest(vendorInput(legacy))).toMatchObject({
      ok: true,
      body: { model: "gen4_turbo" },
    });
    legacy.capabilityProfileRef.revision += 1;
    expect(compileRunwayGen4TurboRequest(vendorInput(legacy))).toMatchObject({
      ok: false,
    });
  });

  it("marks an ambiguous create without exposing transport details", async () => {
    const vendor = createRunwayRuntimeVendor({
      apiKey: "secret",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    });
    const result = await vendor.submit(vendorInput());
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: RUNWAY_GEN4_TURBO_ROUTE_ID,
        adapterRevision: RUNWAY_GEN4_TURBO_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
        qualityOutcome: "not_run",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("normalizes task states, output, failure, and cancellation", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (value.endsWith("/pending")) {
        return new Response(JSON.stringify({ status: "THROTTLED" }), { status: 200 });
      }
      if (value.endsWith("/canceled")) {
        return new Response(JSON.stringify({ status: "CANCELLED" }), { status: 200 });
      }
      if (value.endsWith("/failed")) {
        return new Response(
          JSON.stringify({
            status: "FAILED",
            failureCode: "CONTENT_POLICY_VIOLATION",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          status: "SUCCEEDED",
          output: ["https://media.example/runway.mp4"],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const vendor = createRunwayRuntimeVendor({ apiKey: "secret", fetchImpl });

    expect(await vendor.poll("pending")).toMatchObject({
      state: "processing",
      providerObservation: { operation: "poll", outcome: "processing" },
    });
    expect(await vendor.poll("canceled")).toMatchObject({ state: "canceled" });
    expect(await vendor.reconcile!("failed")).toMatchObject({
      state: "failed",
      reason: "content_blocked",
      providerObservation: { operation: "reconcile", outcome: "failed" },
    });
    expect(await vendor.poll("succeeded")).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.example/runway.mp4" },
    });
    await expect(vendor.cancel!("cancel-me")).resolves.toBeUndefined();
    expect(calls.at(-1)).toEqual({
      url: "https://api.dev.runwayml.com/v1/tasks/cancel-me",
      method: "DELETE",
    });
  });

  it("downloads the expiring output before quality proof and Artifact handoff", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/v1/image_to_video") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "runway-job-artifact" }), { status: 200 });
      }
      if (value.endsWith("/v1/tasks/runway-job-artifact")) {
        return new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            output: ["https://media.example/runway.mp4"],
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from("runway-video-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-runway-output",
      mimeType: "video/mp4",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-runway",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => ({
        bytes: FRAME_BYTES,
        mimeType: "image/webp",
        sha256: sha(FRAME_BYTES),
      })),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createRunwayRuntimeVendor({ apiKey: "secret", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-runway",
      workspaceId: "ws-runway",
      correlationId: "corr-runway-submit",
      presetId: "runway",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 6,
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-runway-frame",
          role: "first_frame",
          ordinal: 0,
        },
      ],
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "runway-job-artifact",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-runway-poll",
      presetId: "runway",
      mode: "image2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-runway-output" },
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
