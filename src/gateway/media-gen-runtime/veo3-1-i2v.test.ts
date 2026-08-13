import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";
import { createVeoRuntimeVendor, VEO31_I2V_JOB_PREFIX } from "./veo-vendor.js";
import {
  VEO31_I2V_ADAPTER_REVISION,
  VEO31_I2V_ENDPOINT_ID,
  VEO31_I2V_MODEL_ID,
  VEO31_I2V_PROFILE_DIGEST,
  VEO31_I2V_PROFILE_ID,
  VEO31_I2V_ROUTE_ID,
} from "./veo3-1-i2v-compiler.js";
import { VEO31_T2V_ADAPTER_REVISION, VEO31_T2V_ROUTE_ID } from "./veo3-1-t2v-compiler.js";

const PROJECT = "wisclaw-veo-i2v-test";
const OPERATION_PREFIX =
  `projects/${PROJECT}/locations/us-central1/publishers/google/models/` +
  `${VEO31_I2V_MODEL_ID}/operations/`;
const IMAGE_BYTES = Buffer.from("veo-first-frame-image");
const IMAGE_SHA = createHash("sha256").update(IMAGE_BYTES).digest("hex");

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
    sourceRef: intentPath.startsWith("references.") ? "asset:first-frame" : "pack:R1",
    sourceRevision: "R1",
    required: true,
    support,
    ...target,
    reasonCode: support === "prompt" ? "prompt_compiled" : "value_native",
    messageKey: support === "prompt" ? "media.prompt_compiled" : "media.value_native",
  };
}

function frozenPlan(): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A paper boat leaves the still first frame and crosses a rain-filled street.";
  return {
    schemaVersion: 2,
    previewId: "preview-veo-i2v",
    presetId: "veo",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-veo-i2v",
        shotId: "shot-veo-i2v",
        shotVersion: "R1",
        promptPackId: "pack-veo-i2v",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${IMAGE_SHA}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Low tracking shot beside the boat." },
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "artifact", artifactId: "artifact-veo-first-frame" },
          assetRefId: "asset-veo-first-frame",
          authorityRef: "artifact:artifact-veo-first-frame",
          authorityVerified: true,
          mimeType: "image/png",
          sourceDigest: `sha256:${IMAGE_SHA}`,
        },
      ],
      output: {
        durationSec: 6,
        aspectRatio: "16:9",
        resolution: "1080p",
        fps: 24,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: VEO31_I2V_ROUTE_ID,
      providerId: "google_vertex_ai",
      modelId: VEO31_I2V_MODEL_ID,
      endpointId: VEO31_I2V_ENDPOINT_ID,
      region: "us-central1",
      accountTier: "adc",
    },
    capabilityProfileRef: {
      profileId: VEO31_I2V_PROFILE_ID,
      revision: 1,
      digest: VEO31_I2V_PROFILE_DIGEST,
    },
    adapterRevision: VEO31_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-veo-i2v", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    constraintPlan: [
      mapping("generationScenario", "native", { providerField: "scenario" }),
      mapping("outputAudioPolicy", "native", { providerField: "output.audio" }),
      mapping("compiledPrompt", "prompt", { providerField: "prompt" }),
      mapping("camera.cameraPrompt", "prompt", { providerField: "prompt" }),
      mapping("references.first_frame.0", "native", {
        providerSlot: "references.first_frame",
      }),
      ...["output.durationSec", "output.aspectRatio", "output.resolution", "output.fps"].map(
        (path) => mapping(path, "native", { providerField: path }),
      ),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlot(): MediaGenRuntimeSourceSlot {
  return {
    role: "first_frame",
    ordinal: 0,
    source: {
      bytes: IMAGE_BYTES,
      mimeType: "image/png",
      sha256: IMAGE_SHA,
    },
  };
}

function vendorInput(plan = frozenPlan()): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-veo-i2v",
    presetId: "veo",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    sources: [sourceSlot()],
    frozenPlan: plan,
  };
}

function vendor(fetchImpl: typeof fetch) {
  return createVeoRuntimeVendor({
    projectId: PROJECT,
    accessTokenProvider: vi.fn(async () => "adc-token"),
    fetchImpl,
    maxOutputBytes: 1024,
  });
}

