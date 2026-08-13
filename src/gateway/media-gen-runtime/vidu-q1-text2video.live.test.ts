// Opt-in paid live smoke for the exact Vidu Q1 Text-to-Video runtime route.
// A skipped run is never live-readiness evidence. Execution requires:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=vidu-t2v
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1
//   VIDU_API_KEY (or OPENCLAW_VIDU_API_KEY)
//   moderation + labeling webhook URLs and a Vidu CDN host allow-list.
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
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
import { createViduRuntimeVendor } from "./vidu-vendor.js";

const REQUESTED = new Set(
  (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
    .toLowerCase()
    .split(/[,\s;]+/g)
    .filter(Boolean),
);
const WANT_VIDU_T2V = REQUESTED.has("vidu-t2v") || REQUESTED.has("all");
const PAID_AUTHORIZED = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID === "1";
const API_KEY = process.env.VIDU_API_KEY ?? process.env.OPENCLAW_VIDU_API_KEY ?? "";
const MODERATION_URL = process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "";
const LABELING_URL = process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "";
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/g)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0
    ? REQUESTED_TIMEOUT_MS
    : 300_000;
const POLL_INTERVAL_MS = 5_000;

const skipReason = !WANT_VIDU_T2V
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=vidu-t2v to opt in"
  : !PAID_AUTHORIZED
    ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1 to authorize provider spend"
    : !API_KEY
      ? "Vidu credentials are not configured"
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
  console.warn(`[openclaw.media-gen-runtime.live:vidu-t2v] SKIPPED — ${skipReason}.`);
}

function exactFrozenPlan(prompt: string): MediaGenRuntimeFrozenPlanV2 {
  const frozenAt = new Date().toISOString();
  const native = (intentPath: string, providerField: string) => ({
    intentPath,
    sourceRef: "live:R1",
    sourceRevision: "R1",
    required: true,
    support: "native" as const,
    providerField,
    reasonCode: "live_native",
    messageKey: "media.live_native",
  });
  return {
    schemaVersion: 2,
    previewId: `live-vidu-t2v-preview-${Date.now()}`,
    presetId: "vidu",
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
      output: {
        durationSec: 5,
        aspectRatio: "16:9",
        resolution: "1080p",
        fps: 24,
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
    runtimeRef: { runtimeId: "openclaw-live-smoke-runtime", lastSeenAt: frozenAt },
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
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("OpenClaw Vidu Q1 Text-to-Video live runtime smoke", () => {
  it(
    "runs the paid exact route through compliance, materialization, and Artifact handoff",
    async () => {
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async () => {
          throw new Error("Vidu T2V live smoke must not resolve source artifacts");
        },
        handoffArtifact: async ({ output, sha256 }) => ({
          artifactId: `openclaw-live-vidu-t2v-${Date.now()}`,
          mimeType: output.mimeType,
          durationSec: output.durationSec,
          resolution: output.resolution,
          sha256,
        }),
      };
      const vendor = createViduRuntimeVendor({
        apiKey: API_KEY,
        baseUrl: process.env.VIDU_BASE_URL ?? process.env.OPENCLAW_VIDU_BASE_URL,
      });
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
      });
      const prompt =
        process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
        "A paper lantern drifts above a quiet canal at blue hour, cinematic.";
      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-vidu-t2v-${Date.now()}`,
        workspaceId: "openclaw-live-smoke",
        correlationId: `live-vidu-t2v-${Date.now()}`,
        presetId: "vidu",
        mode: "text2video",
        prompt,
        durationSec: 5,
        resolution: "1080p",
        frozenPlan: exactFrozenPlan(prompt),
      };

      let current = await executor.dispatch(initial);
      expect(current.status, current.failureMessage).toBe("processing");
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline && current.status === "processing") {
        await sleep(POLL_INTERVAL_MS);
        current = await executor.dispatch({
          ...initial,
          op: "poll",
          runtimeJobId: current.runtimeJobId,
        });
      }

      expect(current.status, current.failureMessage).toBe("succeeded");
      expect(current.artifact).toMatchObject({
        artifactId: expect.any(String),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(current.snapshot).toMatchObject({
        executionOwner: "user_runtime",
        moderationStatus: "runtime_enforced",
        labelingStatus: "runtime_applied",
      });
      expect(current.providerObservation).toMatchObject({
        routeId: VIDU_Q1_T2V_ROUTE_ID,
        adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
        outcome: "succeeded",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
