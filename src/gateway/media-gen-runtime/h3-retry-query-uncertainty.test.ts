import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenRuntimeFrozenPlanV2,
} from "./frozen-plan.js";
import {
  H3_BASE_SGLANG_SCHEMA_REVISION,
  createH3BaseSglangRuntimeVendor,
} from "./h3-base-sglang-vendor.js";
import {
  HAILUO_H3_ADAPTER_REVISION,
  HAILUO_H3_PROFILE_DIGEST,
  HAILUO_H3_ROUTE_ID,
} from "./hailuo-h3-compiler.js";
import { createHailuoH3RuntimeVendor } from "./hailuo-h3-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeFetch } from "./types.js";

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function reference(input: {
  role: "subject" | "voice" | "motion";
  ordinal?: number;
  bytes: Buffer;
}): MediaGenerationIntentReference {
  const mediaClass =
    input.role === "subject"
      ? ("image" as const)
      : input.role === "voice"
        ? ("audio" as const)
        : ("video" as const);
  const ordinal = input.ordinal ?? 0;
  return {
    role: input.role,
    ordinal,
    required: true,
    mediaClass,
    source: { kind: "artifact", artifactId: `artifact-${input.role}-${ordinal}` },
    assetRefId: `asset-${input.role}-${ordinal}`,
    authorityRef: `artifact:${input.role}-${ordinal}`,
    authorityVerified: true,
    mimeType:
      mediaClass === "image" ? "image/png" : mediaClass === "audio" ? "audio/mpeg" : "video/mp4",
    ...(mediaClass === "image" ? {} : { durationSec: 4 }),
    sourceDigest: `sha256:${sha(input.bytes)}`,
  };
}

