import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import { parseMediaGenRuntimeFrozenPlan, type MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge } from "./types.js";
import { createVeoRuntimeVendor } from "./veo-vendor.js";
import {
  VEO31_T2V_ADAPTER_REVISION,
  VEO31_T2V_PROFILE_DIGEST,
  VEO31_T2V_ROUTE_ID,
} from "./veo3-1-t2v-compiler.js";
const projectId = "wisclaw-veo-test";
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
  const prompt = "A paper boat crosses a rain-filled street at dusk.";
  const result: MediaGenRuntimeFrozenPlanV2 = {
    schemaVersion: 2,
    previewId: "preview-veo",
    presetId: "veo",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-veo",
        shotId: "shot-veo",
        shotVersion: "R1",
        promptPackId: "pack-veo",
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
      camera: { cameraPrompt: "Low tracking shot beside the boat." },
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 6,
        aspectRatio: overrides.aspectRatio ?? "9:16",
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
      routeId: VEO31_T2V_ROUTE_ID,
      providerId: "google_vertex_ai",
      modelId: "veo-3.1-generate-001",
      endpointId: "aiplatform.v1.predictLongRunning",
      region: "us-central1",
      accountTier: "adc",
    },
    capabilityProfileRef: {
      profileId: "veo.openclaw-runtime.veo3_1_generate_001.text2video.v2",
      revision: 2,
      digest: VEO31_T2V_PROFILE_DIGEST,
    },
    adapterRevision: VEO31_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-veo", lastSeenAt: "2026-07-31T00:00:00.000Z" },
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
      ...["output.durationSec", "output.aspectRatio", "output.resolution", "output.fps"].map(
        (intentPath) => ({
          intentPath,
          sourceRef: "pack:R1",
          sourceRevision: "R1",
          required: false,
          support: "native" as const,
          providerField: intentPath,
          reasonCode: "output_value_native",
          messageKey: "media.output_value_native",
        }),
      ),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
  result.generationIntentDigest = `intent:sha256:${createHash("sha256").update(stableJson(result.generationIntent)).digest("hex")}`;
  return result;
}

const uncertain = [
  "HTTP401",
  "HTTP429",
  "HTTP503",
  "invalidJSON",
  "nullJSON",
  "unknownState",
  "missingOutput",
  "invalidVideo",
  "gcsOutput",
  "invalidInline",
  "invalidReceipt",
  "credentialUnavailable",
] as const;
type QueryCase = (typeof uncertain)[number] | "terminalError" | "running";
function receipt(kind: QueryCase): string {
  return kind === "invalidReceipt" ? "unsupported:old-job" : "old-job";
}
function response(kind: QueryCase): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  if (kind === "terminalError")
    return new Response(
      JSON.stringify({
        done: true,
        error: { code: 13, status: "INTERNAL", message: "Generation failed." },
      }),
    );
  if (kind === "running") return new Response(JSON.stringify({ done: false }));
  if (kind === "unknownState") return new Response(JSON.stringify({ done: "unknown" }));
  return new Response(
    JSON.stringify({
      done: true,
      response: {
        ...(kind === "invalidVideo" ? { videos: [null] } : {}),
        ...(kind === "gcsOutput"
          ? { videos: [{ mimeType: "video/mp4", gcsUri: "gs://example.test/video.mp4" }] }
          : {}),
        ...(kind === "invalidInline"
          ? { videos: [{ mimeType: "video/mp4", bytesBase64Encoded: "invalid-base64" }] }
          : {}),
      },
    }),
  );
}
async function retry(kind: QueryCase, queryName?: string) {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith(":predictLongRunning"))
      return new Response(
        JSON.stringify({
          name: `projects/${projectId}/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/replacement-job`,
        }),
      );
    const queried = response(kind);
    if (queryName === undefined) return queried;
    const body = (await queried.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...body, name: queryName }));
  });
  const accessTokenProvider = vi.fn(async () => "test-only-token");
  if (kind === "credentialUnavailable")
    accessTokenProvider.mockRejectedValueOnce(new Error("test credential unavailable"));
  const vendor = createVeoRuntimeVendor({ projectId, accessTokenProvider, fetchImpl });
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: plan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "retry",
    taskId: "task-veo-retry",
    workspaceId: "workspace-veo-retry",
    correlationId: "correlation-veo-retry",
    presetId: "veo",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 6,
    resolution: "1080p",
    frozenPlan: plan,
    runtimeJobId: receipt(kind),
  };
  expect(parseDispatch(dispatch)).not.toBeNull();
  return { result: await executor.dispatch(dispatch), fetchImpl, bridge, accessTokenProvider };
}
describe("Veo existing provider attempt query uncertainty", () => {
  it.each(uncertain)("%s cannot create a replacement provider operation", async (kind) => {
    const { result, fetchImpl, bridge } = await retry(kind);
    expect
      .soft(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(":predictLongRunning")))
      .toHaveLength(0);
    expect.soft(result.status).toBe("failed");
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });
  it("retains the existing completed error replacement path", async () => {
    const { result, fetchImpl } = await retry("terminalError");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: "replacement-job" });
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(":predictLongRunning")),
    ).toHaveLength(1);
  });
  it("running reuses the original operation without create", async () => {
    const { result, fetchImpl } = await retry("running");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: "old-job" });
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(":predictLongRunning")),
    ).toHaveLength(0);
  });
  it.each(["HTTP503", "missingOutput", "invalidReceipt"] as const)(
    "%s does not claim a confirmed stop",
    async (kind) => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL) => response(kind));
      const forget = vi.fn();
      const result = await cancelMediaGenRuntimeJob({
        dispatch: {
          op: "cancel",
          taskId: "stop-task",
          workspaceId: "stop-workspace",
          correlationId: "stop-correlation",
          presetId: "veo",
          mode: "text2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createVeoRuntimeVendor({
            projectId,
            accessTokenProvider: async () => "test-only-token",
            fetchImpl,
          }),
          vendorJobId: receipt(kind),
        },
        forget,
      });
      expect(result).toMatchObject({ status: "canceled", runtimeStopOutcome: { state: "failed" } });
      expect(forget).not.toHaveBeenCalled();
      expect(
        fetchImpl.mock.calls.some(([url]) => String(url).endsWith(":predictLongRunning")),
      ).toBe(false);
    },
  );
});

