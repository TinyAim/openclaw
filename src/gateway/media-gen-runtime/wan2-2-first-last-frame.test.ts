import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";
import { WAN22_FIRST_LAST_JOB_PREFIX, createWanRuntimeVendor } from "./wan-vendor.js";
import {
  compileWan22FirstLastRequest,
  WAN22_FIRST_LAST_ADAPTER_REVISION,
  WAN22_FIRST_LAST_ENDPOINT_ID,
  WAN22_FIRST_LAST_MODEL_ID,
  WAN22_FIRST_LAST_PROFILE_DIGEST,
  WAN22_FIRST_LAST_PROFILE_ID,
  WAN22_FIRST_LAST_ROUTE_ID,
} from "./wan2-2-first-last-frame-compiler.js";
import { wanTestJpeg, wanTestPng, wanTestSha } from "./wan2-2-i2v.test-support.js";

const FIRST_BYTES = wanTestPng(640, 360);
// The official route permits a last frame whose dimensions and ratio differ.
const LAST_BYTES = wanTestJpeg(480, 640);

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function frame(
  role: "first_frame" | "last_frame",
  bytes: Buffer,
  mimeType: "image/png" | "image/jpeg",
) {
  return {
    role,
    ordinal: 0,
    required: true,
    mediaClass: "image" as const,
    source: { kind: "artifact" as const, artifactId: `artifact-wan-${role}` },
    assetRefId: `asset-wan-${role}`,
    authorityRef: `artifact:wan-${role}`,
    authorityVerified: true,
    mimeType,
    sourceDigest: `sha256:${wanTestSha(bytes)}`,
  };
}

