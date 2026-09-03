import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import { LUMA_RAY2_ADAPTER_REVISION, LUMA_RAY2_ROUTE_ID } from "./luma-ray2-compiler.js";
import {
  LUMA_RAY2_I2V_ADAPTER_REVISION,
  LUMA_RAY2_I2V_ENDPOINT_ID,
  LUMA_RAY2_I2V_MODEL_ID,
  LUMA_RAY2_I2V_PROFILE_DIGEST,
  LUMA_RAY2_I2V_PROFILE_ID,
  LUMA_RAY2_I2V_ROUTE_ID,
} from "./luma-ray2-i2v-compiler.js";
import { createLumaRuntimeVendor, LUMA_RAY2_I2V_JOB_PREFIX } from "./luma-vendor.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeLabeler,
  MediaGenRuntimeModeration,
  MediaGenRuntimeVendorInput,
} from "./types.js";

const SOURCE_URL = "https://runtime.example/luma/first-frame.png";
const SOURCE_SHA = "a".repeat(64);

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function mapping(
  intentPath: string,
  support: "native" | "prompt",
  target: { providerField?: string; providerSlot?: string },
): MediaGenRuntimeFrozenPlanV2["constraintPlan"][number] {
  return {
    intentPath,
    sourceRef: intentPath.startsWith("references.") ? "runtime-local:frame-0" : "pack:R1",
    sourceRevision: "R1",
    required: true,
    support,
    ...target,
    reasonCode: "exact_route_mapping",
    messageKey: "media.exact_route_mapping",
  };
}

function frozenPlan(): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A lighthouse beam sweeps across a stormy sea.";
  return {
    schemaVersion: 2,
    previewId: "preview-luma-i2v-runtime",
    presetId: "luma",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-luma",
        shotId: "shot-luma",
        shotVersion: "R1",
        promptPackId: "pack-luma",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${SOURCE_SHA}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Slow dolly forward." },
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "runtime_local", runtimeLocalRef: "owner-frame-0" },
          authorityRef: "runtime-local:owner-frame-0",
          authorityVerified: true,
          mimeType: "image/png",
          sourceDigest: `sha256:${SOURCE_SHA}`,
        },
      ],
      output: {
        durationSec: 5,
        aspectRatio: "16:9",
        resolution: "1080p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: LUMA_RAY2_I2V_ROUTE_ID,
      providerId: "luma_dream_machine",
      modelId: LUMA_RAY2_I2V_MODEL_ID,
      endpointId: LUMA_RAY2_I2V_ENDPOINT_ID,
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: LUMA_RAY2_I2V_PROFILE_ID,
      revision: 1,
      digest: LUMA_RAY2_I2V_PROFILE_DIGEST,
    },
    adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-luma", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    constraintPlan: [
      mapping("generationScenario", "native", { providerField: "scenario" }),
      mapping("outputAudioPolicy", "native", { providerField: "output.audio" }),
      mapping("compiledPrompt", "prompt", { providerField: "prompt" }),
      mapping("camera.cameraPrompt", "prompt", { providerField: "prompt" }),
      mapping("references.first_frame.0", "native", {
        providerSlot: "references.first_frame",
      }),
      mapping("output.durationSec", "native", { providerField: "output.durationSec" }),
      mapping("output.aspectRatio", "native", { providerField: "output.aspectRatio" }),
      mapping("output.resolution", "native", { providerField: "output.resolution" }),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function vendorInput(): MediaGenRuntimeVendorInput {
  const plan = frozenPlan();
  return {
    taskId: "task-luma-i2v",
    presetId: "luma",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 5,
    resolution: "1080p",
    sources: [
      {
        role: "first_frame",
        ordinal: 0,
        source: { providerRef: SOURCE_URL, mimeType: "image/png", sha256: SOURCE_SHA },
      },
    ],
    frozenPlan: plan,
  };
}