describe("Veo provider create outcome uncertainty", () => {
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
        createVeoRuntimeVendor({
          projectId,
          accessTokenProvider: async () => "test-only-token",
          fetchImpl,
        }),
      ],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-veo-create",
      workspaceId: "workspace-veo-create",
      correlationId: "correlation-veo-create",
      presetId: "veo",
      mode: "text2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 6,
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

const expectedOperationName = `projects/${projectId}/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/old-job`;
function operationReceipt(
  status: "running" | "completed" | "failed" | "canceled" | "filtered",
  name?: unknown,
): Response {
  return new Response(
    JSON.stringify({
      ...(name === undefined ? {} : { name }),
      done: status !== "running",
      ...(status === "failed"
        ? { error: { code: 13, status: "INTERNAL", message: "Generation failed." } }
        : {}),
      ...(status === "canceled" ? { error: { code: 1, status: "CANCELLED" } } : {}),
      ...(status === "completed"
        ? {
            response: {
              videos: [
                {
                  mimeType: "video/mp4",
                  bytesBase64Encoded: Buffer.from("test-video").toString("base64"),
                },
              ],
            },
          }
        : {}),
      ...(status === "filtered" ? { response: { raiMediaFilteredCount: 1 } } : {}),
    }),
  );
}
describe("Veo explicit operation resource identity binding", () => {
  it.each(["running", "completed", "failed", "canceled", "filtered"] as const)(
    "foreign %s cannot supply current operation evidence",
    async (status) => {
      const fetchImpl = vi.fn(async () =>
        operationReceipt(status, expectedOperationName.replace("old-job", "foreign-job")),
      );
      const vendor = createVeoRuntimeVendor({
        projectId,
        accessTokenProvider: async () => "test-only-token",
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
  it.each([
    expectedOperationName.replace(projectId, "foreign-project"),
    expectedOperationName.replace("us-central1", "europe-west1"),
    expectedOperationName.replace("veo-3.1-generate-001", "foreign-model"),
    null,
    17,
    "",
  ])("explicit mismatched resource %s cannot supply running evidence", async (name) => {
    const vendor = createVeoRuntimeVendor({
      projectId,
      accessTokenProvider: async () => "test-only-token",
      fetchImpl: vi.fn(async () => operationReceipt("running", name)),
    });
    expect(await vendor.reconcile!("old-job")).toMatchObject({
      state: "failed",
      retryDisposition: "reconcile_only",
    });
  });
  it("foreign failed operation cannot trigger replacement in the real executor", async () => {
    const { result, fetchImpl } = await retry(
      "terminalError",
      expectedOperationName.replace("old-job", "foreign-job"),
    );
    expect
      .soft(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(":predictLongRunning")))
      .toHaveLength(0);
    expect(result.status).toBe("failed");
  });
  it("foreign canceled operation cannot confirm stopping the original attempt", async () => {
    const fetchImpl = vi.fn(async () =>
      operationReceipt("canceled", expectedOperationName.replace("old-job", "foreign-job")),
    );
    const forget = vi.fn();
    const result = await cancelMediaGenRuntimeJob({
      dispatch: {
        op: "cancel",
        taskId: "stop-task",
        workspaceId: "stop-workspace",
        correlationId: "stop-correlation",
        presetId: "veo",
        mode: "text2video",
        runtimeJobId: "old-job",
      },
      tracked: {
        vendor: createVeoRuntimeVendor({
          projectId,
          accessTokenProvider: async () => "test-only-token",
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
    "%s name preserves the existing running receipt",
    async (identity) => {
      const vendor = createVeoRuntimeVendor({
        projectId,
        accessTokenProvider: async () => "test-only-token",
        fetchImpl: vi.fn(async () =>
          operationReceipt("running", identity === "matching" ? expectedOperationName : undefined),
        ),
      });
      expect(await vendor.reconcile!("old-job")).toMatchObject({
        state: "processing",
        vendorJobId: "old-job",
      });
    },
  );
});
