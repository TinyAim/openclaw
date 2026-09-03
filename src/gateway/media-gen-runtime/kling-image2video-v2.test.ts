import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenRuntimeFrozenPlanV2,
} from "./frozen-plan.js";
import {
  compileKlingImage2VideoV2Request,
  KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
  KLING_IMAGE2VIDEO_V2_PROFILE_DIGEST,
  KLING_IMAGE2VIDEO_V2_ROUTE_ID,
} from "./kling-image2video-v2-compiler.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

const FIRST_BYTES = Buffer.from("kling-first-frame");
const LAST_BYTES = Buffer.from("kling-last-frame");

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function frameReference(
  role: "first_frame" | "last_frame",
  bytes: Buffer,
): MediaGenerationIntentReference {
  return {
    role,
    ordinal: 0,
    required: true,
    mediaClass: "image",
    source: { kind: "artifact", artifactId: `artifact-${role}` },
    assetRefId: `asset-${role}`,
    authorityRef: `artifact:${role}`,
    authorityVerified: true,
    mimeType: "image/png",
    sourceDigest: `sha256:${sha(bytes)}`,
  };
}

function frozenPlan(
  references = [
    frameReference("first_frame", FIRST_BYTES),
    frameReference("last_frame", LAST_BYTES),
  ],
): MediaGenRuntimeFrozenPlanV2 {
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project-short-drama",
      shotId: "shot-2-of-3",
      shotVersion: "R4",
      promptPackId: "prompt-pack-vertical",
      promptPackVersion: 3,
      promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: references.map((item) => item.sourceDigest!),
    },
    generationScenario: "first_last_frame_to_video" as const,
    outputAudioPolicy: "silent" as const,
    legacyMode: "image2video" as const,
    compiledPrompt: "9:16 short drama shot 2; medium tracking shot; avoid text artifacts",
    narrative: {
      visualPrompt: "A courier crosses frame and stops at a red door.",
      negativePrompt: "text artifacts",
      reservedForLater: [],
    },
    camera: { cameraPrompt: "medium tracking shot" },
    performance: {},
    look: { continuityPrompt: "same wardrobe and warm practical light" },
    references,
    output: {
      durationSec: 5,
      aspectRatio: "9:16",
      resolution: "1080p",
      shotCount: 1,
    },
    policy: { authority: "server" as const },
  };
  return {
    schemaVersion: 2,
    previewId: "preview-kling-image-v2",
    presetId: "kling",
    mode: "image2video",
    generationIntent: intent,
    generationIntentDigest: `intent:sha256:${createHash("sha256").update(stableJson(intent)).digest("hex")}`,
    generationScenario: intent.generationScenario,
    outputAudioPolicy: intent.outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: KLING_IMAGE2VIDEO_V2_ROUTE_ID,
      providerId: "kling_open_platform",
      modelId: "kling-v1",
      endpointId: "kling.v1.videos.image2video",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: "kling.openclaw-runtime.image2video.v3",
      revision: 3,
      digest: KLING_IMAGE2VIDEO_V2_PROFILE_DIGEST,
    },
    adapterRevision: KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-kling",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        providerField: "scenario",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        providerField: "output.audio",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: true,
        support: "prompt",
        providerField: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      ...references.map((reference) => ({
        intentPath: `references.${reference.role}.${reference.ordinal}`,
        sourceRef: `asset:${reference.assetRefId}`,
        sourceRevision: "R3",
        required: true,
        support: "native" as const,
        providerSlot: `references.${reference.role}`,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
      {
        intentPath: "output.durationSec",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: false,
        support: "native",
        providerField: "output.durationSec",
        reasonCode: "duration_native",
        messageKey: "media.duration_native",
      },
      {
        intentPath: "output.aspectRatio",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: false,
        support: "approximate",
        reasonCode: "output_value_profile_unknown",
        messageKey: "media.output_value_profile_unknown",
      },
      {
        intentPath: "output.resolution",
        sourceRef: "prompt:R3",
        sourceRevision: "R3",
        required: false,
        support: "approximate",
        reasonCode: "output_value_profile_unknown",
        messageKey: "media.output_value_profile_unknown",
      },
    ],
    inputFingerprint: "2".repeat(64),
    intentFingerprint: "3".repeat(64),
  };
}