describe("Veo 3.1 exact first-frame Image-to-Video runtime", () => {
  it("submits only the frozen I2V body and writes a route-bound receipt", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      return new Response(JSON.stringify({ name: `${OPERATION_PREFIX}image-operation` }));
    }) as unknown as typeof fetch;

    const runtimeVendor = vendor(fetchImpl);
    expect(runtimeVendor.capabilityRouteClaims?.some((claim) => claim.mode === "image2video")).toBe(
      false,
    );
    expect(runtimeVendor.supportsMultiReference).toBe(true);
    expect(await runtimeVendor.submit(vendorInput())).toMatchObject({
      state: "processing",
      vendorJobId: `${VEO31_I2V_JOB_PREFIX}image-operation`,
      providerObservation: {
        routeId: VEO31_I2V_ROUTE_ID,
        adapterRevision: VEO31_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url.endsWith(`${VEO31_I2V_MODEL_ID}:predictLongRunning`)).toBe(true);
    const body = calls[0]?.init?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new Error("missing Veo I2V request body");
    }
    expect(JSON.parse(body)).toMatchObject({
      instances: [
        {
          image: {
            bytesBase64Encoded: IMAGE_BYTES.toString("base64"),
            mimeType: "image/png",
          },
        },
      ],
      parameters: { task: "imageToVideo", generateAudio: false, resizeMode: "pad" },
    });
  });

  it("keeps I2V submission ambiguity bound to the exact route", async () => {
    const runtimeVendor = vendor(
      vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    );
    const result = await runtimeVendor.submit(vendorInput());
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: VEO31_I2V_ROUTE_ID,
        adapterRevision: VEO31_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("decodes I2V receipts while preserving legacy bare T2V operations", async () => {
    const calls: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push(body);
      return new Response(JSON.stringify({ name: body?.operationName, done: false }));
    }) as unknown as typeof fetch;
    const runtimeVendor = vendor(fetchImpl);

    expect(await runtimeVendor.poll(`${VEO31_I2V_JOB_PREFIX}pending-image`)).toMatchObject({
      state: "processing",
      vendorJobId: `${VEO31_I2V_JOB_PREFIX}pending-image`,
      providerObservation: {
        routeId: VEO31_I2V_ROUTE_ID,
        adapterRevision: VEO31_I2V_ADAPTER_REVISION,
      },
    });
    expect(await runtimeVendor.reconcile!("pending-text")).toMatchObject({
      state: "processing",
      vendorJobId: "pending-text",
      providerObservation: {
        routeId: VEO31_T2V_ROUTE_ID,
        adapterRevision: VEO31_T2V_ADAPTER_REVISION,
      },
    });
    expect(calls).toEqual([
      { operationName: `${OPERATION_PREFIX}pending-image` },
      { operationName: `${OPERATION_PREFIX}pending-text` },
    ]);
    expect(await runtimeVendor.poll(`${VEO31_I2V_JOB_PREFIX}bad:id`)).toMatchObject({
      state: "failed",
      reason: "vendor_failed",
      providerObservation: { routeId: VEO31_I2V_ROUTE_ID },
    });
  });

  it("redeems one Artifact frame and completes canonical output handoff", async () => {
    const outputBytes = Buffer.from("veo-i2v-output");
    let submittedBody: unknown;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(url).endsWith(":predictLongRunning")) {
        submittedBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        return new Response(JSON.stringify({ name: `${OPERATION_PREFIX}artifact-operation` }));
      }
      return new Response(
        JSON.stringify({
          name: `${OPERATION_PREFIX}artifact-operation`,
          done: true,
          response: {
            raiMediaFilteredCount: 0,
            videos: [
              {
                bytesBase64Encoded: outputBytes.toString("base64"),
                mimeType: "video/mp4",
              },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const resolveArtifactReference = vi.fn(
      async ({
        artifactId,
        role,
      }: Parameters<MediaGenRuntimeBridge["resolveArtifactReference"]>[0]) => {
        expect(artifactId).toBe("artifact-veo-first-frame");
        expect(role).toBe("first_frame");
        return sourceSlot().source;
      },
    );
    const handoffArtifact = vi.fn(
      async ({ bytes, sha256 }: Parameters<MediaGenRuntimeBridge["handoffArtifact"]>[0]) => {
        expect(bytes).toEqual(outputBytes);
        return { artifactId: "artifact-veo-i2v-output", mimeType: "video/mp4", sha256 };
      },
    );
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-veo-i2v",
      register: vi.fn(async () => undefined),
      resolveArtifactReference,
      handoffArtifact,
    };
    const screenInput = vi.fn(async () => ({ allowed: true }));
    const screenOutput = vi.fn(async () => ({ allowed: true }));
    const validateMediaBytes = vi.fn(async ({ bytes }: { bytes: Buffer }) => {
      expect(bytes).toEqual(outputBytes);
      return { ok: true as const };
    });
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor(fetchImpl)],
      fetchImpl,
      moderation: { screenInput, screenOutput },
      labeler: { applyLabel: vi.fn(async (output) => ({ ...output, applied: true })) },
      validateMediaBytes,
      maxMediaBytes: 1024,
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-veo-i2v-artifact",
      workspaceId: "workspace-veo-i2v",
      correlationId: "correlation-veo-i2v-submit",
      presetId: "veo",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 6,
      resolution: "1080p",
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-veo-first-frame",
          role: "first_frame",
          ordinal: 0,
        },
      ],
      frozenPlan: plan,
    };
    expect(JSON.stringify(dispatch)).not.toContain(IMAGE_BYTES.toString("base64"));

    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${VEO31_I2V_JOB_PREFIX}artifact-operation`,
    });
    expect(submittedBody).toMatchObject({
      instances: [{ image: { bytesBase64Encoded: IMAGE_BYTES.toString("base64") } }],
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "correlation-veo-i2v-poll",
      presetId: "veo",
      mode: "image2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-veo-i2v-output" },
      providerObservation: {
        routeId: VEO31_I2V_ROUTE_ID,
        adapterRevision: VEO31_I2V_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
      snapshot: { moderationStatus: "runtime_enforced", labelingStatus: "runtime_applied" },
    });
    expect(resolveArtifactReference).toHaveBeenCalledTimes(1);
    expect(screenInput).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "image2video", hasSource: true }),
    );
    expect(screenOutput).toHaveBeenCalledTimes(1);
    expect(validateMediaBytes).toHaveBeenCalledTimes(1);
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
