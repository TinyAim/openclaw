import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { parseMediaGenRuntimeFrozenPlan, type MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  LUMA_RAY2_ADAPTER_REVISION,
  LUMA_RAY2_PROFILE_DIGEST,
  LUMA_RAY2_PROFILE_ID,
  LUMA_RAY2_PROFILE_REVISION,
  LUMA_RAY2_ROUTE_ID,
} from "./luma-ray2-compiler.js";
import { createLumaRuntimeVendor, LUMA_RAY2_I2V_JOB_PREFIX } from "./luma-vendor.js";
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
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    profile?: { profileId: string; revision: number; digest: string };
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "A lighthouse beam sweeps across a stormy night sea, slow dolly forward.";
  const result: MediaGenRuntimeFrozenPlanV2 = {
    schemaVersion: 2,
    previewId: "preview-luma",
    presetId: "luma",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-luma",
        shotId: "shot-luma",
        shotVersion: "R1",
        promptPackId: "pack-luma",
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
      camera: { cameraPrompt: "Slow dolly forward." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "9:16",
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
      routeId: LUMA_RAY2_ROUTE_ID,
      providerId: "luma_dream_machine",
      modelId: "ray-2",
      endpointId: "luma.dream_machine.v1.generations.video",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: overrides.profile?.profileId ?? LUMA_RAY2_PROFILE_ID,
      revision: overrides.profile?.revision ?? LUMA_RAY2_PROFILE_REVISION,
      digest: overrides.profile?.digest ?? LUMA_RAY2_PROFILE_DIGEST,
    },
    adapterRevision: LUMA_RAY2_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-luma",
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
        reasonCode: "camera_prompt_only",
        messageKey: "media.camera_prompt_only",
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
type QueryCase = (typeof ambiguous)[number] | "failed" | "dreaming";
function receipt(kind: QueryCase): string {
  return kind === "invalidReceipt" ? LUMA_RAY2_I2V_JOB_PREFIX : "old-job";
}
function response(kind: QueryCase, jobId: unknown = "old-job"): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  return new Response(
    JSON.stringify({
      id: jobId,
      state: kind === "missingOutput" || kind === "insecureOutput" ? "completed" : kind,
      ...(kind === "insecureOutput" ? { assets: { video: "http://example.test/video.mp4" } } : {}),
    }),
  );
}
async function retry(kind: QueryCase, jobId: unknown = "old-job") {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ id: "replacement-job", state: "queued" }))
      : response(kind, jobId),
  );
  const vendor = createLumaRuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: plan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "retry",
    taskId: "task-luma-retry",
    workspaceId: "workspace-luma-retry",
    correlationId: "correlation-luma-retry",
    presetId: "luma",
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
describe("Luma existing provider attempt query uncertainty", () => {
  it.each(ambiguous)("%s does not create another provider job", async (kind) => {
    const { result, fetchImpl, bridge } = await retry(kind);
    expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect.soft(result.status).toBe("failed");
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });
  it("explicit failed preserves the confirmed terminal replacement path", async () => {
    const { result, fetchImpl } = await retry("failed");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: "replacement-job" });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("dreaming reuses the exact original attempt", async () => {
    const { result, fetchImpl } = await retry("dreaming");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: "old-job" });
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
          presetId: "luma",
          mode: "text2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createLumaRuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
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

describe("Luma provider create outcome uncertainty", () => {
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
      vendors: [createLumaRuntimeVendor({ apiKey: "test-only-credential", fetchImpl })],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-luma-create",
      workspaceId: "workspace-luma-create",
      correlationId: "correlation-luma-create",
      presetId: "luma",
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

describe("Luma explicit provider generation identity binding", () => {
  it.each(["queued", "dreaming", "completed", "failed"] as const)(
    "foreign %s cannot supply current attempt evidence",
    async (state) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "foreign-job",
              state,
              assets: { video: "https://example.test/output.mp4" },
            }),
          ),
      );
      const vendor = createLumaRuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
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
      const vendor = createLumaRuntimeVendor({
        apiKey: "test-only-credential",
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id, state: "failed" }))),
      });
      expect(await vendor.reconcile!("old-job")).toMatchObject({
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
  it("foreign failed evidence cannot confirm stopping the original attempt", async () => {
    const fetchImpl = vi.fn(async () => response("failed", "foreign-job"));
    const forget = vi.fn();
    const result = await cancelMediaGenRuntimeJob({
      dispatch: {
        op: "cancel",
        taskId: "stop-task",
        workspaceId: "stop-workspace",
        correlationId: "stop-correlation",
        presetId: "luma",
        mode: "text2video",
        runtimeJobId: "old-job",
      },
      tracked: {
        vendor: createLumaRuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
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
              ...(identity === "matching" ? { id: "old-job" } : {}),
              state: "failed",
            }),
          ),
      );
      const vendor = createLumaRuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
      expect(await vendor.reconcile!("old-job")).toMatchObject({
        state: "failed",
        vendorJobId: "old-job",
        retryDisposition: "replacement_allowed",
      });
    },
  );
  it("compares the provider id after decoding the frozen I2V prefix", async () => {
    const vendor = createLumaRuntimeVendor({
      apiKey: "test-only-credential",
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ id: "old-job", state: "failed" })),
      ),
    });
    expect(await vendor.reconcile!(`${LUMA_RAY2_I2V_JOB_PREFIX}old-job`)).toMatchObject({
      state: "failed",
      vendorJobId: `${LUMA_RAY2_I2V_JOB_PREFIX}old-job`,
      retryDisposition: "replacement_allowed",
    });
  });
});
