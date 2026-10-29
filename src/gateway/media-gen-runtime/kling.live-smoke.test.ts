// Opt-in live smoke for the Direction 1 OpenClaw runtime executor.
//
// This is NOT a default CI test. It only runs when all production-like inputs
// are present:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=kling
//   KLING_ACCESS_KEY / KLING_SECRET
//   OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL
//   OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL
//   OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST
//
// A skipped run is never evidence of live readiness. A passing run proves the
// OpenClaw runtime executor can call the real Kling API, run real compliance
// hooks, fetch a media output through the runtime materializer safety gates, and
// return an honest runtime snapshot.
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  KLING_T2V_V2_ADAPTER_REVISION,
  KLING_T2V_V2_ENDPOINT_ID,
  KLING_T2V_V2_MODEL_ID,
  KLING_T2V_V2_PROFILE_DIGEST,
  KLING_T2V_V2_PROFILE_ID,
  KLING_T2V_V2_ROUTE_ID,
} from "./kling-text2video-v2-compiler.js";
import { createKlingRuntimeVendor } from "./kling-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendor } from "./types.js";

const REQUESTED = (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
  .toLowerCase()
  .split(/[,\s;]+/g)
  .filter(Boolean);
const WANT_KLING = REQUESTED.includes("kling") || REQUESTED.includes("all");
const ACCESS_KEY = process.env.KLING_ACCESS_KEY ?? process.env.OPENCLAW_KLING_ACCESS_KEY ?? "";
const SECRET = process.env.KLING_SECRET ?? process.env.OPENCLAW_KLING_SECRET ?? "";
const MODERATION_URL = process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "";
const LABELING_URL = process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "";
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/g)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0 ? REQUESTED_TIMEOUT_MS : 300000;
const POLL_INTERVAL_MS = 5_000;
const MAX_ARTIFACT_BYTES = Number(process.env.OPENCLAW_MEDIA_GEN_MAX_ARTIFACT_BYTES);
const FETCH_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_FETCH_TIMEOUT_MS);

const skipReason = !WANT_KLING
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=kling to opt in"
  : !ACCESS_KEY || !SECRET
    ? "Kling credentials are not configured"
    : !MODERATION_URL
      ? "OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL is not configured"
      : !LABELING_URL
        ? "OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL is not configured"
        : ALLOWED_HOSTS.length === 0
          ? "OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST is empty"
          : "";
const live = skipReason.length === 0;

if (!live) {
  // eslint-disable-next-line no-console
  console.warn(`[openclaw.media-gen-runtime.live:kling] SKIPPED — ${skipReason}.`);
}

function exactFrozenPlan(prompt: string): MediaGenRuntimeFrozenPlanV2 {
  const frozenAt = new Date().toISOString();
  return {
    schemaVersion: 2,
    previewId: `live-kling-preview-${Date.now()}`,
    presetId: "kling",
    mode: "text2video",
    generationIntent: {
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
      output: { durationSec: 5, aspectRatio: "16:9", shotCount: 1 },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: KLING_T2V_V2_ROUTE_ID,
      providerId: "kling_open_platform",
      modelId: KLING_T2V_V2_MODEL_ID,
      endpointId: KLING_T2V_V2_ENDPOINT_ID,
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: KLING_T2V_V2_PROFILE_ID,
      revision: 1,
      digest: KLING_T2V_V2_PROFILE_DIGEST,
    },
    adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "openclaw-live-smoke-runtime", lastSeenAt: frozenAt },
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
}

function dispatch(overrides: Partial<MediaGenRuntimeDispatch> = {}): MediaGenRuntimeDispatch {
  const prompt =
    process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
    "A calm ocean horizon at sunrise, gentle waves, cinematic.";
  return {
    op: "submit",
    taskId: `live-kling-${Date.now()}`,
    workspaceId: "openclaw-live-smoke",
    correlationId: `live-kling-${Date.now()}`,
    presetId: "kling",
    mode: "text2video",
    prompt,
    durationSec: 5,
    frozenPlan: exactFrozenPlan(prompt),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("OpenClaw media-generation Kling live runtime smoke", () => {
  it(
    "runs real Kling generation through runtime compliance hooks and materializer gates",
    async () => {
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async () => {
          throw new Error("text2video smoke must not resolve source artifacts");
        },
        handoffArtifact: async ({ output, bytes, sha256 }) => ({
          artifactId: `openclaw-live-${Date.now()}`,
          mimeType: output.mimeType,
          durationSec: output.durationSec,
          resolution: output.resolution,
          sha256,
        }),
      };
      const vendor: MediaGenRuntimeVendor = createKlingRuntimeVendor({
        accessKey: ACCESS_KEY,
        secret: SECRET,
        baseUrl: process.env.KLING_BASE_URL ?? process.env.OPENCLAW_KLING_BASE_URL,
      });
      expect(vendor.isConfigured()).toBe(true);
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge,
        vendors: [vendor],
        moderation: createWebhookModeration({
          moderationUrl: MODERATION_URL,
          token: COMPLIANCE_TOKEN,
        })!,
        labeler: createWebhookLabeler({
          labelingUrl: LABELING_URL,
          token: COMPLIANCE_TOKEN,
        })!,
        allowedMediaHosts: ALLOWED_HOSTS,
        maxMediaBytes:
          Number.isFinite(MAX_ARTIFACT_BYTES) && MAX_ARTIFACT_BYTES > 0
            ? MAX_ARTIFACT_BYTES
            : 512 * 1024 * 1024,
        mediaFetchTimeoutMs:
          Number.isFinite(FETCH_TIMEOUT_MS) && FETCH_TIMEOUT_MS > 0 ? FETCH_TIMEOUT_MS : 120000,
      });

      const initial = dispatch();
      const submitted = await executor.dispatch(initial);
      expect(submitted.status, submitted.failureMessage).toBe("processing");
      expect(submitted.runtimeJobId).toBeTruthy();

      const deadline = Date.now() + TIMEOUT_MS;
      let current = submitted;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        current = await executor.dispatch({
          ...initial,
          op: "poll",
          runtimeJobId: current.runtimeJobId,
        });
        if (current.status === "succeeded" || current.status === "failed") break;
      }

      expect(current.status, current.failureMessage).toBe("succeeded");
      const artifact = current.artifact as { artifactId?: unknown; sha256?: unknown } | undefined;
      expect(artifact?.artifactId).toBeTruthy();
      expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(current.snapshot).toMatchObject({
        executionOwner: "user_runtime",
        moderationStatus: "runtime_enforced",
        labelingStatus: "runtime_applied",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
