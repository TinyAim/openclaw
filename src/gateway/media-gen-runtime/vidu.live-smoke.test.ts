// CP3-d/CP3-e opt-in LIVE smoke — the Vidu MULTI-REFERENCE runtime chain the
// reviewer asked for: a real `references[]` dispatch → the OpenClaw runtime
// executor resolves each subject slot to bytes → the Vidu vendor maps them onto
// the top-level `images[]` → real render → materializer safety gates → artifact
// handoff. This is the first end-to-end proof that the multi-slot subject path
// (not just text2video) survives the production compliance + materializer gates.
//
// This is NOT a default CI test. It only runs when ALL production-like inputs are
// present (otherwise SKIPPED — a skip is NEVER evidence of live readiness):
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE=vidu          (opt in; comma list / `all` ok)
//   VIDU_API_KEY            (or OPENCLAW_VIDU_API_KEY)
//   OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL    (mirror prod compliance)
//   OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL
//   OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST      (include the Vidu CDN host)
//   OPENCLAW_MEDIA_GEN_LIVE_SMOKE_SUBJECT_IMAGES (>=2 local image paths — the
//                                                 multi-reference subject set)
//
// Requiring the SAME gate set as production (compliance hooks + host allowlist)
// keeps the smoke from proving a WEAKER boundary than the wire enforces; running
// it without them would overclaim, so we skip instead.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createWebhookLabeler, createWebhookModeration } from "./compliance-hooks.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeBridge, MediaGenRuntimeSource } from "./types.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";

const REQUESTED = (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE ?? "")
  .toLowerCase()
  .split(/[,\s;]+/g)
  .filter(Boolean);
const WANT_VIDU = REQUESTED.includes("vidu") || REQUESTED.includes("all");
const API_KEY = process.env.VIDU_API_KEY ?? process.env.OPENCLAW_VIDU_API_KEY ?? "";
const MODERATION_URL = process.env.OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL ?? "";
const LABELING_URL = process.env.OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL ?? "";
const COMPLIANCE_TOKEN = process.env.OPENCLAW_MEDIA_GEN_COMPLIANCE_WEBHOOK_TOKEN;
const ALLOWED_HOSTS = (process.env.OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST ?? "")
  .split(/[,\s;]+/g)
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const SUBJECT_IMAGE_PATHS = (process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_SUBJECT_IMAGES ?? "")
  .split(/[,\s;]+/g)
  .map((p) => p.trim())
  .filter(Boolean);
const REQUESTED_TIMEOUT_MS = Number(process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_TIMEOUT_MS);
const TIMEOUT_MS =
  Number.isFinite(REQUESTED_TIMEOUT_MS) && REQUESTED_TIMEOUT_MS > 0 ? REQUESTED_TIMEOUT_MS : 300000;
const POLL_INTERVAL_MS = 5_000;

const skipReason = !WANT_VIDU
  ? "set OPENCLAW_MEDIA_GEN_LIVE_SMOKE=vidu to opt in"
  : !API_KEY
    ? "Vidu credentials are not configured (VIDU_API_KEY)"
    : !MODERATION_URL
      ? "OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL is not configured"
      : !LABELING_URL
        ? "OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL is not configured"
        : ALLOWED_HOSTS.length === 0
          ? "OPENCLAW_MEDIA_GEN_FETCH_HOST_ALLOWLIST is empty"
          : SUBJECT_IMAGE_PATHS.length < 2
            ? "OPENCLAW_MEDIA_GEN_LIVE_SMOKE_SUBJECT_IMAGES needs >=2 local image paths (the multi-reference set)"
            : "";
const live = skipReason.length === 0;

if (!live) {
  // eslint-disable-next-line no-console
  console.warn(`[openclaw.media-gen-runtime.live:vidu] SKIPPED — ${skipReason}.`);
}

function mimeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("OpenClaw media-generation Vidu multi-reference live runtime smoke", () => {
  it(
    "resolves references[] to subject sources, maps them onto Vidu images[], and materializes an artifact",
    async () => {
      // The bridge resolves each reference slot to REAL bytes (artifactId == the
      // operator-provided local path). It tracks resolutions so we can assert the
      // FULL multi-slot set crossed the runtime, never silently collapsed to one.
      const resolvedRoles: string[] = [];
      const bridge: MediaGenRuntimeBridge = {
        runtimeId: "openclaw-live-smoke-runtime",
        register: async () => undefined,
        resolveArtifactReference: async ({ artifactId, role }): Promise<MediaGenRuntimeSource> => {
          resolvedRoles.push(role ?? "subject");
          return { bytes: readFileSync(artifactId), mimeType: mimeForPath(artifactId) };
        },
        handoffArtifact: async ({ output, bytes, sha256 }) => ({
          artifactId: `openclaw-live-vidu-${Date.now()}`,
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
      expect(vendor.isConfigured()).toBe(true);
      expect(vendor.supportsMultiReference).toBe(true);

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

      const initial: MediaGenRuntimeDispatch = {
        op: "submit",
        taskId: `live-vidu-${Date.now()}`,
        workspaceId: "openclaw-live-smoke",
        correlationId: `live-vidu-${Date.now()}`,
        presetId: "vidu",
        mode: "image2video",
        prompt:
          process.env.OPENCLAW_MEDIA_GEN_LIVE_SMOKE_PROMPT ??
          "Keep the subject identity consistent across a gentle cinematic pan.",
        durationSec: 5,
        // The multi-reference subject set — one role-scoped slot per image.
        references: SUBJECT_IMAGE_PATHS.map((path, index) => ({
          kind: "artifact" as const,
          artifactId: path,
          role: "subject" as const,
          ordinal: index,
        })),
      };

      const submitted = await executor.dispatch(initial);
      expect(submitted.status, submitted.failureMessage).toBe("processing");
      expect(submitted.runtimeJobId).toBeTruthy();
      // Every subject slot was resolved — the multi-reference set was NOT collapsed.
      expect(resolvedRoles).toHaveLength(SUBJECT_IMAGE_PATHS.length);
      expect(resolvedRoles.every((role) => role === "subject")).toBe(true);

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
