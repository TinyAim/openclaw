// Opt-in paid live smoke for the exact Veo 3.1 first-frame route.
// A skipped run is never live-readiness evidence. Execution requires:
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=veo-i2v (or all)
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1
//   VERTEX_AI_PROJECT_ID (or GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT)
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_FILE=/absolute/path/to/frame.png
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_MIME=image/png|image/jpeg
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_SHA256=<64 lowercase hex>
//   moderation + labeling webhooks and a non-empty output host allow-list.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import { createGoogleCloudAccessTokenProvider } from "./google-cloud-auth.js";
import type { MediaGenRuntimeBridge } from "./types.js";
import {
  createVeoRuntimeVendor,
  googleCloudProjectIdValid,
  VEO31_I2V_JOB_PREFIX,
} from "./veo-vendor.js";
import {
  VEO31_I2V_ADAPTER_REVISION,
  VEO31_I2V_ENDPOINT_ID,
  VEO31_I2V_MODEL_ID,
  VEO31_I2V_PROFILE_DIGEST,
  VEO31_I2V_PROFILE_ID,
  VEO31_I2V_ROUTE_ID,
} from "./veo3-1-i2v-compiler.js";

const REQUESTED = new Set(
  (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
    .toLowerCase()
    .split(/[,\s;]+/gu)
    .filter(Boolean),
);
const WANT_VEO_I2V = REQUESTED.has("veo-i2v") || REQUESTED.has("all");
const PAID_AUTHORIZED = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID === "1";
const PROJECT_ID = (
  process.env.VERTEX_AI_PROJECT_ID ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT ??
  ""
).trim();
const INPUT_FILE = process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_FILE?.trim() ?? "";
const INPUT_MIME =
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_MIME?.trim().toLowerCase() ?? "";
const INPUT_SHA =
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_SHA256?.trim().toLowerCase() ?? "";
const MODERATION_URL = process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "";
const LABELING_URL = process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "";
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/gu)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const PROMPT =
  process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
  "Preserve the first-frame composition while the paper lantern drifts forward slowly.";
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0
    ? REQUESTED_TIMEOUT_MS
    : 600_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const INPUT_ARTIFACT_ID = "live-veo-i2v-first-frame";

function inputFileProblem(filePath: string): string {
  if (!filePath || !isAbsolute(filePath)) {
    return "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_FILE must be an absolute path";
  }
  try {
    if (!existsSync(filePath)) {
      return "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_FILE does not exist";
    }
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_FILE must be a non-empty file";
    }
    if (stat.size > MAX_INPUT_BYTES) {
      return "the Veo live first frame exceeds the official 20 MB limit";
    }
  } catch {
    return "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_FILE is not readable";
  }
  return "";
}

