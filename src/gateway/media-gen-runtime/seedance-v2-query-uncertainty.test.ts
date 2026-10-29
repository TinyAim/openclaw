import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenerationScenario,
  type MediaGenRuntimeFrozenPlanV2,
  type MediaOutputAudioPolicy,
} from "./frozen-plan.js";
import { SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4 } from "./seedance-v2-compiler.js";
import { createSeedanceV2RuntimeVendor } from "./seedance-vendor-v2.js";
import type { MediaGenRuntimeBridge } from "./types.js";

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  role: MediaGenerationIntentReference["role"];
  ordinal: number;
  mediaClass: MediaGenerationIntentReference["mediaClass"];
  kind?: "artifact" | "runtime_local";
  digest?: string;
}): MediaGenerationIntentReference {
  return {
    role: input.role,
    ordinal: input.ordinal,
    required: true,
    mediaClass: input.mediaClass,
    source:
      input.kind === "runtime_local"
        ? { kind: "runtime_local", runtimeLocalRef: `local-${input.role}-${input.ordinal}` }
        : { kind: "artifact", artifactId: `artifact-${input.role}-${input.ordinal}` },
    authorityVerified: true,
    mimeType:
      input.mediaClass === "image"
        ? "image/png"
        : input.mediaClass === "audio"
          ? "audio/wav"
          : "video/mp4",
    sourceDigest: `sha256:${input.digest ?? sha(`${input.role}-${input.ordinal}`)}`,
  };
}

