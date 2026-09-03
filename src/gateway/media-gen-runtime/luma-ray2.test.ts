import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileLumaRay2Request,
  LUMA_RAY2_ADAPTER_REVISION,
  LUMA_RAY2_LEGACY_PROFILE_DIGEST,
  LUMA_RAY2_LEGACY_PROFILE_ID,
  LUMA_RAY2_LEGACY_PROFILE_REVISION,
  LUMA_RAY2_PROFILE_DIGEST,
  LUMA_RAY2_PROFILE_ID,
  LUMA_RAY2_PROFILE_REVISION,
  LUMA_RAY2_ROUTE_ID,
} from "./luma-ray2-compiler.js";
import { createLumaRuntimeVendor } from "./luma-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";

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
    resolution?: string;
    profile?: { profileId: string; revision: number; digest: string };
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A lighthouse beam sweeps across a stormy night sea, slow dolly forward.";
  return {
    schemaVersion: 2,
    previewId: "preview-luma",
    presetId: "luma",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-luma",
        shotId: "shot-luma",
        shotVersion: "R1",
        promptPackId: "pack-luma",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Slow dolly forward." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "9:16",
        resolution: overrides.resolution ?? "1080p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: LUMA_RAY2_ROUTE_ID,
      providerId: "luma_dream_machine",
      modelId: "ray-2",
      endpointId: "luma.dream_machine.v1.generations.video",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: overrides.profile?.profileId ?? LUMA_RAY2_PROFILE_ID,
      revision: overrides.profile?.revision ?? LUMA_RAY2_PROFILE_REVISION,
      digest: overrides.profile?.digest ?? LUMA_RAY2_PROFILE_DIGEST,
    },
    adapterRevision: LUMA_RAY2_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-luma",
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
        intentPath: "camera.cameraPrompt",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "prompt",
        providerField: "prompt",
        reasonCode: "camera_prompt_only",
        messageKey: "media.camera_prompt_only",
      },
      ...["output.durationSec", "output.aspectRatio", "output.resolution"].map((intentPath) => ({
        intentPath,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native" as const,
        providerField: intentPath,
        reasonCode: "output_value_native",
        messageKey: "media.output_value_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-luma",
    presetId: "luma",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Luma exact Ray 2 Text-to-Video runtime", () => {
  it("compiles only the official v1.21.0 fields and submits to Dream Machine", async () => {
    const compiled = compileLumaRay2Request(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "ray-2",
        prompt: expect.any(String),
        duration: "5s",
        aspect_ratio: "9:16",
        resolution: "1080p",
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createLumaRuntimeVendor({
      apiKey: "luma-secret",
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(JSON.stringify({ id: "luma-generation-1", state: "queued" }), {
          status: 201,
        });
      }) as unknown as typeof fetch,
    });
    expect(await vendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: "luma-generation-1",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    expect(calls[0]?.url).toBe("https://api.lumalabs.ai/dream-machine/v1/generations/video");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer luma-secret",
    });
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("missing Luma request body");
    }
    expect(JSON.parse(requestBody)).toEqual(compiled.ok ? compiled.body : undefined);
  });

  it("rejects stale profiles, raw params, references, and output drift", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileLumaRay2Request(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileLumaRay2Request(vendorInput(frozenPlan(), { params: { loop: true } })),
    ).toMatchObject({ ok: false });
    expect(compileLumaRay2Request(vendorInput(frozenPlan(), { params: {} }))).toMatchObject({
      ok: false,
    });
    expect(compileLumaRay2Request(vendorInput(frozenPlan(), { sources: [] }))).toMatchObject({
      ok: false,
    });

    const referenced = frozenPlan();
    referenced.generationIntent.references.push({
      role: "first_frame",
      ordinal: 0,
      required: true,
      mediaClass: "image",
      source: { kind: "artifact", artifactId: "artifact-not-supported" },
      authorityVerified: true,
    });
    expect(compileLumaRay2Request(vendorInput(referenced))).toMatchObject({ ok: false });
    expect(compileLumaRay2Request(vendorInput(frozenPlan({ durationSec: 6 })))).toMatchObject({
      ok: false,
    });
    expect(
      compileLumaRay2Request(vendorInput(frozenPlan({ aspectRatio: "2:1", resolution: "8k" }))),
    ).toMatchObject({ ok: false });
  });

  it("accepts only the exact legacy V1 read-old identity alongside active V2", () => {
    const legacy = frozenPlan({
      profile: {
        profileId: LUMA_RAY2_LEGACY_PROFILE_ID,
        revision: LUMA_RAY2_LEGACY_PROFILE_REVISION,
        digest: LUMA_RAY2_LEGACY_PROFILE_DIGEST,
      },
    });
    expect(compileLumaRay2Request(vendorInput(legacy))).toMatchObject({
      ok: true,
    });

    legacy.capabilityProfileRef.revision += 1;
    expect(compileLumaRay2Request(vendorInput(legacy))).toMatchObject({
      ok: false,
    });
  });

  it.each([
    "generationScenario",
    "outputAudioPolicy",
    "compiledPrompt",
    "output.durationSec",
    "output.aspectRatio",
    "output.resolution",
  ])("rejects a frozen plan missing the exact %s mapping", (intentPath) => {
    const plan = frozenPlan();
    plan.constraintPlan = plan.constraintPlan.filter((row) => row.intentPath !== intentPath);
    expect(compileLumaRay2Request(vendorInput(plan))).toMatchObject({ ok: false });
  });

  it("marks an ambiguous create without exposing transport details", async () => {
    const vendor = createLumaRuntimeVendor({
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
        routeId: LUMA_RAY2_ROUTE_ID,
        adapterRevision: LUMA_RAY2_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
        qualityOutcome: "not_run",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("normalizes generation states, output, failures, and deletion", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (value.endsWith("/queued")) {
        return new Response(JSON.stringify({ state: "queued" }), { status: 200 });
      }
      if (value.endsWith("/dreaming")) {
        return new Response(JSON.stringify({ state: "dreaming" }), { status: 200 });
      }
      if (value.endsWith("/failed")) {
        return new Response(
          JSON.stringify({ state: "failed", failure_reason: "content policy blocked" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          state: "completed",
          assets: { video: "https://media.example/luma.mp4" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const vendor = createLumaRuntimeVendor({ apiKey: "secret", fetchImpl });

    expect(await vendor.poll("queued")).toMatchObject({ state: "processing" });
    expect(await vendor.poll("dreaming")).toMatchObject({ state: "processing" });
    expect(await vendor.reconcile!("failed")).toMatchObject({
      state: "failed",
      reason: "content_blocked",
      providerObservation: { operation: "reconcile", outcome: "failed" },
    });
    expect(await vendor.poll("completed")).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.example/luma.mp4" },
    });
    await expect(vendor.cancel!("delete-me")).resolves.toBeUndefined();
    expect(calls.at(-1)).toEqual({
      url: "https://api.lumalabs.ai/dream-machine/v1/generations/delete-me",
      method: "DELETE",
    });
  });

  it("downloads the output before quality proof and Artifact handoff", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/generations/video") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "luma-job-artifact", state: "queued" }), {
          status: 201,
        });
      }
      if (value.endsWith("/generations/luma-job-artifact")) {
        return new Response(
          JSON.stringify({
            state: "completed",
            assets: { video: "https://media.example/luma.mp4" },
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from("luma-video-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-luma-output",
      mimeType: "video/mp4",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-luma",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async () => {
        throw new Error("Luma text-to-video must not resolve a reference");
      }),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createLumaRuntimeVendor({ apiKey: "secret", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-luma",
      workspaceId: "ws-luma",
      correlationId: "corr-luma-submit",
      presetId: "luma",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "luma-job-artifact",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-luma-poll",
      presetId: "luma",
      mode: "text2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-luma-output" },
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