function frozenPlan(
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    fps?: number;
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt =
    overrides.prompt ?? "A paper boat crosses the pond between the supplied boundary frames.";
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
    previewId: "preview-wan-first-last",
    presetId: "wan",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-wan-first-last",
        shotId: "shot-wan-first-last",
        shotVersion: "R1",
        promptPackId: "pack-wan-first-last",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${wanTestSha(FIRST_BYTES)}`, `sha256:${wanTestSha(LAST_BYTES)}`],
      },
      generationScenario: "first_last_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [
        frame("first_frame", FIRST_BYTES, "image/png"),
        frame("last_frame", LAST_BYTES, "image/jpeg"),
      ],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "1080p",
        ...(overrides.fps === undefined ? {} : { fps: overrides.fps }),
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_last_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: WAN22_FIRST_LAST_ROUTE_ID,
      providerId: "dashscope",
      modelId: WAN22_FIRST_LAST_MODEL_ID,
      endpointId: WAN22_FIRST_LAST_ENDPOINT_ID,
      region: "cn-beijing",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: WAN22_FIRST_LAST_PROFILE_ID,
      revision: 1,
      digest: WAN22_FIRST_LAST_PROFILE_DIGEST,
    },
    adapterRevision: WAN22_FIRST_LAST_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-wan", lastSeenAt: "2026-08-01T00:00:00Z" },
    constraintPlan: [
      mapping("generationScenario", "scenario"),
      mapping("outputAudioPolicy", "output.audio"),
      mapping("compiledPrompt", "prompt", "prompt"),
      ...(["first_frame", "last_frame"] as const).map((role) => ({
        intentPath: `references.${role}.0`,
        sourceRef: `asset:asset-wan-${role}`,
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerSlot: `references.${role}`,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
      mapping("output.durationSec", "output.durationSec"),
      mapping("output.aspectRatio", "output.aspectRatio"),
      mapping("output.resolution", "output.resolution"),
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
  return { role, ordinal: 0, source: { bytes, mimeType, sha256: wanTestSha(bytes) } };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-wan-first-last",
    presetId: "wan",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    // Reverse materialization order to prove role+ordinal correlation.
    sources: [sourceSlot("last_frame"), sourceSlot("first_frame")],
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Wan 2.2 exact first/last-frame runtime", () => {
  it("compiles two verified frames into the documented image2video request", async () => {
    const compiled = compileWan22FirstLastRequest(vendorInput());
    expect(compiled).toMatchObject({
      ok: true,
      body: {
        model: "wan2.2-kf2v-flash",
        input: {
          prompt: "A paper boat crosses the pond between the supplied boundary frames.",
          first_frame_url: `data:image/png;base64,${FIRST_BYTES.toString("base64")}`,
          last_frame_url: `data:image/jpeg;base64,${LAST_BYTES.toString("base64")}`,
        },
        parameters: { resolution: "1080P", prompt_extend: false, watermark: true },
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      return new Response(
        JSON.stringify({ output: { task_id: "wan-kf2v-1", task_status: "PENDING" } }),
      );
    }) as unknown as typeof fetch;
    const submitted = await createWanRuntimeVendor({ apiKey: "key", fetchImpl }).submit(
      vendorInput(),
    );
    expect(submitted).toMatchObject({
      state: "processing",
      vendorJobId: `${WAN22_FIRST_LAST_JOB_PREFIX}wan-kf2v-1`,
      providerObservation: {
        routeId: WAN22_FIRST_LAST_ROUTE_ID,
        adapterRevision: WAN22_FIRST_LAST_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      },
    });
    expect(calls[0]?.url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis",
    );
    expect(calls[0]?.init?.headers).toMatchObject({ "x-dashscope-async": "enable" });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual(
      compiled.ok ? compiled.body : undefined,
    );
  });

  it("rejects identity drift, passthrough, bad slots, and invalid image constraints", async () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileWan22FirstLastRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileWan22FirstLastRequest(vendorInput(frozenPlan(), { params: { seed: 7 } })),
    ).toMatchObject({ ok: false });
    expect(
      compileWan22FirstLastRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot("first_frame")] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileWan22FirstLastRequest(
        vendorInput(frozenPlan(), {
          sources: [sourceSlot("first_frame"), sourceSlot("first_frame")],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileWan22FirstLastRequest(
        vendorInput(frozenPlan(), {
          sources: [
            sourceSlot("first_frame"),
            {
              role: "last_frame",
              ordinal: 0,
              source: { providerRef: "https://private.example/last.png", mimeType: "image/png" },
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
    const wrongFirstRatio = wanTestPng(640, 480);
    const ratioPlan = frozenPlan();
    ratioPlan.generationIntent.references[0] = frame("first_frame", wrongFirstRatio, "image/png");
    expect(
      compileWan22FirstLastRequest(
        vendorInput(ratioPlan, {
          sources: [sourceSlot("first_frame", wrongFirstRatio), sourceSlot("last_frame")],
        }),
      ),
    ).toMatchObject({ ok: false });
    const tinyLast = wanTestJpeg(239, 360);
    const tinyPlan = frozenPlan();
    tinyPlan.generationIntent.references[1] = frame("last_frame", tinyLast, "image/jpeg");
    expect(
      compileWan22FirstLastRequest(
        vendorInput(tinyPlan, {
          sources: [sourceSlot("first_frame"), sourceSlot("last_frame", tinyLast)],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(compileWan22FirstLastRequest(vendorInput(frozenPlan({ fps: 30 })))).toMatchObject({
      ok: false,
    });

    const unsupported = frozenPlan();
    unsupported.providerRouteRef.routeId = "wan.dashscope.unknown.image2video";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      await createWanRuntimeVendor({ apiKey: "key", fetchImpl }).submit(vendorInput(unsupported)),
    ).toMatchObject({ state: "failed", reason: "vendor_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps ambiguous submit and restart reconciliation route-bound", async () => {
    const ambiguous = createWanRuntimeVendor({
      apiKey: "key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }) as unknown as typeof fetch,
    });
    const unknown = await ambiguous.submit(vendorInput());
    expect(unknown).toMatchObject({
      state: "submission_unknown",
      providerObservation: {
        routeId: WAN22_FIRST_LAST_ROUTE_ID,
        adapterRevision: WAN22_FIRST_LAST_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("private transport detail");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(requestUrl(url));
      return calls.length === 1
        ? new Response(JSON.stringify({ output: { task_status: "RUNNING" } }))
        : new Response(
            JSON.stringify({
              output: {
                task_status: "SUCCEEDED",
                video_url: "https://media.example/wan-first-last.mp4",
              },
            }),
          );
    }) as unknown as typeof fetch;
    const restarted = createWanRuntimeVendor({ apiKey: "key", fetchImpl });
    const receipt = `${WAN22_FIRST_LAST_JOB_PREFIX}wan-kf2v-9`;
    expect(await restarted.poll(receipt)).toMatchObject({ state: "processing" });
    expect(await restarted.reconcile?.(receipt)).toMatchObject({
      state: "succeeded",
      providerObservation: {
        routeId: WAN22_FIRST_LAST_ROUTE_ID,
        adapterRevision: WAN22_FIRST_LAST_ADAPTER_REVISION,
        operation: "reconcile",
        outcome: "succeeded",
      },
    });
    expect(calls).toEqual([
      "https://dashscope.aliyuncs.com/api/v1/tasks/wan-kf2v-9",
      "https://dashscope.aliyuncs.com/api/v1/tasks/wan-kf2v-9",
    ]);
  });

  it("redeems both role-scoped grants and hands output bytes to Artifact Center", async () => {
    const outputBytes = Buffer.from("wan-first-last-video-bytes");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/video-synthesis") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ output: { task_id: "wan-artifact-kf2v", task_status: "PENDING" } }),
        );
      }
      if (value.endsWith("/tasks/wan-artifact-kf2v")) {
        return new Response(
          JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              video_url: "https://media.example/wan-first-last-output.mp4",
            },
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
      sha256: wanTestSha(role === "first_frame" ? FIRST_BYTES : LAST_BYTES),
    }));
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-wan-first-last-output",
      mimeType: "video/mp4",
      sha256,
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-wan",
      register: vi.fn(async () => undefined),
      resolveArtifactReference,
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createWanRuntimeVendor({ apiKey: "key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
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
      taskId: "task-wan-first-last",
      workspaceId: "ws-wan",
      correlationId: "corr-wan-first-last-submit",
      presetId: "wan",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-wan-first_frame",
          role: "first_frame",
          ordinal: 0,
        },
        { kind: "artifact", artifactId: "artifact-wan-last_frame", role: "last_frame", ordinal: 0 },
      ],
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: `${WAN22_FIRST_LAST_JOB_PREFIX}wan-artifact-kf2v`,
    });
    expect(resolveArtifactReference.mock.calls.map(([input]) => input.role)).toEqual([
      "first_frame",
      "last_frame",
    ]);
    const completed = await executor.dispatch({
      ...dispatch,
      op: "poll",
      correlationId: "corr-wan-first-last-poll",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-wan-first-last-output" },
      providerObservation: {
        routeId: WAN22_FIRST_LAST_ROUTE_ID,
        adapterRevision: WAN22_FIRST_LAST_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
      snapshot: { moderationStatus: "runtime_enforced", labelingStatus: "runtime_applied" },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
