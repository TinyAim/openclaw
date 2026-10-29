// Opt-in paid live smoke for the exact Runway Gen-4.5 Text-to-Video route.
// A skipped run is never live-readiness evidence. Execution requires:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=runway-t2v
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1
//   RUNWAYML_API_SECRET (or OPENCLAW_RUNWAY_API_SECRET)
//   moderation + labeling webhooks and a Runway output host allow-list.
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileRunwayGen45T2vRequest,
  RUNWAY_GEN45_T2V_ADAPTER_REVISION,
  RUNWAY_GEN45_T2V_ENDPOINT_ID,
  RUNWAY_GEN45_T2V_MODEL_ID,
  RUNWAY_GEN45_T2V_PROFILE_DIGEST,
  RUNWAY_GEN45_T2V_PROFILE_ID,
  RUNWAY_GEN45_T2V_ROUTE_ID,
} from "./runway-gen45-t2v-compiler.js";
import { createRunwayRuntimeVendor } from "./runway-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";

const REQUESTED = new Set(
  (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
    .toLowerCase()
    .split(/[,\s;]+/gu)
    .filter(Boolean),
);
const WANT_RUNWAY_T2V = REQUESTED.has("runway-t2v") || REQUESTED.has("all");
const PAID_AUTHORIZED = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID === "1";
const API_KEY = process.env.RUNWAYML_API_SECRET ?? process.env.OPENCLAW_RUNWAY_API_SECRET ?? "";
const MODERATION_URL = process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "";
const LABELING_URL = process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "";
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/gu)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const PROMPT =
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
  "A paper kite crosses a quiet waterfront skyline in warm sunset light, cinematic.";
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0
    ? REQUESTED_TIMEOUT_MS
    : 300_000;
const POLL_INTERVAL_MS = 5_000;
const WORKSPACE_ID = "openclaw-live-smoke";

const skipReason = !WANT_RUNWAY_T2V
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=runway-t2v to opt in"
  : !PAID_AUTHORIZED
    ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1 to authorize provider spend"
    : !API_KEY
      ? "Runway credentials are not configured"
      : PROMPT.trim().length === 0 || PROMPT.length > 1_000
        ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT must contain 1 to 1000 UTF-16 code units"
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
  console.warn(`[openclaw.media-gen-runtime.live:runway-t2v] SKIPPED — ${skipReason}.`);
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
    previewId: `live-runway-gen45-preview-${Date.now()}`,
    presetId: "runway",
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
        durationSec: 6,
        aspectRatio: "16:9",
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
      revision: 1,
      digest: RUNWAY_GEN45_T2V_PROFILE_DIGEST,
    },
    adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "openclaw-live-smoke-runtime", lastSeenAt: frozenAt },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "output.audio"),
      { ...native("compiledPrompt", "prompt"), support: "prompt" },
      native("output.durationSec", "output.durationSec"),
      native("output.aspectRatio", "output.aspectRatio"),
      native("output.resolution", "output.resolution"),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("OpenClaw Runway Gen-4.5 Text-to-Video live runtime smoke", () => {
  it(
    "runs the paid exact route through compliance, output download, and Artifact handoff",
    async () => {
      let handoffCount = 0;
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async () => {
          throw new Error("Runway Gen-4.5 T2V live smoke must not resolve source artifacts");
        },
        handoffArtifact: async ({ output, bytes, sha256 }) => {
          handoffCount += 1;
          expect(bytes.length).toBeGreaterThan(0);
          expect(output.mimeType).toBe("video/mp4");
          expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
          return {
            artifactId: `openclaw-live-runway-gen45-${Date.now()}`,
            mimeType: output.mimeType,
            resolution: "720p",
            sha256,
          };
        },
      };
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge,
        vendors: [createRunwayRuntimeVendor({ apiKey: API_KEY })],
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
      const plan = exactFrozenPlan(PROMPT);
      const preflight: MediaGenRuntimeVendorInput = {
        taskId: "live-runway-gen45-preflight",
        presetId: "runway",
        mode: "text2video",
        prompt: PROMPT,
        durationSec: 6,
        resolution: "720p",
        frozenPlan: plan,
      };
      expect(compileRunwayGen45T2vRequest(preflight)).toMatchObject({ ok: true });

      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-runway-gen45-${Date.now()}`,
        workspaceId: WORKSPACE_ID,
        correlationId: `live-runway-gen45-${Date.now()}`,
        presetId: "runway",
        mode: "text2video",
        prompt: PROMPT,
        durationSec: 6,
        resolution: "720p",
        frozenPlan: plan,
      };

      let current = await executor.dispatch(initial);
      expect(current.status, current.failureMessage).toBe("processing");
      expect(current.runtimeJobId).toMatch(/^runway-gen45-t2v:/u);
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
      expect(handoffCount).toBe(1);
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
        routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
        adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
        outcome: "succeeded",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