function plan(input: {
  references: MediaGenerationIntentReference[];
  scenario?: MediaGenerationScenario;
  audio?: MediaOutputAudioPolicy;
}): MediaGenRuntimeFrozenPlanV2 {
  const generationScenario = input.scenario ?? "multimodal_reference_to_video";
  const outputAudioPolicy = input.audio ?? "reference_conditioned";
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project-short-drama",
      shotId: "shot-2-of-3",
      shotVersion: "R4",
      promptPackId: "prompt-pack-9x16",
      promptPackVersion: 3,
      promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: input.references.map((item) => item.sourceDigest!),
    },
    generationScenario,
    outputAudioPolicy,
    legacyMode: "image2video" as const,
    compiledPrompt: "9:16 short drama, shot 2, preserve the actor and screen direction",
    narrative: {
      visualPrompt: "actor crosses frame left to right",
      reservedForLater: [],
    },
    camera: { cameraPrompt: "medium tracking shot" },
    performance: { actorDirection: "hesitate, then answer" },
    look: { continuityPrompt: "same wardrobe and warm practical light" },
    references: input.references,
    output: {
      durationSec: 6,
      aspectRatio: "9:16",
      resolution: "1080p",
      shotCount: 1,
    },
    policy: { authority: "server" as const },
  };
  const generationIntentDigest = `intent:sha256:${createHash("sha256").update(stableJson(intent)).digest("hex")}`;
  return {
    schemaVersion: 2,
    previewId: "preview-seedance-v2",
    presetId: "seedance",
    mode: "image2video",
    generationIntent: intent,
    generationIntentDigest,
    generationScenario,
    outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: "volcengine.ark.seedance2.multimodal",
      providerId: "volcengine_ark",
      modelId: "doubao-seedance-2-0-260128",
      endpointId: "ark.v3.contents.generations.tasks",
      region: "cn-beijing",
      accountTier: "online",
    },
    capabilityProfileRef: {
      ...SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4,
    },
    adapterRevision: "openclaw-seedance-runtime/v2",
    runtimeRef: {
      runtimeId: "runtime-seedance",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "prompt-pack:R3",
        sourceRevision: "R3",
        required: true,
        support: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      ...input.references.map((item) => ({
        intentPath: `references.${item.role}.${item.ordinal}`,
        sourceRef: `shot:R4`,
        sourceRevision: "R4",
        required: true,
        support: "native" as const,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

const oldReceipt = "seedance-v2:image2video:old-job";
const uncertain = ["invalidReceipt", "missingOutput", "insecureOutput", "invalidOutput"] as const;
type QueryCase = (typeof uncertain)[number] | "failed" | "expired" | "running" | "canceled";
function receipt(kind: QueryCase): string {
  return kind === "invalidReceipt" ? "seedance-v2:unknown:old-job" : oldReceipt;
}
function response(kind: QueryCase, jobId: unknown = "old-job"): Response {
  return new Response(
    JSON.stringify({
      id: jobId,
      status: uncertain.includes(kind as (typeof uncertain)[number]) ? "succeeded" : kind,
      ...(kind === "insecureOutput"
        ? { content: { video_url: "http://example.test/video.mp4" } }
        : {}),
      ...(kind === "invalidOutput" ? { content: { video_url: 17 } } : {}),
    }),
  );
}
async function retry(kind: QueryCase, jobId: unknown = "old-job") {
  const bytes = Buffer.from("subject-0");
  const frozenPlan = plan({
    references: [reference({ role: "subject", ordinal: 0, mediaClass: "image" })],
    scenario: "subject_reference_to_video",
    audio: "silent",
  });
  expect(parseMediaGenRuntimeFrozenPlan(frozenPlan)).toEqual(frozenPlan);
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ id: "replacement-job" }))
      : response(kind, jobId),
  );
  const vendor = createSeedanceV2RuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: frozenPlan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(async () => ({
      bytes,
      mimeType: "image/png",
      sha256: sha(bytes),
    })),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "retry",
    taskId: "task-seedance-retry",
    workspaceId: "workspace-seedance-retry",
    correlationId: "correlation-seedance-retry",
    presetId: "seedance",
    mode: "image2video",
    prompt: frozenPlan.generationIntent.compiledPrompt,
    durationSec: 6,
    resolution: "1080p",
    params: { ratio: "9:16" },
    frozenPlan,
    runtimeJobId: receipt(kind),
    references: [
      { kind: "artifact", artifactId: "artifact-subject-0", role: "subject", ordinal: 0 },
    ],
  };
  return { result: await executor.dispatch(dispatch), fetchImpl, bridge };
}
describe("Seedance existing attempt uncertainty", () => {
  it.each(uncertain)("%s cannot recreate the existing provider attempt", async (kind) => {
    const { result, fetchImpl, bridge } = await retry(kind);
    expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect.soft(result.status).toBe("failed");
    expect.soft(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    expect(bridge.handoffArtifact).not.toHaveBeenCalled();
  });
  it.each(["failed", "expired"] as const)(
    "%s preserves confirmed terminal replacement",
    async (kind) => {
      const { result, fetchImpl, bridge } = await retry(kind);
      expect(result).toMatchObject({
        status: "processing",
        runtimeJobId: "seedance-v2:image2video:replacement-job",
      });
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(bridge.resolveArtifactReference).toHaveBeenCalledTimes(1);
      expect(bridge.handoffArtifact).not.toHaveBeenCalled();
    },
  );
  it("running reuses the original attempt without create", async () => {
    const { result, fetchImpl, bridge } = await retry("running");
    expect(result).toMatchObject({ status: "processing", runtimeJobId: oldReceipt });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
  });
  it.each([...uncertain, "failed", "expired"] as const)(
    "%s confirms stop only with terminal failure evidence",
    async (kind) => {
      const fetchImpl = vi.fn(async () => response(kind));
      const forget = vi.fn();
      const result = await cancelMediaGenRuntimeJob({
        dispatch: {
          op: "cancel",
          taskId: "stop-task",
          workspaceId: "stop-workspace",
          correlationId: "stop-correlation",
          presetId: "seedance",
          mode: "image2video",
          runtimeJobId: receipt(kind),
        },
        tracked: {
          vendor: createSeedanceV2RuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
          vendorJobId: receipt(kind),
        },
        forget,
      });
      expect(result).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: {
          state: kind === "failed" || kind === "expired" ? "confirmed" : "failed",
        },
      });
      expect(forget).toHaveBeenCalledTimes(kind === "failed" || kind === "expired" ? 1 : 0);
      expect(fetchImpl).toHaveBeenCalledTimes(kind === "invalidReceipt" ? 0 : 1);
    },
  );
});

