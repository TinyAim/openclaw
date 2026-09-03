// Opt-in paid live smoke for the exact Seedance V2 Text-to-Video route.
// A skipped run is never live-readiness evidence. Execution requires:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=seedance-t2v
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1
//   ARK_API_KEY (or VOLCENGINE_ARK_API_KEY / OPENCLAW_SEEDANCE_API_KEY)
//   moderation + labeling webhooks, a non-empty output host allow-list,
//   and runtime ffprobe/ffmpeg quality tools.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentV2,
  type MediaGenRuntimeFrozenPlanV2,
} from "./frozen-plan.js";
import { probeMediaQualityToolsAvailableSync } from "./media-quality-tools.js";
import { createMediaQualityValidator } from "./media-quality-validator.js";
import {
  compileSeedanceV2Request,
  SEEDANCE_V2_ADAPTER_REVISION,
  SEEDANCE_V2_ENDPOINT_ID,
  SEEDANCE_V2_MODEL_ID,
  SEEDANCE_V2_PROFILE_DIGESTS,
  SEEDANCE_V2_ROUTE_IDS,
} from "./seedance-v2-compiler.js";
import { createSeedanceV2RuntimeVendor } from "./seedance-vendor-v2.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";

const REQUESTED = new Set(
  (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
    .toLowerCase()
    .split(/[,\s;]+/gu)
    .filter(Boolean),
);
// Deliberately do not accept `all`: this paid route needs explicit Seedance opt-in.
const WANT_SEEDANCE_T2V = REQUESTED.has("seedance-t2v");
const PAID_AUTHORIZED = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID === "1";
const API_KEY = (
  process.env.ARK_API_KEY ??
  process.env.VOLCENGINE_ARK_API_KEY ??
  process.env.OPENCLAW_SEEDANCE_API_KEY ??
  ""
).trim();
const MODERATION_URL = (process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "").trim();
const LABELING_URL = (process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "").trim();
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/gu)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const PROMPT = (
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
  "A red paper kite rises above a quiet riverside town at sunrise, cinematic."
).trim();
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0
    ? REQUESTED_TIMEOUT_MS
    : 300_000;
const POLL_INTERVAL_MS = 5_000;
const WORKSPACE_ID = "openclaw-live-smoke";
const RUNTIME_ID = "openclaw-live-smoke-runtime";

const prerequisiteSkipReason = !WANT_SEEDANCE_T2V
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=seedance-t2v to opt in"
  : !PAID_AUTHORIZED
    ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1 to authorize provider spend"
    : !API_KEY
      ? "Seedance Ark credentials are not configured"
      : !MODERATION_URL
        ? "OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL is not configured"
        : !LABELING_URL
          ? "OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL is not configured"
          : ALLOWED_HOSTS.length === 0
            ? "OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST is empty"
            : !PROMPT || PROMPT.length > 10_000
              ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT must contain 1 to 10000 characters"
              : "";
const qualityTools = prerequisiteSkipReason ? null : probeMediaQualityToolsAvailableSync();
const skipReason = prerequisiteSkipReason
  ? prerequisiteSkipReason
  : qualityTools && !qualityTools.ok
    ? `runtime media quality tools are missing: ${qualityTools.missing.join(", ")}`
    : "";
const live = skipReason.length === 0;