function bytesMatchMime(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    mimeType === "image/png" &&
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

const projectIdValid = googleCloudProjectIdValid(PROJECT_ID);
const fileProblem =
  WANT_VEO_I2V && PAID_AUTHORIZED && projectIdValid ? inputFileProblem(INPUT_FILE) : "";
const skipReason = !WANT_VEO_I2V
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=veo-i2v to opt in"
  : !PAID_AUTHORIZED
    ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PAID=1 to authorize provider spend"
    : !projectIdValid
      ? "a valid Vertex AI project id is not configured"
      : fileProblem
        ? fileProblem
        : INPUT_MIME !== "image/jpeg" && INPUT_MIME !== "image/png"
          ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_MIME must be image/jpeg or image/png"
          : !/^[a-f0-9]{64}$/u.test(INPUT_SHA)
            ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_VEO_I2V_INPUT_SHA256 must be 64 lowercase hex characters"
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
  console.warn(`[openclaw.media-gen-runtime.live:veo-i2v] SKIPPED — ${skipReason}.`);
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
    previewId: `live-veo-i2v-preview-${Date.now()}`,
    presetId: "veo",
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
          source: { kind: "artifact", artifactId: INPUT_ARTIFACT_ID },
          assetRefId: INPUT_ARTIFACT_ID,
          authorityRef: `artifact:${INPUT_ARTIFACT_ID}`,
          authorityVerified: true,
          mimeType: INPUT_MIME,
          sourceDigest: `sha256:${INPUT_SHA}`,
        },
      ],
      output: {
        durationSec: 6,
        aspectRatio: "16:9",
        resolution: "720p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: VEO31_I2V_ROUTE_ID,
      providerId: "google_vertex_ai",
      modelId: VEO31_I2V_MODEL_ID,
      endpointId: VEO31_I2V_ENDPOINT_ID,
      region: "us-central1",
      accountTier: "adc",
    },
    capabilityProfileRef: {
      profileId: VEO31_I2V_PROFILE_ID,
      revision: 1,
      digest: VEO31_I2V_PROFILE_DIGEST,
    },
    adapterRevision: VEO31_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "openclaw-live-smoke-runtime", lastSeenAt: frozenAt },
    constraintPlan: [
      native("generationScenario", "scenario"),
      native("outputAudioPolicy", "output.audio"),
      { ...native("compiledPrompt", "prompt"), support: "prompt" },
      {
        intentPath: "references.first_frame.0",
        sourceRef: `artifact:${INPUT_ARTIFACT_ID}`,
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

describe.skipIf(!live)("OpenClaw Veo 3.1 first-frame live runtime smoke", () => {
  it(
    "redeems an opaque Artifact through ADC, compliance, and canonical handoff",
    async () => {
      let resolverCount = 0;
      let handoffCount = 0;
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async ({ artifactId, role }) => {
          expect(artifactId).toBe(INPUT_ARTIFACT_ID);
          expect(role).toBe("first_frame");
          const bytes = readFileSync(INPUT_FILE);
          expect(bytesMatchMime(bytes, INPUT_MIME)).toBe(true);
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(INPUT_SHA);
          resolverCount += 1;
          return { bytes, mimeType: INPUT_MIME, sha256: INPUT_SHA };
        },
        handoffArtifact: async ({ output, bytes, sha256 }) => {
          handoffCount += 1;
          expect(bytes.length).toBeGreaterThan(0);
          expect(output.mimeType).toBe("video/mp4");
          expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
          return {
            artifactId: `openclaw-live-veo-i2v-${Date.now()}`,
            mimeType: output.mimeType,
            resolution: "720p",
            sha256,
          };
        },
      };
      const executor = createOpenClawMediaGenRuntimeExecutor({
        bridge,
        vendors: [
          createVeoRuntimeVendor({
            projectId: PROJECT_ID,
            accessTokenProvider: createGoogleCloudAccessTokenProvider(),
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
      const plan = exactFrozenPlan();
      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-veo-i2v-${Date.now()}`,
        workspaceId: "openclaw-live-smoke",
        correlationId: `live-veo-i2v-${Date.now()}`,
        presetId: "veo",
        mode: "image2video",
        prompt: PROMPT,
        durationSec: 6,
        resolution: "720p",
        references: [
          {
            kind: "artifact",
            artifactId: INPUT_ARTIFACT_ID,
            role: "first_frame",
            ordinal: 0,
          },
        ],
        frozenPlan: plan,
      };
      expect(JSON.stringify(plan)).not.toContain(INPUT_FILE);
      expect(JSON.stringify(initial)).not.toContain(INPUT_FILE);

      let current = await executor.dispatch(initial);
      expect(current.status, current.failureMessage).toBe("processing");
      expect(current.runtimeJobId).toMatch(new RegExp(`^${VEO31_I2V_JOB_PREFIX}`, "u"));
      expect(current.providerObservation).toMatchObject({
        routeId: VEO31_I2V_ROUTE_ID,
        adapterRevision: VEO31_I2V_ADAPTER_REVISION,
        operation: "submit",
        outcome: "processing",
      });
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline && current.status === "processing") {
        await sleep(POLL_INTERVAL_MS);
        current = await executor.dispatch({
          op: "poll",
          taskId: initial.taskId,
          workspaceId: initial.workspaceId,
          correlationId: `live-veo-i2v-poll-${Date.now()}`,
          presetId: "veo",
          mode: "image2video",
          runtimeJobId: current.runtimeJobId,
        });
      }

      expect(current.status, current.failureMessage).toBe("succeeded");
      expect(current.runtimeJobId).toMatch(new RegExp(`^${VEO31_I2V_JOB_PREFIX}`, "u"));
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
        routeId: VEO31_I2V_ROUTE_ID,
        adapterRevision: VEO31_I2V_ADAPTER_REVISION,
        outcome: "succeeded",
        qualityOutcome: "not_run",
      });
    },
    TIMEOUT_MS + 30_000,
  );
});
