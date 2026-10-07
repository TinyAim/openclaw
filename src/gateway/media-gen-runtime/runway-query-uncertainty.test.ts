import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { parseMediaGenRuntimeFrozenPlan, type MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  RUNWAY_GEN45_T2V_ADAPTER_REVISION,
  RUNWAY_GEN45_T2V_ENDPOINT_ID,
  RUNWAY_GEN45_T2V_MODEL_ID,
  RUNWAY_GEN45_T2V_PROFILE_DIGEST,
  RUNWAY_GEN45_T2V_PROFILE_ID,
  RUNWAY_GEN45_T2V_PROFILE_REVISION,
  RUNWAY_GEN45_T2V_ROUTE_ID,
} from "./runway-gen45-t2v-compiler.js";
import { createRunwayRuntimeVendor } from "./runway-vendor.js";
import type { MediaGenRuntimeBridge } from "./types.js";
const JOB_PREFIX = "runway-gen45-t2v:";
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
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
  const result: MediaGenRuntimeFrozenPlanV2 = {
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
  return `${JOB_PREFIX}${kind === "invalidReceipt" ? "" : "old-job"}`;
}
function response(kind: QueryCase): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  const status =
    kind === "missingOutput" || kind === "insecureOutput"
      ? "SUCCEEDED"
      : kind === "processing"
        ? "RUNNING"
        : kind.toUpperCase();
  return new Response(
    JSON.stringify({
      status,
      ...(kind === "insecureOutput" ? { output: ["http://example.test/video.mp4"] } : {}),
    }),
  );
}
async function retry(kind: QueryCase) {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ id: "replacement-job" }))
      : response(kind),
  );
  const vendor = createRunwayRuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: plan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "retry",
    taskId: "task-runway-retry",
    workspaceId: "workspace-runway-retry",
    correlationId: "correlation-runway-retry",
    presetId: "runway",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 6,
    resolution: "720p",
    frozenPlan: plan,
    runtimeJobId: receipt(kind),
  };
  expect(parseDispatch(dispatch)).not.toBeNull();
  return { result: await executor.dispatch(dispatch), fetchImpl, bridge };
}
describe("Runway existing provider attempt query uncertainty", () => {
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
      runtimeJobId: `${JOB_PREFIX}replacement-job`,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("processing reuses the exact original attempt", async () => {
    const { result, fetchImpl } = await retry("processing");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: `${JOB_PREFIX}old-job` });
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
          presetId: "runway",
          mode: "text2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createRunwayRuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
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

describe("Runway provider create outcome uncertainty", () => {
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
      vendors: [createRunwayRuntimeVendor({ apiKey: "test-only-credential", fetchImpl })],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-runway-create",
      workspaceId: "workspace-runway-create",
      correlationId: "correlation-runway-create",
      presetId: "runway",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 6,
      resolution: "720p",
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
