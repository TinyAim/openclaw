// Opt-in paid live smoke for the exact Luma Ray 2 first-frame route.
// A skipped run is never live-readiness evidence. Execution requires:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=luma-i2v (or all)
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1
//   LUMAAI_API_KEY (or OPENCLAW_LUMA_API_KEY)
//   owner-provided HTTPS input URL, image MIME, SHA-256, compliance hooks,
//   and an output CDN host allow-list.
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileLumaRay2I2vRequest,
  LUMA_RAY2_I2V_ADAPTER_REVISION,
  LUMA_RAY2_I2V_ENDPOINT_ID,
  LUMA_RAY2_I2V_MODEL_ID,
  LUMA_RAY2_I2V_PROFILE_DIGEST,
  LUMA_RAY2_I2V_PROFILE_ID,
  LUMA_RAY2_I2V_ROUTE_ID,
} from "./luma-ray2-i2v-compiler.js";
import { createLumaRuntimeVendor, LUMA_RAY2_I2V_JOB_PREFIX } from "./luma-vendor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeVendorInput } from "./types.js";

const REQUESTED = new Set(
  (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
    .toLowerCase()
    .split(/[,\s;]+/gu)
    .filter(Boolean),
);
const WANT_LUMA = REQUESTED.has("luma-i2v") || REQUESTED.has("all");
const PAID_AUTHORIZED = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID === "1";
const API_KEY = process.env.LUMAAI_API_KEY ?? process.env.OPENCLAW_LUMA_API_KEY ?? "";
const INPUT_URL = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_LUMA_I2V_INPUT_URL?.trim() ?? "";
const INPUT_MIME =
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_LUMA_I2V_INPUT_MIME?.trim().toLowerCase() ?? "";
const INPUT_SHA =
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_LUMA_I2V_INPUT_SHA256?.trim().toLowerCase() ?? "";
const MODERATION_URL = process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "";
const LABELING_URL = process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "";
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/gu)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const PROMPT =
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
  "Preserve the first-frame composition while the lighthouse beam moves across the sea.";
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0
    ? REQUESTED_TIMEOUT_MS
    : 300_000;
