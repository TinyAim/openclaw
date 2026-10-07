import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { parseMediaGenRuntimeFrozenPlan, type MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge } from "./types.js";
import { createWanRuntimeVendor } from "./wan-vendor.js";
import {
  WAN22_T2V_ADAPTER_REVISION,
  WAN22_T2V_PROFILE_DIGEST,
  WAN22_T2V_ROUTE_ID,
} from "./wan2-2-t2v-compiler.js";
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
  const prompt = "A paper kite crosses the Beijing skyline in warm sunset light.";
  const result: MediaGenRuntimeFrozenPlanV2 = {
    schemaVersion: 2,
    previewId: "preview-wan",
    presetId: "wan",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-wan",
        shotId: "shot-wan",
        shotVersion: "R1",
        promptPackId: "pack-wan",
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
      camera: { cameraPrompt: "Slow pan right." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
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
      routeId: WAN22_T2V_ROUTE_ID,
      providerId: "dashscope",
      modelId: "wan2.2-t2v-plus",
      endpointId: "dashscope.api.v1.video_generation.video_synthesis",
      region: "cn-beijing",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: "wan.openclaw-runtime.wan2_2_t2v_plus.text2video.1080p.v2",
      revision: 2,
      digest: WAN22_T2V_PROFILE_DIGEST,
    },
    adapterRevision: WAN22_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-wan", lastSeenAt: "2026-07-31T00:00:00.000Z" },
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
  "invalidReceipt",
] as const;
type QueryCase = (typeof ambiguous)[number] | "FAILED" | "RUNNING" | "CANCELED";
function receipt(kind: QueryCase): string {
  return kind === "invalidReceipt" ? "unsupported:old-job" : "old-job";
}
function response(kind: QueryCase, jobId: unknown = "old-job"): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  return new Response(
    JSON.stringify({
      output: {
        task_id: jobId,
        task_status: kind === "missingOutput" || kind === "insecureOutput" ? "SUCCEEDED" : kind,
        ...(kind === "insecureOutput" ? { video_url: "http://example.test/video.mp4" } : {}),
      },
    }),
  );
}
async function retry(kind: QueryCase, jobId: unknown = "old-job") {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(
          JSON.stringify({ output: { task_id: "replacement-job", task_status: "PENDING" } }),
        )
      : response(kind, jobId),
  );
  const vendor = createWanRuntimeVendor({
    apiKey: "test-only-credential",
    workspaceId: "test-wan-workspace",
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
    taskId: "task-wan-retry",
    workspaceId: "workspace-wan-retry",
    correlationId: "correlation-wan-retry",
    presetId: "wan",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 5,
    resolution: "1080p",
    frozenPlan: plan,
    runtimeJobId: receipt(kind),
  };
  return { result: await executor.dispatch(dispatch), fetchImpl, bridge };
}
describe("Wan existing provider attempt query uncertainty", () => {
  it.each(ambiguous)("%s does not create another provider job", async (kind) => {
    const { result, fetchImpl, bridge } = await retry(kind);
    expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect.soft(result.status).toBe("failed");
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });
  it("explicit FAILED preserves the confirmed terminal replacement path", async () => {
    const { result, fetchImpl } = await retry("FAILED");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: "replacement-job" });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("RUNNING reuses the exact original attempt", async () => {
    const { result, fetchImpl } = await retry("RUNNING");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: "old-job" });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it.each(["FAILED", "HTTP503", "missingOutput", "invalidReceipt"] as const)(
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
          presetId: "wan",
          mode: "text2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createWanRuntimeVendor({
            apiKey: "test-only-credential",
            workspaceId: "test-wan-workspace",
            fetchImpl,
          }),
          vendorJobId: receipt(kind),
        },
        forget,
      });
      expect(result).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: { state: kind === "FAILED" ? "confirmed" : "failed" },
      });
      expect(forget).toHaveBeenCalledTimes(kind === "FAILED" ? 1 : 0);
      expect(fetchImpl).toHaveBeenCalledTimes(kind === "invalidReceipt" ? 0 : 1);
    },
  );
});