if (!live) {
  // eslint-disable-next-line no-console
  console.warn(`[openclaw.media-gen-runtime.live:seedance-t2v] SKIPPED — ${skipReason}.`);
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

function exactFrozenPlan(prompt: string): MediaGenRuntimeFrozenPlanV2 {
  const frozenAt = new Date().toISOString();
  const generationIntent: MediaGenerationIntentV2 = {
    schemaVersion: 2,
    identity: {
      projectId: "openclaw-live-smoke",
      shotId: "openclaw-live-smoke-shot",
      shotVersion: "R1",
      promptPackId: "openclaw-live-smoke-pack",
      promptPackVersion: 1,
      promptPackUpdatedAt: frozenAt,
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
      durationSec: 4,
      aspectRatio: "16:9",
      resolution: "720p",
      shotCount: 1,
    },
    policy: { authority: "server" },
  };
  const generationIntentDigest = `intent:sha256:${createHash("sha256")
    .update(stableJson(generationIntent))
    .digest("hex")}`;
  const native = (intentPath: string, providerField: string) => ({
    intentPath,
    sourceRef: "shot:R1",
    sourceRevision: "R1",
    required: true,
    support: "native" as const,
    providerField,
    reasonCode: "live_native",
    messageKey: "media.live_native",
  });
  return {
    schemaVersion: 2,
    previewId: `live-seedance-v2-preview-${Date.now()}`,
    presetId: "seedance",
    mode: "text2video",
    generationIntent,
    generationIntentDigest,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: SEEDANCE_V2_ROUTE_IDS.text2video,
      providerId: "volcengine_ark",
      modelId: SEEDANCE_V2_MODEL_ID,
      endpointId: SEEDANCE_V2_ENDPOINT_ID,
      region: "cn-beijing",
      accountTier: "online",
    },
    capabilityProfileRef: {
      profileId: "seedance.openclaw-runtime.text2video.v4",
      revision: 4,
      digest: SEEDANCE_V2_PROFILE_DIGESTS.text2video,
    },
    adapterRevision: SEEDANCE_V2_ADAPTER_REVISION,
    runtimeRef: { runtimeId: RUNTIME_ID, lastSeenAt: frozenAt },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "generate_audio"),
      { ...native("compiledPrompt", "content.0.text"), support: "prompt" },
      native("output.durationSec", "duration"),
      native("output.aspectRatio", "ratio"),
      native("output.resolution", "resolution"),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function exactVendorInput(
  plan: MediaGenRuntimeFrozenPlanV2,
  taskId: string,
): MediaGenRuntimeVendorInput {
  return {
    taskId,
    presetId: "seedance",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: 4,
    resolution: "720p",
    params: { ratio: "16:9" },
    frozenPlan: plan,
  };
}

function expectExactPlanAndCompile(plan: MediaGenRuntimeFrozenPlanV2): void {
  expect(parseMediaGenRuntimeFrozenPlan(plan)).toEqual(plan);
  expect(plan.providerRouteRef).toEqual({
    schemaVersion: 1,
    routeId: SEEDANCE_V2_ROUTE_IDS.text2video,
    providerId: "volcengine_ark",
    modelId: SEEDANCE_V2_MODEL_ID,
    endpointId: SEEDANCE_V2_ENDPOINT_ID,
    region: "cn-beijing",
    accountTier: "online",
  });
  expect(compileSeedanceV2Request(exactVendorInput(plan, "seedance-v2-compile"))).toMatchObject({
    ok: true,
    body: {
      model: SEEDANCE_V2_MODEL_ID,
      content: [{ type: "text", text: plan.generationIntent.compiledPrompt }],
      generate_audio: false,
      ratio: "16:9",
      duration: 4,
      resolution: "720p",
    },
    providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("OpenClaw Seedance V2 Text-to-Video exact compile contract", () => {
  it("parses the frozen plan and compiles the exact route without provider I/O", () => {
    expectExactPlanAndCompile(exactFrozenPlan("A red paper kite rises at sunrise."));
  });
});

describe.skipIf(!live)("OpenClaw Seedance V2 Text-to-Video live runtime smoke", () => {
  it(
    "runs the paid exact route through compile, quality, and Artifact handoff",
    async () => {
      const plan = exactFrozenPlan(PROMPT);
      expectExactPlanAndCompile(plan);

      let qualityCount = 0;
      let qualityPassed = false;
      let handoffCount = 0;
      const validator = createMediaQualityValidator({ mode: "required" });
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: RUNTIME_ID,
        register: async () => undefined,
        resolveArtifactReference: async () => {
          throw new Error("Seedance V2 T2V live smoke must not resolve source artifacts");
        },
        handoffArtifact: async ({ output, bytes, sha256 }) => {
          handoffCount += 1;
          expect(qualityPassed).toBe(true);
          expect(bytes.length).toBeGreaterThan(0);
          expect(output.mimeType).toBe("video/mp4");
          expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
          return {
            artifactId: `openclaw-live-seedance-v2-${Date.now()}`,
            mimeType: output.mimeType,
            durationSec: output.durationSec,
            resolution: output.resolution,
            sha256,
          };
        },
      };
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge,
        vendors: [createSeedanceV2RuntimeVendor({ apiKey: API_KEY })],
        moderation: createWebhookModeration({
          moderationUrl: MODERATION_URL,
          token: COMPLIANCE_TOKEN,
        })!,
        labeler: createWebhookLabeler({
          labelingUrl: LABELING_URL,
          token: COMPLIANCE_TOKEN,
        })!,
        allowedMediaHosts: ALLOWED_HOSTS,
        validateMediaBytes: async (input) => {
          qualityCount += 1;
          const result = await validator(input);
          if (!result.ok) {
            return result;
          }
          qualityPassed = true;
          return { ok: true as const, verified: true };
        },
      });
      const suffix = Date.now();
      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-seedance-v2-${suffix}`,
        workspaceId: WORKSPACE_ID,
        correlationId: `live-seedance-v2-${suffix}`,
        presetId: "seedance",
        mode: "text2video",
        prompt: PROMPT,
        durationSec: 4,
        resolution: "720p",
        params: { ratio: "16:9" },
        frozenPlan: plan,
      };

      let current = await executor.dispatch(initial);
      expect(current.status, current.failureMessage).toBe("processing");
      expect(current.runtimeJobId).toMatch(/^seedance-v2:text2video:/u);
      expect(current.providerObservation).toMatchObject({
        routeId: SEEDANCE_V2_ROUTE_IDS.text2video,
        adapterRevision: SEEDANCE_V2_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
        qualityOutcome: "not_run",
      });
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline && current.status === "processing") {
        await sleep(POLL_INTERVAL_MS);
        current = await executor.dispatch({
          op: "poll",
          taskId: initial.taskId,
          workspaceId: initial.workspaceId,
          correlationId: initial.correlationId,
          presetId: "seedance",
          mode: "text2video",
          runtimeJobId: current.runtimeJobId,
        });
      }

      expect(current.status, current.failureMessage).toBe("succeeded");
      expect(qualityCount).toBe(1);
      expect(handoffCount).toBe(1);
      expect(current.artifact).toMatchObject({
        artifactId: expect.any(String),
        mimeType: "video/mp4",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(current.snapshot).toMatchObject({
        executionOwner: "user_runtime",
        moderationStatus: "runtime_enforced",
        labelingStatus: "runtime_applied",
      });
      expect(current.providerObservation).toMatchObject({
        routeId: SEEDANCE_V2_ROUTE_IDS.text2video,
        adapterRevision: SEEDANCE_V2_ADAPTER_REVISION,
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
