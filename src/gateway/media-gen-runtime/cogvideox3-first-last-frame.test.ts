import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import {
  COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
  COGVIDEOX3_FIRST_LAST_ENDPOINT_ID,
  COGVIDEOX3_FIRST_LAST_MODEL_ID,
  COGVIDEOX3_FIRST_LAST_PROFILE_DIGEST,
  COGVIDEOX3_FIRST_LAST_PROFILE_ID,
  COGVIDEOX3_FIRST_LAST_ROUTE_ID,
  compileCogVideoX3FirstLastRequest,
} from "./cogvideox3-first-last-frame-compiler.js";
import {
  COGVIDEOX3_FIRST_LAST_JOB_PREFIX,
  createCogVideoX3RuntimeVendor,
} from "./cogvideox3-vendor.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

const FIRST_BYTES = Buffer.from("cogvideox3-first-frame");
const LAST_BYTES = Buffer.from("cogvideox3-last-frame");

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
    resolution?: string;
    fps?: number;
    firstMime?: string;
    lastMime?: string;
    prompt?: string;
    outputAudioPolicy?: "silent" | "native_generate";
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt =
    overrides.prompt ?? "A paper boat crosses the pond between the supplied boundary frames.";
  const outputAudioPolicy = overrides.outputAudioPolicy ?? "silent";
  const reference = (role: "first_frame" | "last_frame", bytes: Buffer, mimeType: string) => ({
    role,
    ordinal: 0,
    required: true,
    mediaClass: "image" as const,
    source: { kind: "artifact" as const, artifactId: `artifact-cogvideox3-${role}` },
    assetRefId: `asset-cogvideox3-${role}`,
    authorityRef: `artifact:cogvideox3-${role}`,
    authorityVerified: true,
    mimeType,
    sourceDigest: `sha256:${sha(bytes)}`,
  });
  const mapping = (
    intentPath: string,
    providerField: string,
    support: "native" | "prompt" = "native",
  ) => ({
    intentPath,
    sourceRef: "plan:R1",
    sourceRevision: "R1",
    required: true,
    support,
    providerField,
    reasonCode: "exact_mapping",
    messageKey: "media.exact_mapping",
  });
  return {
    schemaVersion: 2,
    previewId: "preview-cogvideox3-first-last",
    presetId: "cogvideox",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-cogvideox3-first-last",
        shotId: "shot-cogvideox3-first-last",
        shotVersion: "R1",
        promptPackId: "pack-cogvideox3-first-last",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${sha(FIRST_BYTES)}`, `sha256:${sha(LAST_BYTES)}`],
      },
      generationScenario: "first_last_frame_to_video",
      outputAudioPolicy,
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [
        reference("first_frame", FIRST_BYTES, overrides.firstMime ?? "image/png"),
        reference("last_frame", LAST_BYTES, overrides.lastMime ?? "image/jpeg"),
      ],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "1080p",
        fps: overrides.fps ?? 30,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_last_frame_to_video",
    outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
      providerId: "zhipu_open_platform",
      modelId: COGVIDEOX3_FIRST_LAST_MODEL_ID,
      endpointId: COGVIDEOX3_FIRST_LAST_ENDPOINT_ID,
      region: "cn",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: COGVIDEOX3_FIRST_LAST_PROFILE_ID,
      revision: 1,
      digest: COGVIDEOX3_FIRST_LAST_PROFILE_DIGEST,
    },
    adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-cogvideox3", lastSeenAt: "2026-08-01T00:00:00Z" },
    constraintPlan: [
      mapping("generationScenario", "scenario"),
      mapping("outputAudioPolicy", "output.audio"),
      mapping("compiledPrompt", "prompt", "prompt"),
      ...(["first_frame", "last_frame"] as const).map((role) => ({
        intentPath: `references.${role}.0`,
        sourceRef: `asset:asset-cogvideox3-${role}`,
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerSlot: `references.${role}`,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
      ...[
        ["output.durationSec", "output.durationSec"],
        ["output.aspectRatio", "output.aspectRatio"],
        ["output.resolution", "output.resolution"],
        ["output.fps", "output.fps"],
      ].map(([intentPath, providerField]) => mapping(intentPath, providerField)),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlot(
  role: "first_frame" | "last_frame",
  bytes = role === "first_frame" ? FIRST_BYTES : LAST_BYTES,
  mimeType = role === "first_frame" ? "image/png" : "image/jpeg",
): MediaGenRuntimeSourceSlot {
  return { role, ordinal: 0, source: { bytes, mimeType, sha256: sha(bytes) } };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-cogvideox3-first-last",
    presetId: "cogvideox",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    // Deliberately reversed: the compiler must correlate role + ordinal, then
    // emit the provider-documented first-frame followed by last-frame order.
    sources: [
      sourceSlot("last_frame", LAST_BYTES, plan.generationIntent.references[1]?.mimeType),
      sourceSlot("first_frame", FIRST_BYTES, plan.generationIntent.references[0]?.mimeType),
    ],
    frozenPlan: plan,
    ...overrides,
  };
}

describe("CogVideoX-3 exact first/last-frame runtime", () => {
  it("compiles two verified frames in official first-then-last order", async () => {
    const compiled = compileCogVideoX3FirstLastRequest(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "cogvideox-3",
        image_url: [
          `data:image/png;base64,${FIRST_BYTES.toString("base64")}`,
          `data:image/jpeg;base64,${LAST_BYTES.toString("base64")}`,
        ],
        quality: "quality",
        with_audio: false,
        watermark_enabled: true,
        size: "1920x1080",
        fps: 30,
        duration: 5,
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      return new Response(JSON.stringify({ id: "zhipu-flf-1", task_status: "PROCESSING" }));
    }) as unknown as typeof fetch;
    const submitted = await createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl }).submit(
      vendorInput(),
    );
    expect(submitted).toMatchObject({
      state: "processing",
      vendorJobId: `${COGVIDEOX3_FIRST_LAST_JOB_PREFIX}zhipu-flf-1`,
      providerObservation: {
        routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
        adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe("https://open.bigmodel.cn/api/paas/v4/videos/generations");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual(
      compiled.ok ? compiled.body : undefined,
    );
  });

  it("rejects stale identity, passthrough, frame drift, and unsupported output before fetch", async () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileCogVideoX3FirstLastRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3FirstLastRequest(
        vendorInput(frozenPlan(), { params: { quality: "speed" } }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3FirstLastRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot("first_frame")] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3FirstLastRequest(
        vendorInput(frozenPlan(), {
          sources: [sourceSlot("first_frame"), sourceSlot("first_frame")],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3FirstLastRequest(
        vendorInput(frozenPlan({ firstMime: "image/webp" }), {
          sources: [sourceSlot("first_frame", FIRST_BYTES, "image/webp"), sourceSlot("last_frame")],
        }),
      ),
    ).toMatchObject({ ok: false });
    const digestDrift = sourceSlot("last_frame");
    digestDrift.source.sha256 = "f".repeat(64);
    expect(
      compileCogVideoX3FirstLastRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot("first_frame"), digestDrift] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileCogVideoX3FirstLastRequest(
        vendorInput(frozenPlan({ durationSec: 6, resolution: "4k", fps: 24 })),
      ),
    ).toMatchObject({ ok: false });

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const mismatched = frozenPlan();
    mismatched.adapterRevision = "openclaw-cogvideox3-image2video-runtime/v1";
    expect(
      await createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl }).submit(
        vendorInput(mismatched),
      ),
    ).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps ambiguous submit and restart reconciliation bound to this route", async () => {
    const ambiguous = createCogVideoX3RuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    });
    const unknown = await ambiguous.submit(vendorInput());
    expect(unknown).toMatchObject({
      state: "submission_unknown",
      providerObservation: {
        routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
        adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("private transport detail");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(requestUrl(url));
      return calls.length === 1
        ? new Response(JSON.stringify({ id: "job-flf-9", task_status: "PROCESSING" }))
        : new Response(
            JSON.stringify({
              id: "job-flf-9",
              task_status: "SUCCESS",
              video_result: [{ url: "https://media.bigmodel.example/first-last.mp4" }],
            }),
          );
    }) as unknown as typeof fetch;
    const restarted = createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl });
    const receipt = `${COGVIDEOX3_FIRST_LAST_JOB_PREFIX}job-flf-9`;
    expect(await restarted.poll(receipt)).toMatchObject({ state: "processing" });
    expect(await restarted.reconcile?.(receipt)).toMatchObject({
      state: "succeeded",
      providerObservation: {
        routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
        adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
        operation: "reconcile",
        outcome: "succeeded",
      },
    });
  });

  it("redeems both scoped grants and hands the validated output to Artifact Center", async () => {
    const outputBytes = Buffer.from("cogvideox3-first-last-video-bytes");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const value = requestUrl(url);
      if (value.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ id: "artifact-flf-job", task_status: "PROCESSING" }));
      }
      if (value.includes("/async-result/")) {
        return new Response(
          JSON.stringify({
            id: "artifact-flf-job",
            task_status: "SUCCESS",
            video_result: [{ url: "https://media.bigmodel.example/first-last-output.mp4" }],
          }),
        );
      }
      return new Response(outputBytes, {
        headers: { "content-type": "video/mp4", "content-length": String(outputBytes.length) },
      });
    }) as unknown as typeof fetch;
    const resolveArtifactReference = vi.fn(async ({ role }: { role?: string }) => ({
      bytes: role === "first_frame" ? FIRST_BYTES : LAST_BYTES,
      mimeType: role === "first_frame" ? "image/png" : "image/jpeg",
      sha256: sha(role === "first_frame" ? FIRST_BYTES : LAST_BYTES),
    }));
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-cogvideox3-first-last",
      mimeType: "video/mp4",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-cogvideox3",
      register: vi.fn(async () => undefined),
      resolveArtifactReference,
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createCogVideoX3RuntimeVendor({ apiKey: "key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.bigmodel.example"],
      moderation: {
        screenInput: vi.fn(async () => ({ allowed: true })),
        screenOutput: vi.fn(async () => ({ allowed: true })),
      },
      labeler: { applyLabel: vi.fn(async (output) => ({ ...output, applied: true })) },
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-cogvideox3-first-last",
      workspaceId: "ws-cogvideox3",
      correlationId: "corr-cogvideox3-first-last-submit",
      presetId: "cogvideox",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-cogvideox3-first_frame",
          role: "first_frame",
          ordinal: 0,
        },
        {
          kind: "artifact",
          artifactId: "artifact-cogvideox3-last_frame",
          role: "last_frame",
          ordinal: 0,
        },
      ],
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${COGVIDEOX3_FIRST_LAST_JOB_PREFIX}artifact-flf-job`,
    });
    expect(resolveArtifactReference.mock.calls.map(([input]) => input.role)).toEqual([
      "first_frame",
      "last_frame",
    ]);
    const completed = await executor.dispatch({
      ...dispatch,
      op: "poll",
      correlationId: "corr-cogvideox3-first-last-poll",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-cogvideox3-first-last" },
      providerObservation: {
        routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
        adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
      snapshot: { moderationStatus: "runtime_enforced", labelingStatus: "runtime_applied" },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