function sourceSlots(plan: MediaGenRuntimeFrozenPlanV2): MediaGenRuntimeSourceSlot[] {
  return plan.generationIntent.references.map((reference) => ({
    role: reference.role,
    ordinal: reference.ordinal,
    source: {
      bytes: reference.role === "first_frame" ? FIRST_BYTES : LAST_BYTES,
      mimeType: "image/png",
      sha256: reference.sourceDigest!.slice(7),
    },
  }));
}

function vendorInput(plan = frozenPlan()): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-kling-v2",
    presetId: "kling",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 5,
    sources: sourceSlots(plan),
    frozenPlan: plan,
  };
}

describe("Kling exact Image2Video Adapter V2", () => {
  it("compiles only official image2video fields from typed frozen references", () => {
    const plan = frozenPlan();
    expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
    const compiled = compileKlingImage2VideoV2Request(vendorInput(plan));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(Object.keys(compiled.body)).toEqual([
      "model_name",
      "image",
      "image_tail",
      "prompt",
      "duration",
    ]);
    expect(compiled.body).toEqual({
      model_name: "kling-v1",
      image: FIRST_BYTES.toString("base64"),
      image_tail: LAST_BYTES.toString("base64"),
      prompt: plan.generationIntent.compiledPrompt,
      duration: "5",
    });
    expect(compiled.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(compiled.body)).not.toContain("aspect_ratio");
    expect(JSON.stringify(compiled.body)).not.toContain("cfg_scale");
  });

  it("rejects stale profile, passthrough params, and reference digest drift", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileKlingImage2VideoV2Request(vendorInput(stale))).toMatchObject({
      ok: false,
    });
    expect(
      compileKlingImage2VideoV2Request({
        ...vendorInput(),
        params: { cfg_scale: 0.5 },
      }),
    ).toMatchObject({ ok: false });
    const drift = vendorInput();
    drift.sources![0]!.source.sha256 = "0".repeat(64);
    expect(compileKlingImage2VideoV2Request(drift)).toMatchObject({ ok: false });
  });

  it("marks ambiguous create and measures submit without exposing vendor payloads", async () => {
    const vendor = createKlingRuntimeVendor({
      accessKey: "ak",
      secret: "sk",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    });
    expect(vendor.capabilityRouteClaims?.some((claim) => claim.mode === "image2video")).toBe(false);
    expect(vendor.supportsMultiReference).toBe(true);
    const result = await vendor.submit(vendorInput());
    expect(result).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: KLING_IMAGE2VIDEO_V2_ROUTE_ID,
        adapterRevision: KLING_IMAGE2VIDEO_V2_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
        qualityOutcome: "not_run",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  it("threads measured poll evidence through quality gate and Artifact handoff", async () => {
    const plan = frozenPlan();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/v1/videos/image2video") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(Object.keys(body)).toEqual([
          "model_name",
          "image",
          "image_tail",
          "prompt",
          "duration",
        ]);
        return new Response(JSON.stringify({ code: 0, data: { task_id: "k-job-1" } }), {
          status: 200,
        });
      }
      if (value.endsWith("/v1/videos/image2video/k-job-1")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              task_status: "succeed",
              task_result: { videos: [{ url: "https://media.example/kling.mp4" }] },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from("video-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-kling",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async ({ artifactId }) => {
        const bytes = artifactId.endsWith("first_frame") ? FIRST_BYTES : LAST_BYTES;
        return { bytes, mimeType: "image/png", sha256: sha(bytes) };
      }),
      handoffArtifact: vi.fn(async ({ sha256 }) => ({
        artifactId: "artifact-kling-output",
        mimeType: "video/mp4",
        sha256,
      })),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createKlingRuntimeVendor({ accessKey: "ak", secret: "sk", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-kling-v2",
      workspaceId: "ws-1",
      correlationId: "corr-submit",
      presetId: "kling",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      references: plan.generationIntent.references.map((reference) => ({
        ...reference.source,
        role: reference.role,
        ordinal: reference.ordinal,
      })),
      durationSec: 5,
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "image2video-v2:k-job-1",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-poll",
      presetId: "kling",
      mode: "image2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-kling-output" },
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
    });
    expect(bridge.handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