function frozenPlan(refs: MediaGenerationIntentReference[]): MediaGenRuntimeFrozenPlanV2 {
  const prompt = "Same traveler crosses a windy station, pauses, then speaks softly.";
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project-hailuo",
      shotId: "shot-hailuo",
      shotVersion: "R1",
      promptPackId: "pack-hailuo",
      promptPackVersion: 1,
      promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: refs.map((ref) => ref.sourceDigest!),
    },
    generationScenario: "multimodal_reference_to_video" as const,
    outputAudioPolicy: "reference_conditioned" as const,
    legacyMode: "image2video" as const,
    compiledPrompt: prompt,
    narrative: { visualPrompt: prompt, reservedForLater: [] },
    camera: { cameraPrompt: "Slow tracking shot." },
    performance: { actorDirection: "Pause, then speak." },
    look: {},
    references: refs,
    output: {
      durationSec: 8,
      aspectRatio: "9:16",
      resolution: "2K",
      shotCount: 1,
    },
    policy: { authority: "server" as const },
  };
  return {
    schemaVersion: 2,
    previewId: "preview-hailuo-h3",
    presetId: "hailuo",
    mode: "image2video",
    generationIntent: intent,
    generationIntentDigest: `intent:sha256:${createHash("sha256").update(stableJson(intent)).digest("hex")}`,
    generationScenario: intent.generationScenario,
    outputAudioPolicy: intent.outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: HAILUO_H3_ROUTE_ID,
      providerId: "minimax",
      modelId: "MiniMax-H3",
      endpointId: "minimax.v2.video_generation",
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: "hailuo.openclaw-runtime.h3.multimodal_reference.v2",
      revision: 2,
      digest: HAILUO_H3_PROFILE_DIGEST,
    },
    adapterRevision: HAILUO_H3_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-hailuo",
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
      ...refs.map((ref) => ({
        intentPath: `references.${ref.role}.${ref.ordinal}`,
        sourceRef: `asset:${ref.assetRefId}`,
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerSlot: `references.${ref.role}`,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
      ...["output.durationSec", "output.aspectRatio", "output.resolution"].map((intentPath) => ({
        intentPath,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: false,
        support: "native" as const,
        providerField: intentPath,
        reasonCode: "output_native",
        messageKey: "media.output_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

const ambiguous = [
  "HTTP503",
  "HTTP401",
  "HTTP429",
  "invalidJSON",
  "nullJSON",
  "wrongJob",
  "wrongModel",
  "unknownStatus",
  "unretrievableCompletion",
] as const;
type QueryCase = (typeof ambiguous)[number] | "terminalFailed" | "terminalExpired";
type Adapter = "Hailuo" | "H3Base";

function queryResponse(adapter: Adapter, kind: QueryCase): Response {
  if (kind.startsWith("HTTP")) return new Response("{}", { status: Number(kind.slice(4)) });
  if (kind === "invalidJSON") return new Response("{");
  if (kind === "nullJSON") return new Response("null");
  const receipt = {
    id: kind === "wrongJob" ? "foreign-job" : "old-job",
    model:
      kind === "wrongModel"
        ? "foreign-model"
        : adapter === "Hailuo"
          ? "MiniMax-H3"
          : "MiniMaxAI/MiniMax-H3",
    status:
      kind === "terminalFailed"
        ? "failed"
        : kind === "terminalExpired"
          ? "expired"
          : kind === "unretrievableCompletion"
            ? adapter === "Hailuo"
              ? "succeeded"
              : "completed"
            : "unrecognized-status",
    ...(adapter === "H3Base" && kind === "unretrievableCompletion"
      ? { url: "https://example.test/egressing-output" }
      : {}),
  };
  return new Response(JSON.stringify(adapter === "Hailuo" ? { task: receipt } : receipt));
}

function createVendor(adapter: Adapter, fetchImpl: MediaGenRuntimeFetch) {
  return adapter === "Hailuo"
    ? createHailuoH3RuntimeVendor({ apiKey: "test-only-credential", fetchImpl })
    : createH3BaseSglangRuntimeVendor({
        variant: "fl2va",
        baseUrl: "http://127.0.0.1:30000",
        servingEngineVersion: H3_BASE_SGLANG_SCHEMA_REVISION,
        checkpointRevision: "test-checkpoint",
        checkpointDigest: `sha256:${"9".repeat(64)}`,
        status: "ready",
        maxConcurrentJobs: 1,
        profilesByScenario: {},
        stagingDir: "/tmp/h3-test-query-only",
        fetchImpl,
      });
}

describe.each(["Hailuo", "H3Base"] as const)("%s existing-job query evidence", (adapter) => {
  it.each(ambiguous)("%s cannot authorize a replacement", async (kind) => {
    const fetchImpl = vi.fn(async () => queryResponse(adapter, kind));
    const vendor = createVendor(adapter, fetchImpl);
    const result = await vendor.reconcile!("old-job");
    expect(result).toMatchObject({
      state: "failed",
      vendorJobId: "old-job",
      retryDisposition: "reconcile_only",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an exact explicit terminal failed receipt authorizes replacement", async () => {
    const vendor = createVendor(
      adapter,
      vi.fn(async () => queryResponse(adapter, "terminalFailed")),
    );
    expect(await vendor.reconcile!("old-job")).toMatchObject({
      state: "failed",
      vendorJobId: "old-job",
      retryDisposition: "replacement_allowed",
    });
  });
});

describe("Hailuo real executor retry does not recreate an unreadable old job", () => {
  const bytes = Buffer.from("test-subject-image");
  const voiceBytes = Buffer.from("test-reference-voice");

  async function retry(kind: QueryCase) {
    const plan = frozenPlan([
      reference({ role: "subject", bytes }),
      reference({ role: "voice", bytes: voiceBytes }),
    ]);
    expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ task_id: "replacement-job" }))
        : queryResponse("Hailuo", kind),
    );
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: plan.runtimeRef.runtimeId,
      register: vi.fn(),
      resolveArtifactReference: vi.fn(async ({ role }) =>
        role === "voice"
          ? { bytes: voiceBytes, mimeType: "audio/mpeg", sha256: sha(voiceBytes) }
          : { bytes, mimeType: "image/png", sha256: sha(bytes) },
      ),
      handoffArtifact: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createVendor("Hailuo", fetchImpl)],
    });
    const dispatch: MediaGenRuntimeDispatch = {
      op: "retry",
      taskId: "retry-task",
      workspaceId: "retry-workspace",
      correlationId: "retry-correlation",
      presetId: "hailuo",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 8,
      resolution: "2K",
      frozenPlan: plan,
      runtimeJobId: "old-job",
      references: plan.generationIntent.references.map((ref) => {
        if (ref.source.kind !== "artifact") throw new Error("fixture must use an Artifact source");
        return {
          kind: "artifact" as const,
          artifactId: ref.source.artifactId,
          role: ref.role,
          ordinal: ref.ordinal,
        };
      }),
    };
    const result = await executor.dispatch(dispatch);
    return { result, fetchImpl, bridge };
  }

  it.each(ambiguous)("%s leaves the original attempt without a provider create", async (kind) => {
    const { result, fetchImpl, bridge } = await retry(kind);
    expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect.soft(result.status).toBe("failed");
    expect.soft(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });

  it.each(["terminalFailed", "terminalExpired"] as const)(
    "%s preserves the confirmed-failure replacement path",
    async (kind) => {
      const { result, fetchImpl, bridge } = await retry(kind);
      expect(result).toMatchObject({ status: "processing", runtimeJobId: "replacement-job" });
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(bridge.resolveArtifactReference).toHaveBeenCalledTimes(2);
      expect(bridge.handoffArtifact).not.toHaveBeenCalled();
    },
  );
});

describe.each(["Hailuo", "H3Base"] as const)(
  "%s exact stop evidence consumes the same query disposition",
  (adapter) => {
    it.each(["terminalFailed", "HTTP503", "unknownStatus"] as const)(
      "%s confirms only exact terminal failure",
      async (kind) => {
        const fetchImpl = vi.fn(async () => queryResponse(adapter, kind));
        const forget = vi.fn();
        const result = await cancelMediaGenRuntimeJob({
          dispatch: {
            op: "cancel",
            taskId: "stop-task",
            workspaceId: "stop-workspace",
            correlationId: "stop-correlation",
            presetId: "hailuo",
            mode: "image2video",
            runtimeJobId: "old-job",
          },
          tracked: { vendor: createVendor(adapter, fetchImpl), vendorJobId: "old-job" },
          forget,
        });
        expect(result).toMatchObject({
          status: "canceled",
          runtimeJobId: "old-job",
          runtimeStopOutcome: { state: kind === "terminalFailed" ? "confirmed" : "failed" },
        });
        expect(forget).toHaveBeenCalledTimes(kind === "terminalFailed" ? 1 : 0);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );
  },
);

describe("Hailuo H3 provider create outcome uncertainty", () => {
  async function submit(status: number) {
    const bytes = Buffer.from("test-subject-image");
    const voiceBytes = Buffer.from("test-reference-voice");
    const plan = frozenPlan([
      reference({ role: "subject", bytes }),
      reference({ role: "voice", bytes: voiceBytes }),
    ]);
    expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status }),
    );
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: plan.runtimeRef.runtimeId,
      register: vi.fn(),
      resolveArtifactReference: vi.fn(async ({ role }) =>
        role === "voice"
          ? { bytes: voiceBytes, mimeType: "audio/mpeg", sha256: sha(voiceBytes) }
          : { bytes, mimeType: "image/png", sha256: sha(bytes) },
      ),
      handoffArtifact: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createHailuoH3RuntimeVendor({ apiKey: "test-only-credential", fetchImpl })],
    });
    const result = await executor.dispatch({
      op: "submit",
      taskId: "task-hailuo-create",
      workspaceId: "workspace-hailuo-create",
      correlationId: "correlation-hailuo-create",
      presetId: "hailuo",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 8,
      resolution: "2K",
      frozenPlan: plan,
      references: plan.generationIntent.references.map((ref) => {
        if (ref.source.kind !== "artifact") throw new Error("fixture must use an Artifact source");
        return {
          kind: "artifact" as const,
          artifactId: ref.source.artifactId,
          role: ref.role,
          ordinal: ref.ordinal,
        };
      }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(bridge.resolveArtifactReference).toHaveBeenCalledTimes(2);
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
    return result;
  }
  it.each([408, 500, 502, 503, 504])("HTTP%s has an unknown create outcome", async (status) => {
    expect(await submit(status)).toMatchObject({
      status: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      providerObservation: { operation: "submit", outcome: "submission_unknown" },
    });
  });
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
