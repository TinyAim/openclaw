import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import {
  COGVIDEOX3_T2V_ADAPTER_REVISION,
  COGVIDEOX3_T2V_ENDPOINT_ID,
  COGVIDEOX3_T2V_MODEL_ID,
  COGVIDEOX3_T2V_PROFILE_DIGEST,
  COGVIDEOX3_T2V_PROFILE_ID,
  COGVIDEOX3_T2V_ROUTE_ID,
} from "./cogvideox3-text2video-compiler.js";
import { createCogVideoX3RuntimeVendor, COGVIDEOX3_T2V_JOB_PREFIX } from "./cogvideox3-vendor.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { parseMediaGenRuntimeFrozenPlan, type MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
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
    fps?: number;
    outputAudioPolicy?: "silent" | "native_generate";
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A red paper kite rises above a misty riverside town.";
  const native = (intentPath: string, providerField: string) => ({
    intentPath,
    sourceRef: "pack:R1",
    sourceRevision: "R1",
    required: true,
    support: "native" as const,
    providerField,
    reasonCode: "value_native",
    messageKey: "media.value_native",
  });
  const outputAudioPolicy = overrides.outputAudioPolicy ?? "silent";
  const result: MediaGenRuntimeFrozenPlanV2 = {
    schemaVersion: 2,
    previewId: "preview-cogvideox3",
    presetId: "cogvideox",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-cogvideox3",
        shotId: "shot-cogvideox3",
        shotVersion: "R1",
        promptPackId: "pack-cogvideox3",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy,
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Slow upward crane." },
      performance: {},
      look: {},
      references: [],
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
    generationScenario: "text_to_video",
    outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: COGVIDEOX3_T2V_ROUTE_ID,
      providerId: "zhipu_open_platform",
      modelId: COGVIDEOX3_T2V_MODEL_ID,
      endpointId: COGVIDEOX3_T2V_ENDPOINT_ID,
      region: "cn",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: COGVIDEOX3_T2V_PROFILE_ID,
      revision: 1,
      digest: COGVIDEOX3_T2V_PROFILE_DIGEST,
    },
    adapterRevision: COGVIDEOX3_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-cogvideox3", lastSeenAt: "2026-08-01T00:00:00Z" },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "output.audio"),
      {
        ...native("compiledPrompt", "prompt"),
        support: "prompt",
      },
      native("output.durationSec", "output.durationSec"),
      native("output.aspectRatio", "output.aspectRatio"),
      native("output.resolution", "output.resolution"),
      native("output.fps", "output.fps"),
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
  "mismatchedReceipt",
] as const;
type QueryCase = (typeof ambiguous)[number] | "failed" | "processing";
function receipt(kind: QueryCase) {
  return `${COGVIDEOX3_T2V_JOB_PREFIX}${kind === "invalidReceipt" ? "" : "old-job"}`;
}
function response(kind: QueryCase): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  const task_status =
    kind === "missingOutput" || kind === "insecureOutput"
      ? "SUCCESS"
      : kind === "failed" || kind === "mismatchedReceipt"
        ? "FAIL"
        : kind.toUpperCase();
  return new Response(
    JSON.stringify({
      task_status,
      id: kind === "mismatchedReceipt" ? "foreign-job" : "old-job",
      ...(kind === "insecureOutput"
        ? { video_result: [{ url: "http://example.test/video.mp4" }] }
        : {}),
    }),
  );
}
async function retry(kind: QueryCase, queryIdentity?: { id: unknown }) {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ id: "replacement-job" }));
    if (!queryIdentity) return response(kind);
    return new Response(JSON.stringify({ ...(await response(kind).json()), id: queryIdentity.id }));
  });
  const vendor = createCogVideoX3RuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: plan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "retry",
    taskId: "task-cogvideox-retry",
    workspaceId: "workspace-cogvideox-retry",
    correlationId: "correlation-cogvideox-retry",
    presetId: "cogvideox",
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
describe("CogVideoX3 existing provider attempt query uncertainty", () => {
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
      runtimeJobId: `${COGVIDEOX3_T2V_JOB_PREFIX}replacement-job`,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("processing reuses the exact original attempt", async () => {
    const { result, fetchImpl } = await retry("processing");
    expect(result).toMatchObject({
      status: "processing",
      runtimeJobId: `${COGVIDEOX3_T2V_JOB_PREFIX}old-job`,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it.each(["failed", "HTTP503", "missingOutput", "invalidReceipt", "mismatchedReceipt"] as const)(
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
          presetId: "cogvideox",
          mode: "text2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createCogVideoX3RuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
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

describe("CogVideoX3 explicit malformed query identity", () => {
  const malformed = [null, 17, {}, []].map((id) => ({ id }));
  function successResponse(identity: Record<string, unknown>) {
    return new Response(
      JSON.stringify({
        ...identity,
        task_status: "SUCCESS",
        video_result: [{ url: "https://example.test/output.mp4" }],
      }),
    );
  }
  it.each(malformed)(
    "explicit malformed id $id cannot supply successful output",
    async ({ id }) => {
      const vendor = createCogVideoX3RuntimeVendor({
        apiKey: "test-only-credential",
        fetchImpl: vi.fn(async () => successResponse({ id })),
      });
      expect(await vendor.reconcile!(`${COGVIDEOX3_T2V_JOB_PREFIX}old-job`)).toMatchObject({
        state: "failed",
        retryDisposition: "reconcile_only",
      });
    },
  );
  it.each(malformed)(
    "explicit malformed id $id cannot trigger replacement in the real executor",
    async ({ id }) => {
      const { result, fetchImpl } = await retry("failed", { id });
      expect
        .soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"))
        .toHaveLength(0);
      expect(result.status).toBe("failed");
    },
  );
  it.each(["omitted", "matching"] as const)(
    "%s id preserves compatible completed receipts",
    async (identity) => {
      const vendor = createCogVideoX3RuntimeVendor({
        apiKey: "test-only-credential",
        fetchImpl: vi.fn(async () =>
          successResponse(identity === "matching" ? { id: "old-job" } : {}),
        ),
      });
      expect(await vendor.reconcile!(`${COGVIDEOX3_T2V_JOB_PREFIX}old-job`)).toMatchObject({
        state: "succeeded",
        vendorJobId: `${COGVIDEOX3_T2V_JOB_PREFIX}old-job`,
      });
    },
  );
  it("empty explicit id stays fail closed", async () => {
    const vendor = createCogVideoX3RuntimeVendor({
      apiKey: "test-only-credential",
      fetchImpl: vi.fn(async () => successResponse({ id: "" })),
    });
    expect(await vendor.reconcile!(`${COGVIDEOX3_T2V_JOB_PREFIX}old-job`)).toMatchObject({
      state: "failed",
      retryDisposition: "reconcile_only",
    });
  });
  it("compares the provider id after decoding the I2V route prefix", async () => {
    const vendor = createCogVideoX3RuntimeVendor({
      apiKey: "test-only-credential",
      fetchImpl: vi.fn(async () => successResponse({ id: "old-job" })),
    });
    expect(await vendor.reconcile!("cogvideox3-i2v:old-job")).toMatchObject({
      state: "succeeded",
      vendorJobId: "cogvideox3-i2v:old-job",
    });
  });
});

describe("CogVideoX3 provider create outcome uncertainty", () => {
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
      vendors: [createCogVideoX3RuntimeVendor({ apiKey: "test-only-credential", fetchImpl })],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-cogvideox-create",
      workspaceId: "workspace-cogvideox-create",
      correlationId: "correlation-cogvideox-create",
      presetId: "cogvideox",
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
  it("preserves explicit terminal FAIL in a successful HTTP create receipt", async () => {
    expect(await submit(200, JSON.stringify({ task_status: "FAIL" }))).toMatchObject({
      status: "failed",
      failureReason: "vendor_rejected",
    });
  });
});
