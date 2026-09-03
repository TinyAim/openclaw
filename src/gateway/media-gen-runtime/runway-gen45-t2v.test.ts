import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  RUNWAY_GEN45_T2V_ADAPTER_REVISION,
  RUNWAY_GEN45_T2V_ENDPOINT_ID,
  RUNWAY_GEN45_T2V_MODEL_ID,
  RUNWAY_GEN45_T2V_PROFILE_DIGEST,
  RUNWAY_GEN45_T2V_PROFILE_ID,
  RUNWAY_GEN45_T2V_PROFILE_REVISION,
  RUNWAY_GEN45_T2V_ROUTE_ID,
} from "./runway-gen45-t2v-compiler.js";
import { createRunwayRuntimeVendor, RUNWAY_API_VERSION } from "./runway-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";

const JOB_PREFIX = "runway-gen45-t2v:";

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function constraint(
  intentPath: string,
  support: "native" | "prompt",
  providerField: string,
): MediaGenRuntimeFrozenPlanV2["constraintPlan"][number] {
  return {
    intentPath,
    sourceRef: intentPath === "compiledPrompt" ? "pack:R1" : "shot:R1",
    sourceRevision: "R1",
    required: true,
    support,
    providerField,
    reasonCode: support === "prompt" ? "prompt_compiled" : "value_native",
    messageKey: support === "prompt" ? "media.prompt_compiled" : "media.value_native",
  };
}

function frozenPlan(): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A paper kite crosses a skyline in warm sunset light.";
  return {
    schemaVersion: 2,
    previewId: "preview-runway-gen45",
    presetId: "runway",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-runway",
        shotId: "shot-runway",
        shotVersion: "R1",
        promptPackId: "pack-runway",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: 6,
        aspectRatio: "9:16",
        resolution: "720p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
      providerId: "runway_api",
      modelId: RUNWAY_GEN45_T2V_MODEL_ID,
      endpointId: RUNWAY_GEN45_T2V_ENDPOINT_ID,
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: RUNWAY_GEN45_T2V_PROFILE_ID,
      revision: RUNWAY_GEN45_T2V_PROFILE_REVISION,
      digest: RUNWAY_GEN45_T2V_PROFILE_DIGEST,
    },
    adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-runway", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    constraintPlan: [
      constraint("generationScenario", "native", "scenario"),
      constraint("outputAudioPolicy", "native", "output.audio"),
      constraint("compiledPrompt", "prompt", "prompt"),
      constraint("output.durationSec", "native", "output.durationSec"),
      constraint("output.aspectRatio", "native", "output.aspectRatio"),
      constraint("output.resolution", "native", "output.resolution"),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function vendorInput(): MediaGenRuntimeVendorInput {
  const plan = frozenPlan();
  return {
    taskId: "task-runway-gen45",
    presetId: "runway",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 6,
    resolution: "720p",
    frozenPlan: plan,
  };
}

describe("Runway Gen-4.5 exact Text-to-Video runtime", () => {
  it("posts only the exact body and versioned headers, returning a route-bound receipt", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createRunwayRuntimeVendor({
      apiKey: "runway-secret",
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(JSON.stringify({ id: "provider-job-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(await vendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: `${JOB_PREFIX}provider-job-1`,
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      providerObservation: {
        routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
        adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe("https://api.dev.runwayml.com/v1/text_to_video");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer runway-secret",
      "content-type": "application/json",
      accept: "application/json",
      "X-Runway-Version": RUNWAY_API_VERSION,
    });
    if (typeof calls[0]?.init?.body !== "string") {
      throw new Error("missing Runway Gen-4.5 request body");
    }
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "gen4.5",
      promptText: "A paper kite crosses a skyline in warm sunset light.",
      ratio: "720:1280",
      duration: 6,
    });
    expect(Object.keys(body)).toEqual(["model", "promptText", "ratio", "duration"]);
  });

  it("decodes prefixed poll, reconcile, and cancel receipts to the provider id", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method });
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (value.endsWith("/provider-canceled")) {
        return new Response(JSON.stringify({ status: "CANCELED" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: "SUCCEEDED",
          output: ["https://media.example/runway-gen45.mp4"],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const vendor = createRunwayRuntimeVendor({ apiKey: "secret", fetchImpl });

    expect(await vendor.poll(`${JOB_PREFIX}provider-canceled`)).toMatchObject({
      state: "canceled",
      vendorJobId: `${JOB_PREFIX}provider-canceled`,
      providerObservation: {
        routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
        adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
        operation: "poll",
        outcome: "canceled",
      },
    });
    expect(await vendor.reconcile!(`${JOB_PREFIX}provider-succeeded`)).toMatchObject({
      state: "succeeded",
      vendorJobId: `${JOB_PREFIX}provider-succeeded`,
      output: { mediaRef: "https://media.example/runway-gen45.mp4", mimeType: "video/mp4" },
      providerObservation: {
        routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
        adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
        operation: "reconcile",
        outcome: "succeeded",
      },
    });
    await expect(vendor.cancel!(`${JOB_PREFIX}provider-cancel`)).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.dev.runwayml.com/v1/tasks/provider-canceled",
      "https://api.dev.runwayml.com/v1/tasks/provider-succeeded",
      "https://api.dev.runwayml.com/v1/tasks/provider-cancel",
    ]);
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("marks an ambiguous create without leaking the network failure", async () => {
    const vendor = createRunwayRuntimeVendor({
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
        routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
        adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("downloads the HTTPS output before quality proof and canonical Artifact handoff", async () => {
    const videoBytes = Buffer.from("runway-gen45-video-bytes");
    const events: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/v1/text_to_video") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "provider-artifact-job" }), { status: 200 });
      }
      if (value.endsWith("/v1/tasks/provider-artifact-job")) {
        return new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            output: ["https://media.example/runway-gen45.mp4"],
          }),
          { status: 200 },
        );
      }
      return new Response(videoBytes, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const resolveArtifactReference = vi.fn(async () => {
      throw new Error("Runway T2V must not resolve an input reference");
    });
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => {
      events.push("handoff");
      return { artifactId: "artifact-runway-gen45", mimeType: "video/mp4", sha256 };
    });
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-runway",
      register: vi.fn(async () => undefined),
      resolveArtifactReference,
      handoffArtifact,
    };
    const validateMediaBytes = vi.fn(async ({ bytes, mimeType }) => {
      events.push("quality");
      expect(bytes).toEqual(videoBytes);
      expect(mimeType).toBe("video/mp4");
      return { ok: true as const, verified: true };
    });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createRunwayRuntimeVendor({ apiKey: "secret", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes,
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-runway-gen45",
      workspaceId: "ws-runway",
      correlationId: "corr-runway-submit",
      presetId: "runway",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 6,
      resolution: "720p",
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${JOB_PREFIX}provider-artifact-job`,
      providerObservation: {
        routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
        operation: "submit",
        outcome: "processing",
      },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-runway-poll",
      presetId: "runway",
      mode: "text2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      runtimeJobId: `${JOB_PREFIX}provider-artifact-job`,
      artifact: {
        artifactId: "artifact-runway-gen45",
        mimeType: "video/mp4",
        sha256: createHash("sha256").update(videoBytes).digest("hex"),
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      providerObservation: {
        routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
    });
    expect(resolveArtifactReference).not.toHaveBeenCalled();
    expect(validateMediaBytes).toHaveBeenCalledTimes(1);
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["quality", "handoff"]);
  });
});
