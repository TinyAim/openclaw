// Opt-in paid live smoke for the exact Wan 2.2 first-frame route.
// A skipped run is never live-readiness evidence. Execution requires:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=wan-i2v
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_WAN_IMAGE=/path/to/frame.png
//   DASHSCOPE_API_KEY
//   moderation + labeling webhooks and a provider CDN host allow-list.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";
import { createWanRuntimeVendor } from "./wan-vendor.js";
import {
  compileWan22I2vRequest,
  WAN22_I2V_ADAPTER_REVISION,
  WAN22_I2V_ENDPOINT_ID,
  WAN22_I2V_MODEL_ID,
  WAN22_I2V_PROFILE_DIGEST,
  WAN22_I2V_PROFILE_ID,
  WAN22_I2V_ROUTE_ID,
} from "./wan2-2-i2v-compiler.js";

const REQUESTED = new Set(
  (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
    .toLowerCase()
    .split(/[,\s;]+/gu)
    .filter(Boolean),
);
const WANT_WAN = REQUESTED.has("wan-i2v") || REQUESTED.has("all");
const PAID_AUTHORIZED = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID === "1";
const IMAGE_PATH = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_WAN_IMAGE?.trim() ?? "";
const API_KEY = process.env.DASHSCOPE_API_KEY ?? "";
const MODERATION_URL = process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "";
const LABELING_URL = process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "";
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/gu)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0
    ? REQUESTED_TIMEOUT_MS
    : 300_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const ASPECT_RATIO = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_WAN_ASPECT_RATIO ?? "16:9";

function mimeForPath(filePath: string): "image/jpeg" | "image/png" | null {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      return null;
  }
}

const imageMime = mimeForPath(IMAGE_PATH);
const skipReason = !WANT_WAN
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=wan-i2v to opt in"
  : !PAID_AUTHORIZED
    ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1 to authorize provider spend"
    : !API_KEY
      ? "DashScope credentials are not configured"
      : !IMAGE_PATH || !existsSync(IMAGE_PATH)
        ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_WAN_IMAGE is not a readable local file"
        : !imageMime
          ? "the Wan live frame must be PNG or JPEG"
          : statSync(IMAGE_PATH).size > MAX_IMAGE_BYTES
            ? "the Wan live frame exceeds the official 10 MB limit"
            : !SUPPORTED_RATIOS.has(ASPECT_RATIO)
              ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_WAN_ASPECT_RATIO is unsupported"
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
  console.warn(`[openclaw.media-gen-runtime.live:wan-i2v] SKIPPED — ${skipReason}.`);
}

function exactFrozenPlan(input: {
  prompt: string;
  sourceDigest: string;
  mimeType: "image/jpeg" | "image/png";
}): MediaGenRuntimeFrozenPlanV2 {
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
    previewId: `live-wan-i2v-preview-${Date.now()}`,
    presetId: "wan",
    mode: "image2video",
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
        sourceDigests: [`sha256:${input.sourceDigest}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: input.prompt,
      narrative: { visualPrompt: input.prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "artifact", artifactId: IMAGE_PATH },
          assetRefId: "live-wan-frame",
          authorityRef: "artifact:live-wan-frame",
          authorityVerified: true,
          mimeType: input.mimeType,
          sourceDigest: `sha256:${input.sourceDigest}`,
        },
      ],
      output: {
        durationSec: 5,
        aspectRatio: ASPECT_RATIO,
        resolution: "1080p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: WAN22_I2V_ROUTE_ID,
      providerId: "dashscope",
      modelId: WAN22_I2V_MODEL_ID,
      endpointId: WAN22_I2V_ENDPOINT_ID,
      region: "cn-beijing",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: WAN22_I2V_PROFILE_ID,
      revision: 1,
      digest: WAN22_I2V_PROFILE_DIGEST,
    },
    adapterRevision: WAN22_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "openclaw-live-smoke-runtime", lastSeenAt: frozenAt },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "output.audio"),
      { ...native("compiledPrompt", "prompt"), support: "prompt" },
      {
        intentPath: "references.first_frame.0",
        sourceRef: "asset:live-wan-frame",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerSlot: "references.first_frame",
        reasonCode: "live_reference_native",
        messageKey: "media.live_reference_native",
      },
      native("output.durationSec", "output.durationSec"),
      native("output.aspectRatio", "output.aspectRatio"),
      native("output.resolution", "output.resolution"),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("OpenClaw Wan 2.2 first-frame live runtime smoke", () => {
  it(
    "runs the paid route through compliance, Artifact materialization, and handoff",
    async () => {
      const frameBytes = readFileSync(IMAGE_PATH);
      const sourceDigest = createHash("sha256").update(frameBytes).digest("hex");
      const mimeType = imageMime!;
      const prompt =
        process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
        "Preserve the first-frame composition while the paper kite rises slowly.";
      const plan = exactFrozenPlan({ prompt, sourceDigest, mimeType });
      const preflight: MediaGenRuntimeVendorInput = {
        taskId: "live-wan-i2v-preflight",
        presetId: "wan",
        mode: "image2video",
        prompt,
        durationSec: 5,
        resolution: "1080p",
        sources: [
          {
            role: "first_frame",
            ordinal: 0,
            source: { bytes: frameBytes, mimeType, sha256: sourceDigest },
          },
        ],
        frozenPlan: plan,
      };
      expect(compileWan22I2vRequest(preflight)).toMatchObject({ ok: true });

      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async ({ artifactId, role }) => {
          expect(artifactId).toBe(IMAGE_PATH);
          expect(role).toBe("first_frame");
          return { bytes: frameBytes, mimeType, sha256: sourceDigest };
        },
        handoffArtifact: async ({ output, sha256 }) => ({
          artifactId: `openclaw-live-wan-i2v-${Date.now()}`,
          mimeType: output.mimeType,
          resolution: output.resolution,
          sha256,
        }),
      };
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge,
        vendors: [
          createWanRuntimeVendor({
            apiKey: API_KEY,
            baseUrl: process.env.DASHSCOPE_BASE_URL,
          }),
        ],
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
      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-wan-i2v-${Date.now()}`,
        workspaceId: "openclaw-live-smoke",
        correlationId: `live-wan-i2v-${Date.now()}`,
        presetId: "wan",
        mode: "image2video",
        prompt,
        durationSec: 5,
        resolution: "1080p",
        references: [
          {
            kind: "artifact",
            artifactId: IMAGE_PATH,
            role: "first_frame",
            ordinal: 0,
          },
        ],
        frozenPlan: plan,
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
        routeId: WAN22_I2V_ROUTE_ID,
        adapterRevision: WAN22_I2V_ADAPTER_REVISION,
        outcome: "succeeded",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