describe("Luma Ray 2 exact first-frame Image-to-Video runtime", () => {
  it("posts the exact body with Bearer auth and returns an I2V route receipt", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createLumaRuntimeVendor({
      apiKey: "luma-secret",
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(JSON.stringify({ id: "provider-i2v-1", state: "queued" }), {
          status: 201,
        });
      }) as unknown as typeof fetch,
    });

    expect(vendor.supportsMultiReference).toBe(true);
    expect(vendor.capabilityRouteClaims).toContainEqual({
      presetId: "luma",
      mode: "image2video",
      route: {
        schemaVersion: 1,
        routeId: LUMA_RAY2_I2V_ROUTE_ID,
        providerId: "luma_dream_machine",
        modelId: LUMA_RAY2_I2V_MODEL_ID,
        endpointId: LUMA_RAY2_I2V_ENDPOINT_ID,
        region: "global",
        accountTier: "api_key",
      },
      adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
    });

    expect(await vendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: `${LUMA_RAY2_I2V_JOB_PREFIX}provider-i2v-1`,
      providerObservation: {
        routeId: LUMA_RAY2_I2V_ROUTE_ID,
        adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe("https://api.lumalabs.ai/dream-machine/v1/generations/video");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer luma-secret",
      "content-type": "application/json",
      accept: "application/json",
    });
    if (typeof calls[0]?.init?.body !== "string") {
      throw new Error("missing Luma body");
    }
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: "ray-2",
      prompt: "A lighthouse beam sweeps across a stormy sea.",
      duration: "5s",
      aspect_ratio: "16:9",
      resolution: "1080p",
      keyframes: { frame0: { type: "image", url: SOURCE_URL } },
    });
  });

  it("decodes I2V lifecycle receipts while preserving legacy raw T2V observations", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (value.endsWith("/i2v-pending")) {
        return new Response(JSON.stringify({ state: "dreaming" }));
      }
      return new Response(
        JSON.stringify({
          state: "completed",
          assets: { video: "https://media.example/luma-i2v.mp4" },
        }),
      );
    }) as unknown as typeof fetch;
    const vendor = createLumaRuntimeVendor({ apiKey: "secret", fetchImpl });

    expect(await vendor.poll(`${LUMA_RAY2_I2V_JOB_PREFIX}i2v-pending`)).toMatchObject({
      state: "processing",
      providerObservation: {
        routeId: LUMA_RAY2_I2V_ROUTE_ID,
        adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
        operation: "poll",
      },
    });
    expect(await vendor.reconcile!(`${LUMA_RAY2_I2V_JOB_PREFIX}i2v-complete`)).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://media.example/luma-i2v.mp4" },
      providerObservation: {
        routeId: LUMA_RAY2_I2V_ROUTE_ID,
        adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
        operation: "reconcile",
      },
    });
    expect(await vendor.poll("legacy-t2v-complete")).toMatchObject({
      state: "succeeded",
      providerObservation: {
        routeId: LUMA_RAY2_ROUTE_ID,
        adapterRevision: LUMA_RAY2_ADAPTER_REVISION,
        operation: "poll",
      },
    });
    await expect(vendor.cancel!(`${LUMA_RAY2_I2V_JOB_PREFIX}i2v-cancel`)).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.lumalabs.ai/dream-machine/v1/generations/i2v-pending",
      "https://api.lumalabs.ai/dream-machine/v1/generations/i2v-complete",
      "https://api.lumalabs.ai/dream-machine/v1/generations/legacy-t2v-complete",
      "https://api.lumalabs.ai/dream-machine/v1/generations/i2v-cancel",
    ]);
  });

  it("marks an ambiguous I2V submit without leaking the network failure", async () => {
    const vendor = createLumaRuntimeVendor({
      apiKey: "secret",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    });
    const result = await vendor.submit(vendorInput());
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      providerObservation: {
        routeId: LUMA_RAY2_I2V_ROUTE_ID,
        adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("resolves the owner handle locally before compliance, quality, and Artifact handoff", async () => {
    const videoBytes = Buffer.from("luma-i2v-video-bytes");
    const events: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/generations/video") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "artifact-job", state: "queued" }), {
          status: 201,
        });
      }
      if (value.endsWith("/generations/artifact-job")) {
        return new Response(
          JSON.stringify({
            state: "completed",
            assets: { video: "https://media.example/luma-i2v.mp4" },
          }),
        );
      }
      return new Response(videoBytes, { headers: { "content-type": "video/mp4" } });
    }) as unknown as typeof fetch;
    const moderation: MediaGenRuntimeModeration = {
      screenInput: vi.fn(async (input) => {
        events.push("moderation-input");
        expect(input).toMatchObject({ mode: "image2video", hasSource: true });
        return { allowed: true };
      }),
      screenOutput: vi.fn(async () => {
        events.push("moderation-output");
        return { allowed: true };
      }),
    };
    const labeler: MediaGenRuntimeLabeler = {
      applyLabel: vi.fn(async (output) => {
        events.push("label");
        return { ...output, applied: true };
      }),
    };
    const resolveArtifactReference = vi.fn(async () => {
      throw new Error("Luma runtime-local I2V must not redeem an Artifact reference");
    });
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => {
      events.push("handoff");
      return { artifactId: "artifact-luma-i2v", mimeType: "video/mp4", sha256 };
    });
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-luma",
      register: vi.fn(async () => undefined),
      resolveArtifactReference,
      handoffArtifact,
    };
    const resolveRuntimeLocalReference = vi.fn(async (input) => {
      events.push("resolve-runtime-local");
      expect(input).toMatchObject({
        runtimeLocalRef: "owner-frame-0",
        role: "first_frame",
        ordinal: 0,
      });
      return { providerRef: SOURCE_URL, mimeType: "image/png", sha256: SOURCE_SHA };
    });
    const validateMediaBytes = vi.fn(async ({ bytes, mimeType }) => {
      events.push("quality");
      expect(bytes).toEqual(videoBytes);
      expect(mimeType).toBe("video/mp4");
      return { ok: true as const, verified: true };
    });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createLumaRuntimeVendor({ apiKey: "secret", fetchImpl })],
      moderation,
      labeler,
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      resolveRuntimeLocalReference,
      validateMediaBytes,
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-luma-i2v",
      workspaceId: "ws-luma",
      correlationId: "corr-luma-submit",
      presetId: "luma",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      references: [
        {
          kind: "runtime_local",
          runtimeLocalRef: "owner-frame-0",
          role: "first_frame",
          ordinal: 0,
        },
      ],
      frozenPlan: plan,
    };
    expect(JSON.stringify(dispatch)).not.toContain("runtime.example");
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${LUMA_RAY2_I2V_JOB_PREFIX}artifact-job`,
    });
    const completed = await executor.dispatch({
      ...dispatch,
      op: "poll",
      correlationId: "corr-luma-poll",
      references: undefined,
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: {
        artifactId: "artifact-luma-i2v",
        sha256: createHash("sha256").update(videoBytes).digest("hex"),
      },
      snapshot: {
        moderationStatus: "runtime_enforced",
        labelingStatus: "runtime_applied",
      },
      providerObservation: {
        routeId: LUMA_RAY2_I2V_ROUTE_ID,
        adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
    });
    expect(resolveArtifactReference).not.toHaveBeenCalled();
    expect(resolveRuntimeLocalReference).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "resolve-runtime-local",
      "moderation-input",
      "moderation-output",
      "label",
      "quality",
      "handoff",
    ]);
  });
});