describe("Wan provider create outcome uncertainty", () => {
  async function submit(status: number) {
    const plan = frozenPlan();
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status }),
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
        createWanRuntimeVendor({
          apiKey: "test-only-credential",
          workspaceId: "test-wan-workspace",
          fetchImpl,
        }),
      ],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-wan-create",
      workspaceId: "workspace-wan-create",
      correlationId: "correlation-wan-create",
      presetId: "wan",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
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
});

describe("Wan explicit provider job identity binding", () => {
  it.each(["RUNNING", "SUCCEEDED", "FAILED", "CANCELED"] as const)(
    "foreign %s cannot supply current attempt evidence",
    async (status) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output: {
                task_id: "foreign-job",
                task_status: status,
                video_url: "https://example.test/output.mp4",
              },
            }),
          ),
      );
      const vendor = createWanRuntimeVendor({
        apiKey: "test-only-credential",
        workspaceId: "test-wan-workspace",
        fetchImpl,
      });
      expect(await vendor.reconcile!("old-job")).toMatchObject({
        state: "failed",
        vendorJobId: "old-job",
        retryDisposition: "reconcile_only",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, 17, ""])(
    "explicit malformed id %s does not supply terminal evidence",
    async (id) => {
      const vendor = createWanRuntimeVendor({
        apiKey: "test-only-credential",
        workspaceId: "test-wan-workspace",
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify({ output: { task_id: id, task_status: "FAILED" } })),
        ),
      });
      expect(await vendor.reconcile!("old-job")).toMatchObject({
        state: "failed",
        retryDisposition: "reconcile_only",
      });
    },
  );
  it("foreign FAILED cannot trigger replacement in the real executor", async () => {
    const { result, fetchImpl } = await retry("FAILED", "foreign-job");
    expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(result.status).toBe("failed");
  });
  it("foreign canceled evidence cannot confirm stopping the original attempt", async () => {
    const fetchImpl = vi.fn(async () => response("CANCELED", "foreign-job"));
    const forget = vi.fn();
    const result = await cancelMediaGenRuntimeJob({
      dispatch: {
        op: "cancel",
        taskId: "stop-task",
        workspaceId: "stop-workspace",
        correlationId: "stop-correlation",
        presetId: "wan",
        mode: "text2video",
        runtimeJobId: "old-job",
      },
      tracked: {
        vendor: createWanRuntimeVendor({
          apiKey: "test-only-credential",
          workspaceId: "test-wan-workspace",
          fetchImpl,
        }),
        vendorJobId: "old-job",
      },
      forget,
    });
    expect(result).toMatchObject({ status: "canceled", runtimeStopOutcome: { state: "failed" } });
    expect(forget).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["omitted", "matching"] as const)(
    "%s id preserves existing failed receipt compatibility",
    async (identity) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output: {
                ...(identity === "matching" ? { task_id: "old-job" } : {}),
                task_status: "FAILED",
              },
            }),
          ),
      );
      const vendor = createWanRuntimeVendor({
        apiKey: "test-only-credential",
        workspaceId: "test-wan-workspace",
        fetchImpl,
      });
      expect(await vendor.reconcile!("old-job")).toMatchObject({
        state: "failed",
        vendorJobId: "old-job",
        retryDisposition: "replacement_allowed",
      });
    },
  );
  it("compares the provider id after decoding the frozen I2V prefix", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ output: { task_id: "old-job", task_status: "FAILED" } })),
    );
    const vendor = createWanRuntimeVendor({
      apiKey: "test-only-credential",
      workspaceId: "test-wan-workspace",
      fetchImpl,
    });
    expect(await vendor.reconcile!("wan2.2-i2v:old-job")).toMatchObject({
      state: "failed",
      vendorJobId: "wan2.2-i2v:old-job",
      retryDisposition: "replacement_allowed",
    });
  });
});
