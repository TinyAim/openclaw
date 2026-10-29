import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { parseMediaGenRuntimeFrozenPlan, type MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  KLING_T2V_V2_ADAPTER_REVISION,
  KLING_T2V_V2_PROFILE_DIGEST,
  KLING_T2V_V2_PROFILE_ID,
  KLING_T2V_V2_PROFILE_REVISION,
  KLING_T2V_V2_ROUTE_ID,
} from "./kling-text2video-v2-compiler.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import type { MediaGenRuntimeBridge } from "./types.js";
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
function frozenPlan(
  overrides: { durationSec?: number; aspectRatio?: string; resolution?: string } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A courier crosses a neon-lit alley in one continuous tracking shot.";
  const result: MediaGenRuntimeFrozenPlanV2 = {
    schemaVersion: 2,
    previewId: "preview-kling-t2v-v2",
    presetId: "kling",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-kling",
        shotId: "shot-kling",
        shotVersion: "R1",
        promptPackId: "pack-kling",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: {
        visualPrompt: "A courier crosses a neon-lit alley.",
        reservedForLater: [],
      },
      camera: { cameraPrompt: "Low tracking shot." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "9:16",
        ...(overrides.resolution ? { resolution: overrides.resolution } : {}),
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: KLING_T2V_V2_ROUTE_ID,
      providerId: "kling_open_platform",
      modelId: "kling-v1",
      endpointId: "kling.v1.videos.text2video",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: KLING_T2V_V2_PROFILE_ID,
      revision: KLING_T2V_V2_PROFILE_REVISION,
      digest: KLING_T2V_V2_PROFILE_DIGEST,
    },
    adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-kling",
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
        reasonCode: "camera_prompt_compiled",
        messageKey: "media.camera_prompt_compiled",
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
        reasonCode: "aspect_ratio_native",
        messageKey: "media.aspect_ratio_native",
      },
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
  result.generationIntentDigest = `intent:sha256:${createHash("sha256").update(stableJson(result.generationIntent)).digest("hex")}`;
  return result;
}

const ambiguous = [
  "HTTP401",
  "HTTP429",
  "HTTP503",
  "invalidJSON",
  "nullJSON",
  "unknownStatus",
  "missingOutput",
  "insecureOutput",
] as const;
type QueryCase = (typeof ambiguous)[number] | "failed" | "processing";
function receipt(_kind: QueryCase): string {
  return "text2video-v2:old-job";
}
function response(kind: QueryCase): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        task_id: "old-job",
        task_status: kind === "missingOutput" || kind === "insecureOutput" ? "succeed" : kind,
        ...(kind === "insecureOutput"
          ? { task_result: { videos: [{ url: "http://example.test/video.mp4" }] } }
          : {}),
      },
    }),
  );
}
async function retry(kind: QueryCase, queryTaskId?: string) {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST")
      return new Response(JSON.stringify({ code: 0, data: { task_id: "replacement-job" } }));
    if (queryTaskId === undefined) return response(kind);
    const body = await response(kind).json();
    return new Response(JSON.stringify({ ...body, data: { ...body.data, task_id: queryTaskId } }));
  });
  const vendor = createKlingRuntimeVendor({
    accessKey: "test-only-access",
    secret: "test-only-secret",
    fetchImpl,
  });
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: plan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "retry",
    taskId: "task-kling-retry",
    workspaceId: "workspace-kling-retry",
    correlationId: "correlation-kling-retry",
    presetId: "kling",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 5,
    frozenPlan: plan,
    runtimeJobId: receipt(kind),
  };
  expect(parseDispatch(dispatch)).not.toBeNull();
  return { result: await executor.dispatch(dispatch), fetchImpl, bridge };
}
describe("Kling existing provider attempt query uncertainty", () => {
  it.each(ambiguous)("%s does not create another provider job", async (kind) => {
    const { result, fetchImpl, bridge } = await retry(kind);
    expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect.soft(result.status).toBe("failed");
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });
  it("explicit failed preserves the confirmed terminal replacement path", async () => {
    const { result, fetchImpl } = await retry("failed");
    expect(result).toMatchObject({
      status: "processing",
      runtimeJobId: "text2video-v2:replacement-job",
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("processing reuses the exact original attempt", async () => {
    const { result, fetchImpl } = await retry("processing");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: "text2video-v2:old-job" });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it.each(["failed", "HTTP503", "missingOutput"] as const)(
    "%s has honest stop-only evidence",
    async (kind) => {
      const fetchImpl = vi.fn(async () => response(kind));
      const forget = vi.fn();
      const result = await cancelMediaGenRuntimeJob({
        dispatch: {
          op: "cancel",
          taskId: "stop-task",
          workspaceId: "stop-workspace",
          correlationId: "stop-correlation",
          presetId: "kling",
          mode: "text2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createKlingRuntimeVendor({
            accessKey: "test-only-access",
            secret: "test-only-secret",
            fetchImpl,
          }),
          vendorJobId: receipt(kind),
        },
        forget,
      });
      expect(result).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: { state: kind === "failed" ? "confirmed" : "failed" },
      });
      expect(forget).toHaveBeenCalledTimes(kind === "failed" ? 1 : 0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Kling provider create outcome uncertainty", () => {
  async function submit(status: number, body = "{}") {
    const plan = frozenPlan();
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status }),
    );
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: plan.runtimeRef.runtimeId,
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [
        createKlingRuntimeVendor({
          accessKey: "test-only-access",
          secret: "test-only-secret",
          fetchImpl,
        }),
      ],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-kling-create",
      workspaceId: "workspace-kling-create",
      correlationId: "correlation-kling-create",
      presetId: "kling",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      frozenPlan: plan,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
    return result;
  }
  it.each([408, 500, 502, 503, 504])(
    "HTTP%s has an unknown create outcome and cannot offer failed-task retry",
    async (status) => {
      expect(await submit(status)).toMatchObject({
        status: "submission_unknown",
        providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        providerObservation: { operation: "submit", outcome: "submission_unknown" },
      });
    },
  );
  it.each([
    [400, "vendor_rejected"],
    [401, "auth"],
    [403, "auth"],
    [429, "quota"],
  ] as const)("HTTP%s retains definite rejection %s", async (status, reason) => {
    expect(await submit(status)).toMatchObject({
      status: "failed",
      failureReason: reason,
      providerObservation: { operation: "submit", outcome: "failed" },
    });
  });
  it.each(["{", "null", "{}"])(
    "unreadable successful create %s requires reconciliation",
    async (body) => {
      expect(await submit(200, body)).toMatchObject({
        status: "submission_unknown",
        providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        providerObservation: { operation: "submit", outcome: "submission_unknown" },
      });
    },
  );
  it("retains an explicit numeric business rejection in a successful HTTP receipt", async () => {
    expect(
      await submit(200, JSON.stringify({ code: 1003, message: "Request rejected." })),
    ).toMatchObject({
      status: "failed",
      failureReason: "vendor_rejected",
      providerObservation: { operation: "submit", outcome: "failed" },
    });
  });
});

