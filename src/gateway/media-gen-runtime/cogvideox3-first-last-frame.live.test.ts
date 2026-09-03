// Opt-in paid live smoke for the exact CogVideoX-3 first/last-frame route.
// A skipped run is never live-readiness evidence. Execution requires:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=cogvideox-flf
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_COGVIDEOX_FIRST_FRAME=/path/to/first.png
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_COGVIDEOX_LAST_FRAME=/path/to/last.png
//   ZHIPU_API_KEY (or OPENCLAW_COGVIDEOX_API_KEY)
//   moderation + labeling webhooks and a provider CDN host allow-list.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import {
  COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
  COGVIDEOX3_FIRST_LAST_ENDPOINT_ID,
  COGVIDEOX3_FIRST_LAST_MODEL_ID,
  COGVIDEOX3_FIRST_LAST_PROFILE_DIGEST,
  COGVIDEOX3_FIRST_LAST_PROFILE_ID,
  COGVIDEOX3_FIRST_LAST_ROUTE_ID,
} from "./cogvideox3-first-last-frame-compiler.js";
import { createCogVideoX3RuntimeVendor } from "./cogvideox3-vendor.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeBridge } from "./types.js";

const REQUESTED = new Set(
  (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
    .toLowerCase()
    .split(/[,\s;]+/g)
    .filter(Boolean),
);
const WANT_COGVIDEOX = REQUESTED.has("cogvideox-flf") || REQUESTED.has("all");
const PAID_AUTHORIZED = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID === "1";
const FIRST_PATH = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_COGVIDEOX_FIRST_FRAME?.trim() ?? "";
const LAST_PATH = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_COGVIDEOX_LAST_FRAME?.trim() ?? "";
const API_KEY = process.env.ZHIPU_API_KEY ?? process.env.OPENCLAW_COGVIDEOX_API_KEY ?? "";
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
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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

const firstMime = mimeForPath(FIRST_PATH);
const lastMime = mimeForPath(LAST_PATH);
const skipReason = !WANT_COGVIDEOX
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=cogvideox-flf to opt in"
  : !PAID_AUTHORIZED
    ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1 to authorize provider spend"
    : !API_KEY
      ? "Zhipu BigModel credentials are not configured"
      : !FIRST_PATH || !existsSync(FIRST_PATH)
        ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_COGVIDEOX_FIRST_FRAME is not readable"
        : !LAST_PATH || !existsSync(LAST_PATH)
          ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_COGVIDEOX_LAST_FRAME is not readable"
          : !firstMime || !lastMime
            ? "both CogVideoX live frames must be PNG or JPEG"
            : statSync(FIRST_PATH).size > MAX_IMAGE_BYTES ||
                statSync(LAST_PATH).size > MAX_IMAGE_BYTES
              ? "a CogVideoX live frame exceeds the official 5 MB limit"
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
  console.warn(`[openclaw.media-gen-runtime.live:cogvideox-flf] SKIPPED — ${skipReason}.`);
}

function exactFrozenPlan(input: {
  prompt: string;
  firstDigest: string;
  lastDigest: string;
  firstMime: "image/jpeg" | "image/png";
  lastMime: "image/jpeg" | "image/png";
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
  const reference = (
    role: "first_frame" | "last_frame",
    artifactId: string,
    digest: string,
    mimeType: "image/jpeg" | "image/png",
  ) => ({
    role,
    ordinal: 0,
    required: true,
    mediaClass: "image" as const,
    source: { kind: "artifact" as const, artifactId },
    assetRefId: `live-cogvideox3-${role}`,
    authorityRef: `artifact:live-cogvideox3-${role}`,
    authorityVerified: true,
    mimeType,
    sourceDigest: `sha256:${digest}`,
  });
  return {
    schemaVersion: 2,
    previewId: `live-cogvideox3-flf-preview-${Date.now()}`,
    presetId: "cogvideox",
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
        sourceDigests: [`sha256:${input.firstDigest}`, `sha256:${input.lastDigest}`],
      },
      generationScenario: "first_last_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: input.prompt,
      narrative: { visualPrompt: input.prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [
        reference("first_frame", FIRST_PATH, input.firstDigest, input.firstMime),
        reference("last_frame", LAST_PATH, input.lastDigest, input.lastMime),
      ],
      output: {
        durationSec: 5,
        aspectRatio: "16:9",
        resolution: "1080p",
        fps: 30,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_last_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
      providerId: "zhipu_open_platform",
      modelId: COGVIDEOX3_FIRST_LAST_MODEL_ID,
      endpointId: COGVIDEOX3_FIRST_LAST_ENDPOINT_ID,
      region: "cn",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: COGVIDEOX3_FIRST_LAST_PROFILE_ID,
      revision: 1,
      digest: COGVIDEOX3_FIRST_LAST_PROFILE_DIGEST,
    },
    adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "openclaw-live-smoke-runtime", lastSeenAt: frozenAt },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "output.audio"),
      { ...native("compiledPrompt", "prompt"), support: "prompt" },
      ...(["first_frame", "last_frame"] as const).map((role) => ({
        intentPath: `references.${role}.0`,
        sourceRef: `asset:live-cogvideox3-${role}`,
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerSlot: `references.${role}`,
        reasonCode: "live_reference_native",
        messageKey: "media.live_reference_native",
      })),
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

describe.skipIf(!live)("OpenClaw CogVideoX-3 first/last-frame live runtime smoke", () => {
  it(
    "runs the paid two-frame route through compliance, materialization, and Artifact handoff",
    async () => {
      const firstBytes = readFileSync(FIRST_PATH);
      const lastBytes = readFileSync(LAST_PATH);
      const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
      const lastDigest = createHash("sha256").update(lastBytes).digest("hex");
      const source = new Map([
        ["first_frame", { bytes: firstBytes, mimeType: firstMime!, sha256: firstDigest }],
        ["last_frame", { bytes: lastBytes, mimeType: lastMime!, sha256: lastDigest }],
      ]);
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async ({ artifactId, role }) => {
          expect(artifactId).toBe(role === "first_frame" ? FIRST_PATH : LAST_PATH);
          return source.get(role ?? "")!;
        },
        handoffArtifact: async ({ output, sha256 }) => ({
          artifactId: `openclaw-live-cogvideox3-flf-${Date.now()}`,
          mimeType: output.mimeType,
          resolution: output.resolution,
          sha256,
        }),
      };
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge,
        vendors: [
          createCogVideoX3RuntimeVendor({
            apiKey: API_KEY,
            baseUrl: process.env.ZHIPU_BASE_URL ?? process.env.OPENCLAW_COGVIDEOX_BASE_URL,
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
      const prompt =
        process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
        "Preserve both supplied boundary frames while the paper boat crosses the pond.";
      const plan = exactFrozenPlan({
        prompt,
        firstDigest,
        lastDigest,
        firstMime: firstMime!,
        lastMime: lastMime!,
      });
      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-cogvideox3-flf-${Date.now()}`,
        workspaceId: "openclaw-live-smoke",
        correlationId: `live-cogvideox3-flf-${Date.now()}`,
        presetId: "cogvideox",
        mode: "image2video",
        prompt,
        durationSec: 5,
        resolution: "1080p",
        references: [
          { kind: "artifact", artifactId: FIRST_PATH, role: "first_frame", ordinal: 0 },
          { kind: "artifact", artifactId: LAST_PATH, role: "last_frame", ordinal: 0 },
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
        routeId: COGVIDEOX3_FIRST_LAST_ROUTE_ID,
        adapterRevision: COGVIDEOX3_FIRST_LAST_ADAPTER_REVISION,
        outcome: "succeeded",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
