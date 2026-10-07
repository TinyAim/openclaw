import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { parseMediaGenRuntimeFrozenPlan, type MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge } from "./types.js";
import {
  VIDU_Q1_T2V_ADAPTER_REVISION,
  VIDU_Q1_T2V_ENDPOINT_ID,
  VIDU_Q1_T2V_MODEL_ID,
  VIDU_Q1_T2V_PROFILE_DIGEST,
  VIDU_Q1_T2V_PROFILE_ID,
  VIDU_Q1_T2V_PROFILE_REVISION,
  VIDU_Q1_T2V_ROUTE_ID,
} from "./vidu-q1-text2video-compiler.js";
import { VIDU_Q1_T2V_JOB_PREFIX } from "./vidu-q1-text2video-vendor.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";
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
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    fps?: number;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A paper lantern drifts above a quiet canal at blue hour.";
  const result: MediaGenRuntimeFrozenPlanV2 = {
    schemaVersion: 2,
    previewId: "preview-vidu-q1-t2v",
    presetId: "vidu",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-vidu-t2v",
        shotId: "shot-vidu-t2v",
        shotVersion: "R1",
        promptPackId: "pack-vidu-t2v",
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
        visualPrompt: "A paper lantern above a quiet canal.",
        reservedForLater: [],
      },
      camera: { cameraPrompt: "Slow forward dolly." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "1080p",
        fps: overrides.fps ?? 24,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: VIDU_Q1_T2V_ROUTE_ID,
      providerId: "vidu_enterprise",
      modelId: VIDU_Q1_T2V_MODEL_ID,
      endpointId: VIDU_Q1_T2V_ENDPOINT_ID,
      region: "unknown",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: VIDU_Q1_T2V_PROFILE_ID,
      revision: VIDU_Q1_T2V_PROFILE_REVISION,
      digest: VIDU_Q1_T2V_PROFILE_DIGEST,
    },
    adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-vidu",
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
      ...["durationSec", "aspectRatio", "resolution", "fps"].map((field) => ({
        intentPath: `output.${field}`,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native" as const,
        providerField: `output.${field}`,
        reasonCode: "output_native",
        messageKey: "media.output_native",
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
  "unknownState",
  "missingOutput",
  "insecureOutput",
  "invalidReceipt",
] as const;
type QueryCase = (typeof ambiguous)[number] | "failed" | "processing";
function receipt(kind: QueryCase) {
  return `${VIDU_Q1_T2V_JOB_PREFIX}${kind === "invalidReceipt" ? "" : "old-job"}`;
}
function response(kind: QueryCase): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  return new Response(
    JSON.stringify({
      state: kind === "missingOutput" || kind === "insecureOutput" ? "success" : kind,
      ...(kind === "insecureOutput"
        ? { creations: [{ url: "http://example.test/video.mp4" }] }
        : {}),
    }),
  );
}
async function retry(kind: QueryCase) {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ task_id: "replacement-job" }))
      : response(kind),
  );
  const vendor = createViduRuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: plan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "retry",
    taskId: "task-vidu-retry",
    workspaceId: "workspace-vidu-retry",
    correlationId: "correlation-vidu-retry",
    presetId: "vidu",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 5,
    resolution: "1080p",
    frozenPlan: plan,
    runtimeJobId: receipt(kind),
  };
  expect(parseDispatch(dispatch)).not.toBeNull();
  return { result: await executor.dispatch(dispatch), fetchImpl, bridge };
}
describe("Vidu existing provider attempt query uncertainty", () => {
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
      runtimeJobId: `${VIDU_Q1_T2V_JOB_PREFIX}replacement-job`,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("processing reuses the exact original attempt", async () => {
    const { result, fetchImpl } = await retry("processing");
    expect(result).toMatchObject({
      status: "processing",
      runtimeJobId: `${VIDU_Q1_T2V_JOB_PREFIX}old-job`,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it.each(["failed", "HTTP503", "missingOutput", "invalidReceipt"] as const)(
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
          presetId: "vidu",
          mode: "text2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createViduRuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
          vendorJobId: receipt(kind),
        },
        forget,
      });
      expect(result).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: { state: kind === "failed" ? "confirmed" : "failed" },
      });
      expect(forget).toHaveBeenCalledTimes(kind === "failed" ? 1 : 0);
      expect(fetchImpl).toHaveBeenCalledTimes(kind === "invalidReceipt" ? 0 : 1);
    },
  );
});

describe("Vidu provider create outcome uncertainty", () => {
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
      vendors: [createViduRuntimeVendor({ apiKey: "test-only-credential", fetchImpl })],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-vidu-create",
      workspaceId: "workspace-vidu-create",
      correlationId: "correlation-vidu-create",
      presetId: "vidu",
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

describe.each(["text2video", "image2video"] as const)(
  "Vidu retained legacy %s direct Adapter create uncertainty",
  (mode) => {
    async function submit(status: number) {
      const fetchImpl = vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status }),
      );
      const vendor = createViduRuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
      const result = await vendor.submit({
        taskId: "legacy-task",
        presetId: "vidu",
        mode,
        prompt: "A lantern beside a canal.",
        ...(mode === "image2video"
          ? { source: { bytes: Buffer.from([7]), mimeType: "image/png" as const } }
          : {}),
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        `https://api.vidu.com/ent/v2/${mode === "image2video" ? "img2video" : "text2video"}`,
      );
      return result;
    }
    it.each([408, 500, 502, 503, 504])("HTTP%s retains unknown create outcome", async (status) => {
      expect(await submit(status)).toMatchObject({
        state: "submission_unknown",
        providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
    });
    it.each([
      [400, "vendor_rejected"],
      [401, "auth"],
      [403, "auth"],
      [429, "quota"],
    ] as const)("HTTP%s retains definite rejection %s", async (status, reason) => {
      expect(await submit(status)).toMatchObject({ state: "failed", reason });
    });
  },
);
