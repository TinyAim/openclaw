import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
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

const rejectedReceipts = [
  { name: "missing", body: "{}" },
  { name: "string_true", body: JSON.stringify({ allowed: "true", applied: "true" }) },
  { name: "numeric_one", body: JSON.stringify({ allowed: 1, applied: 1 }) },
  { name: "false", body: JSON.stringify({ allowed: false, applied: false }) },
  { name: "unknown", body: JSON.stringify({ allowed: "unknown", applied: "unknown" }) },
  { name: "nested", body: JSON.stringify({ allowed: { value: true }, applied: { value: true } }) },
  { name: "array", body: JSON.stringify([{ allowed: true, applied: true }]) },
  { name: "null", body: "null" },
  { name: "invalid_json", body: "{" },
];
type Phase = "input" | "output" | "label";
async function blocked(phase: Phase, body: string) {
  const plan = frozenPlan();
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  const moderationFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { phase: "input" | "output" };
    return new Response(sent.phase === phase ? body : JSON.stringify({ allowed: true }));
  });
  const labelFetch = vi.fn(async () => new Response(body));
  const providerFetch = vi.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            task_id: "test-job",
            ...(init?.method === "POST"
              ? {}
              : {
                  task_status: "succeed",
                  task_result: { videos: [{ url: "https://example.test/output.mp4" }] },
                }),
          },
        }),
      ),
  );
  const downloadFetch = vi.fn(
    async () => new Response("unexpected-download", { headers: { "content-type": "video/mp4" } }),
  );
  const bridge: MediaGenRuntimeBridge = {
    runtimeId: plan.runtimeRef.runtimeId,
    register: vi.fn(),
    resolveArtifactReference: vi.fn(),
    handoffArtifact: vi.fn(),
  };
  const executor = createOpenClawMediaGenRuntimeExecutor({
    bridge,
    fetchImpl: downloadFetch,
    vendors: [
      createKlingRuntimeVendor({
        accessKey: "test-only-access",
        secret: "test-only-secret",
        fetchImpl: providerFetch,
      }),
    ],
    moderation: createWebhookModeration({
      moderationUrl: "https://example.test/moderation",
      fetchImpl: moderationFetch,
    }),
    labeler: createWebhookLabeler({
      labelingUrl: "https://example.test/labeling",
      fetchImpl: labelFetch,
    }),
  });
  const dispatch: MediaGenRuntimeDispatch = {
    op: "submit",
    taskId: "test-task",
    workspaceId: "test-workspace",
    correlationId: "test-correlation",
    presetId: "kling",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 5,
    frozenPlan: plan,
  };
  expect(parseDispatch(dispatch)).not.toBeNull();
  let operation: Promise<unknown>;
  if (phase === "input") operation = Promise.resolve(executor.dispatch(dispatch));
  else {
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "text2video-v2:test-job",
    });
    operation = Promise.resolve(
      executor.dispatch({ ...dispatch, op: "poll", runtimeJobId: submitted.runtimeJobId }),
    );
  }
  const outcome = await operation.then(
    (result) => ({ rejected: false, result }),
    () => ({ rejected: true, result: undefined }),
  );
  if (!outcome.rejected) expect(outcome.result).toMatchObject({ status: "failed" });
  expect(providerFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
    phase === "input" ? 0 : 1,
  );
  expect(moderationFetch).toHaveBeenCalledTimes(phase === "input" ? 1 : 2);
  expect(labelFetch).toHaveBeenCalledTimes(phase === "label" ? 1 : 0);
  expect(downloadFetch).not.toHaveBeenCalled();
  expect(bridge.handoffArtifact).not.toHaveBeenCalled();
}
describe.each(["input", "output", "label"] as const)(
  "Runtime compliance %s receipt fail closed",
  (phase) => {
    it.each(rejectedReceipts)(
      "$name does not authorize the subsequent side effect",
      async ({ body }) => {
        await blocked(phase, body);
      },
    );
  },
);
describe("Runtime compliance literal-true controls", () => {
  const input = {
    mode: "text2video" as const,
    prompt: "A lantern.",
    hasSource: false,
    consentAuthorized: false,
  };
  const output = { mediaRef: "https://example.test/output.mp4", mimeType: "video/mp4" };
  it("input moderation accepts literal true", async () => {
    const hook = createWebhookModeration({
      moderationUrl: "https://example.test/moderation",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ allowed: true }))),
    });
    expect(await hook!.screenInput(input)).toMatchObject({ allowed: true });
  });
  it("output moderation accepts literal true", async () => {
    const hook = createWebhookModeration({
      moderationUrl: "https://example.test/moderation",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ allowed: true }))),
    });
    expect(await hook!.screenOutput(output)).toMatchObject({ allowed: true });
  });
  it("labeling accepts literal true and preserves existing in-place output metadata", async () => {
    const hook = createWebhookLabeler({
      labelingUrl: "https://example.test/labeling",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ applied: true }))),
    });
    expect(await hook!.applyLabel(output)).toMatchObject({ ...output, applied: true });
  });
});