describe("Kling explicit provider task identity binding", () => {
  const originalReceipt = "text2video-v2:old-job";
  function taskResponse(status: string, id: unknown = "foreign-job") {
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          task_id: id,
          task_status: status,
          task_result: { videos: [{ url: "https://example.test/output.mp4" }] },
        },
      }),
    );
  }
  it.each(["submitted", "processing", "succeed", "failed", "canceled"])(
    "foreign %s cannot supply current attempt evidence",
    async (status) => {
      const fetchImpl = vi.fn(async () => taskResponse(status));
      const vendor = createKlingRuntimeVendor({
        accessKey: "test-only-access",
        secret: "test-only-secret",
        fetchImpl,
      });
      expect(await vendor.reconcile!(originalReceipt)).toMatchObject({
        state: "failed",
        vendorJobId: originalReceipt,
        retryDisposition: "reconcile_only",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, 17, ""])(
    "explicit malformed task_id %s does not supply terminal evidence",
    async (id) => {
      const vendor = createKlingRuntimeVendor({
        accessKey: "test-only-access",
        secret: "test-only-secret",
        fetchImpl: vi.fn(async () => taskResponse("failed", id)),
      });
      expect(await vendor.reconcile!(originalReceipt)).toMatchObject({
        state: "failed",
        retryDisposition: "reconcile_only",
      });
    },
  );
  it("foreign failed cannot trigger replacement in the real executor", async () => {
    const { result, fetchImpl } = await retry("failed", "foreign-job");
    expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(result.status).toBe("failed");
  });
  it("foreign canceled evidence cannot confirm stopping the original attempt", async () => {
    const fetchImpl = vi.fn(async () => taskResponse("canceled"));
    const forget = vi.fn();
    const result = await cancelMediaGenRuntimeJob({
      dispatch: {
        op: "cancel",
        taskId: "stop-task",
        workspaceId: "stop-workspace",
        correlationId: "stop-correlation",
        presetId: "kling",
        mode: "text2video",
        runtimeJobId: originalReceipt,
      },
      tracked: {
        vendor: createKlingRuntimeVendor({
          accessKey: "test-only-access",
          secret: "test-only-secret",
          fetchImpl,
        }),
        vendorJobId: originalReceipt,
      },
      forget,
    });
    expect(result).toMatchObject({ status: "canceled", runtimeStopOutcome: { state: "failed" } });
    expect(forget).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["omitted", "matching"] as const)(
    "%s task_id preserves existing failed receipt compatibility",
    async (identity) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 0,
              data: {
                ...(identity === "matching" ? { task_id: "old-job" } : {}),
                task_status: "failed",
              },
            }),
          ),
      );
      const vendor = createKlingRuntimeVendor({
        accessKey: "test-only-access",
        secret: "test-only-secret",
        fetchImpl,
      });
      expect(await vendor.reconcile!(originalReceipt)).toMatchObject({
        state: "failed",
        vendorJobId: originalReceipt,
        retryDisposition: "replacement_allowed",
      });
    },
  );
  it("compares the provider id after decoding the frozen I2V prefix", async () => {
    const vendor = createKlingRuntimeVendor({
      accessKey: "test-only-access",
      secret: "test-only-secret",
      fetchImpl: vi.fn(async () => taskResponse("failed", "old-job")),
    });
    expect(await vendor.reconcile!("image2video-v2:old-job")).toMatchObject({
      state: "failed",
      vendorJobId: "image2video-v2:old-job",
      retryDisposition: "replacement_allowed",
    });
  });
});