describe("Seedance explicit provider job identity binding", () => {
  it.each(["running", "succeeded", "failed", "canceled"] as const)(
    "foreign %s cannot supply current attempt evidence",
    async (status) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "foreign-job",
              status,
              content: { video_url: "https://example.test/output.mp4" },
            }),
          ),
      );
      const vendor = createSeedanceV2RuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
      expect(await vendor.reconcile!(oldReceipt)).toMatchObject({
        state: "failed",
        vendorJobId: oldReceipt,
        retryDisposition: "reconcile_only",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, 17, ""])(
    "explicit malformed id %s does not supply terminal evidence",
    async (id) => {
      const vendor = createSeedanceV2RuntimeVendor({
        apiKey: "test-only-credential",
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id, status: "failed" }))),
      });
      expect(await vendor.reconcile!(oldReceipt)).toMatchObject({
        state: "failed",
        retryDisposition: "reconcile_only",
      });
    },
  );
  it.each(["failed", "expired"] as const)(
    "foreign %s cannot trigger replacement in the real executor",
    async (status) => {
      const { result, fetchImpl, bridge } = await retry(status, "foreign-job");
      expect
        .soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"))
        .toHaveLength(0);
      expect.soft(result.status).toBe("failed");
      expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
    },
  );
  it("foreign canceled evidence cannot confirm stopping the original attempt", async () => {
    const fetchImpl = vi.fn(async () => response("canceled", "foreign-job"));
    const forget = vi.fn();
    const result = await cancelMediaGenRuntimeJob({
      dispatch: {
        op: "cancel",
        taskId: "stop-task",
        workspaceId: "stop-workspace",
        correlationId: "stop-correlation",
        presetId: "seedance",
        mode: "image2video",
        runtimeJobId: oldReceipt,
      },
      tracked: {
        vendor: createSeedanceV2RuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
        vendorJobId: oldReceipt,
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
              status: "failed",
            }),
          ),
      );
      const vendor = createSeedanceV2RuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
      expect(await vendor.reconcile!(oldReceipt)).toMatchObject({
        state: "failed",
        vendorJobId: oldReceipt,
        retryDisposition: "replacement_allowed",
      });
    },
  );
});

describe("Seedance cancellation receipt binds the exact provider task", () => {
  const badIdentities = ["foreign-job", null, 17, {}, []].map((id) => ({ id }));
  it.each(badIdentities)(
    "explicit conflicting cancel id $id cannot confirm a stop",
    async ({ id }) => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE");
        return new Response(JSON.stringify({ id, status: "canceled" }));
      });
      const vendor = createSeedanceV2RuntimeVendor({ apiKey: "test-only-credential", fetchImpl });
      expect(await vendor.cancel!(oldReceipt)).toMatchObject({
        state: "requested",
        providerObservation: { outcome: "processing" },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each(badIdentities)(
    "conflicting cancel id $id cannot forget original tracking in the real stop helper",
    async ({ id }) => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE"
          ? new Response(JSON.stringify({ id, status: "canceled" }))
          : response("running"),
      );
      const forget = vi.fn();
      const result = await cancelMediaGenRuntimeJob({
        dispatch: {
          op: "cancel",
          taskId: "stop-task",
          workspaceId: "stop-workspace",
          correlationId: "stop-correlation",
          presetId: "seedance",
          mode: "image2video",
          runtimeJobId: oldReceipt,
        },
        tracked: {
          vendor: createSeedanceV2RuntimeVendor({ apiKey: "test-only-credential", fetchImpl }),
          vendorJobId: oldReceipt,
        },
        forget,
      });
      expect(result).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: { state: "requested" },
      });
      expect(forget).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
  it("foreign cancelled synonym also cannot confirm a stop", async () => {
    const vendor = createSeedanceV2RuntimeVendor({
      apiKey: "test-only-credential",
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ id: "foreign-job", status: "cancelled" })),
      ),
    });
    expect(await vendor.cancel!(oldReceipt)).toMatchObject({ state: "requested" });
  });
  it.each(["matching", "omitted"] as const)(
    "%s id preserves confirmed legacy canceled receipt",
    async (identity) => {
      const vendor = createSeedanceV2RuntimeVendor({
        apiKey: "test-only-credential",
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                ...(identity === "matching" ? { id: "old-job" } : {}),
                status: "canceled",
              }),
            ),
        ),
      });
      expect(await vendor.cancel!(oldReceipt)).toMatchObject({
        state: "confirmed",
        providerObservation: { outcome: "canceled" },
      });
    },
  );
  it("a matching cancelled synonym remains confirmed", async () => {
    const vendor = createSeedanceV2RuntimeVendor({
      apiKey: "test-only-credential",
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ id: "old-job", status: "cancelled" })),
      ),
    });
    expect(await vendor.cancel!(oldReceipt)).toMatchObject({ state: "confirmed" });
  });
  it("HTTP204 keeps the existing bodyless confirmation contract", async () => {
    const vendor = createSeedanceV2RuntimeVendor({
      apiKey: "test-only-credential",
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
    });
    expect(await vendor.cancel!(oldReceipt)).toMatchObject({ state: "confirmed" });
  });
  it("matching nonterminal response keeps stop requested", async () => {
    const vendor = createSeedanceV2RuntimeVendor({
      apiKey: "test-only-credential",
      fetchImpl: vi.fn(async () => response("running")),
    });
    expect(await vendor.cancel!(oldReceipt)).toMatchObject({ state: "requested" });
  });
});