const POLL_INTERVAL_MS = 5_000;
const RUNTIME_HANDLE = "owner-luma-first-frame";

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const promptLength = Array.from(PROMPT.trim()).length;
const skipReason = !WANT_LUMA
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=luma-i2v to opt in"
  : !PAID_AUTHORIZED
    ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1 to authorize provider spend"
    : !API_KEY
      ? "Luma credentials are not configured"
      : !validHttpsUrl(INPUT_URL)
        ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_LUMA_I2V_INPUT_URL must be owner-provided HTTPS"
        : !/^image\/[a-z0-9.+-]+$/u.test(INPUT_MIME)
          ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_LUMA_I2V_INPUT_MIME must be image/*"
          : !/^[a-f0-9]{64}$/u.test(INPUT_SHA)
            ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_LUMA_I2V_INPUT_SHA256 must be 64 hex characters"
            : promptLength < 3 || promptLength > 5_000
              ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT must be 3 to 5000 Unicode code points"
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
  console.warn(`[openclaw.media-gen-runtime.live:luma-i2v] SKIPPED — ${skipReason}.`);
}

function exactFrozenPlan(): MediaGenRuntimeFrozenPlanV2 {
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
    previewId: `live-luma-i2v-preview-${Date.now()}`,
    presetId: "luma",
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
        sourceDigests: [`sha256:${INPUT_SHA}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: PROMPT,
      narrative: { visualPrompt: PROMPT, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "runtime_local", runtimeLocalRef: RUNTIME_HANDLE },
          authorityRef: `runtime-local:${RUNTIME_HANDLE}`,
          authorityVerified: true,
          mimeType: INPUT_MIME,
          sourceDigest: `sha256:${INPUT_SHA}`,
        },
      ],
      output: {
        durationSec: 5,
        aspectRatio: "16:9",
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
      routeId: LUMA_RAY2_I2V_ROUTE_ID,
      providerId: "luma_dream_machine",
      modelId: LUMA_RAY2_I2V_MODEL_ID,
      endpointId: LUMA_RAY2_I2V_ENDPOINT_ID,
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: LUMA_RAY2_I2V_PROFILE_ID,
      revision: 1,
      digest: LUMA_RAY2_I2V_PROFILE_DIGEST,
    },
    adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "openclaw-live-smoke-runtime", lastSeenAt: frozenAt },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "output.audio"),
      { ...native("compiledPrompt", "prompt"), support: "prompt" },
      {
        intentPath: "references.first_frame.0",
        sourceRef: `runtime-local:${RUNTIME_HANDLE}`,
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

describe.skipIf(!live)("OpenClaw Luma Ray 2 first-frame live runtime smoke", () => {
  it(
    "uses an opaque runtime handle through compliance and canonical Artifact handoff",
    async () => {
      const plan = exactFrozenPlan();
      const source = { providerRef: INPUT_URL, mimeType: INPUT_MIME, sha256: INPUT_SHA };
      const preflight: MediaGenRuntimeVendorInput = {
        taskId: "live-luma-i2v-preflight",
        presetId: "luma",
        mode: "image2video",
        prompt: PROMPT,
        durationSec: 5,
        resolution: "1080p",
        sources: [{ role: "first_frame", ordinal: 0, source }],
        frozenPlan: plan,
      };
      expect(compileLumaRay2I2vRequest(preflight)).toMatchObject({ ok: true });

      let resolverCount = 0;
      let handoffCount = 0;
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async () => {
          throw new Error("Luma I2V live smoke must not redeem an Artifact input");
        },
        handoffArtifact: async ({ output, bytes, sha256 }) => {
          handoffCount += 1;
          expect(bytes.length).toBeGreaterThan(0);
          expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
          return {
            artifactId: `openclaw-live-luma-i2v-${Date.now()}`,
            mimeType: output.mimeType,
            resolution: "1080p",
            sha256,
          };
        },
      };
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge,
        vendors: [
          createLumaRuntimeVendor({
            apiKey: API_KEY,
            baseUrl: process.env.LUMAAI_BASE_URL ?? process.env.OPENCLAW_LUMA_BASE_URL ?? undefined,
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
        resolveRuntimeLocalReference: async ({ runtimeLocalRef, role, ordinal }) => {
          expect(runtimeLocalRef).toBe(RUNTIME_HANDLE);
          expect(role).toBe("first_frame");
          expect(ordinal).toBe(0);
          resolverCount += 1;
          return source;
        },
      });
      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-luma-i2v-${Date.now()}`,
        workspaceId: "openclaw-live-smoke",
        correlationId: `live-luma-i2v-${Date.now()}`,
        presetId: "luma",
        mode: "image2video",
        prompt: PROMPT,
        durationSec: 5,
        resolution: "1080p",
        references: [
          {
            kind: "runtime_local",
            runtimeLocalRef: RUNTIME_HANDLE,
            role: "first_frame",
            ordinal: 0,
          },
        ],
        frozenPlan: plan,
      };
      expect(JSON.stringify(initial)).not.toContain(INPUT_URL);

      let current = await executor.dispatch(initial);
      expect(current.status, current.failureMessage).toBe("processing");
      expect(current.runtimeJobId).toMatch(/^luma-ray2-i2v:/u);
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline && current.status === "processing") {
        await sleep(POLL_INTERVAL_MS);
        current = await executor.dispatch({
          ...initial,
          op: "poll",
          references: undefined,
          runtimeJobId: current.runtimeJobId,
        });
      }

      expect(current.status, current.failureMessage).toBe("succeeded");
      expect(current.runtimeJobId).toMatch(new RegExp(`^${LUMA_RAY2_I2V_JOB_PREFIX}`, "u"));
      expect(resolverCount).toBe(1);
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
        routeId: LUMA_RAY2_I2V_ROUTE_ID,
        adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
        outcome: "succeeded",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
