/**
 * Runtime-local media quality gate (OpenMontage-inspired).
 *
 * Runs on the user-runtime face AFTER vendor download and BEFORE Artifact
 * Center handoff. Control API never receives raw ffprobe/ffmpeg output —
 * only productized pass/fail + reason codes.
 *
 * Honest scope (v1):
 * - container duration + stream codec_type metadata (ffprobe);
 * - decoded-frame black ratio via ffmpeg `blackframe`;
 * - NOT a full pixel-perfect decode certification.
 *
 * Probe tools: system `ffprobe` / `ffmpeg` (or injected for tests).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfprobe, type MediaExecOptions } from "../../media/ffmpeg-exec.js";
import type { MediaGenRuntimeResult } from "../media-gen-runtime-http.js";
import {
  runFfmpegCapture,
  type FfmpegCaptureResult,
  type MediaQualityExecOptions,
  type MediaQualityGateMode,
} from "./media-quality-tools.js";

export type MediaQualityReasonCode =
  | "undecodable"
  | "zero_duration"
  | "no_video_stream"
  | "black_frame_dominant"
  | "probe_failed"
  | "tool_missing"
  | "canceled"
  | "timeout";

export type MediaQualityValidationResult =
  | {
      ok: true;
      durationSec?: number;
      hasAudio?: boolean;
      /** When true, decoded-frame black validation was skipped under `on` mode. */
      blackFrameCheckSkipped?: boolean;
    }
  | {
      ok: false;
      code: MediaQualityReasonCode;
      /** Productized message — never raw probe dumps. */
      message: string;
    };

export type MediaQualityValidatorDeps = {
  runFfprobe?: (args: string[], options?: MediaQualityExecOptions) => Promise<string>;
  runFfmpeg?: (args: string[], options?: MediaQualityExecOptions) => Promise<FfmpegCaptureResult>;
  /** Max decoded black-frame ratio before fail (0–1). Default 0.95. */
  blackFrameRatioLimit?: number;
  /** Require at least one audio stream when true. Default false. */
  requireAudio?: boolean;
  /** Probe timeout ms. */
  timeoutMs?: number;
  /**
   * Gate mode for decoded-frame black validation failures:
   * - on: soft-skip with blackFrameCheckSkipped (still fail on clear black frames)
   * - required: any tool/decode failure fails closed
   */
  mode?: Exclude<MediaQualityGateMode, "off">;
};

export type MediaQualityValidateInput = {
  bytes: Buffer;
  mimeType: string;
  signal?: AbortSignal;
};

const DEFAULT_BLACK_RATIO = 0.95;

function extensionForMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime") || m.includes("mov")) return "mov";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "mp4";
}

function parseDurationSec(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * `blackdetect` measures intervals by timestamps, which omits one final frame
 * on low-FPS all-black output. `blackframe` emits one line per decoded black
 * frame plus ffmpeg's final total frame count, so this is frame-accurate.
 */
function parseBlackFrameRatio(stderr: string): number | null {
  const blackFrames = [...stderr.matchAll(/\bframe:\s*\d+\s+pblack:\s*[0-9.]+/gi)].length;
  const totalMatches = [...stderr.matchAll(/\bframe=\s*(\d+)/gi)];
  const lastTotal = totalMatches.at(-1)?.[1];
  const totalFrames = lastTotal ? Number.parseInt(lastTotal, 10) : Number.NaN;
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return null;
  return Math.min(1, blackFrames / totalFrames);
}

function isDecodeError(stderr: string): boolean {
  return /invalid data|error while decoding|could not find codec|nothing was encoded|does not contain any stream|moov atom not found|invalid argument|conversion failed/i.test(
    stderr,
  );
}

function isCanceledError(err: unknown): boolean {
  return err instanceof Error && (err.message === "canceled" || err.message === "cancelled");
}

/**
 * Map quality reason codes to MediaGenRuntimeResult fields.
 * Cancellation is a top-level status, not a failureReason token.
 */
export function mapQualityResultToRuntimeOutcome(quality: MediaQualityValidationResult):
  | { kind: "ok" }
  | {
      kind: "failed";
      failureReason: NonNullable<MediaGenRuntimeResult["failureReason"]>;
      failureMessage: string;
    }
  | { kind: "canceled"; failureMessage: string } {
  if (quality.ok) return { kind: "ok" };
  if (quality.code === "canceled") {
    return { kind: "canceled", failureMessage: quality.message };
  }
  return {
    kind: "failed",
    failureReason: qualityFailureReason(quality.code),
    failureMessage: quality.message,
  };
}

/** Productized failureReason for non-cancel quality rejections. */
export function qualityFailureReason(
  code: Exclude<MediaQualityReasonCode, "canceled">,
): NonNullable<MediaGenRuntimeResult["failureReason"]> {
  // Content/result issues (not auth / not infrastructure).
  if (
    code === "black_frame_dominant" ||
    code === "no_video_stream" ||
    code === "zero_duration" ||
    code === "undecodable"
  ) {
    return "vendor_rejected";
  }
  // tool_missing / probe_failed / timeout → infrastructure.
  return "internal";
}

export function createMediaQualityValidator(
  deps: MediaQualityValidatorDeps = {},
): (input: MediaQualityValidateInput) => Promise<MediaQualityValidationResult> {
  const probe = deps.runFfprobe ?? runFfprobe;
  const ffmpeg = deps.runFfmpeg ?? runFfmpegCapture;
  const blackLimit = deps.blackFrameRatioLimit ?? DEFAULT_BLACK_RATIO;
  const requireAudio = deps.requireAudio === true;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const mode = deps.mode ?? "on";

  return async (input) => {
    if (input.signal?.aborted) {
      return {
        ok: false,
        code: "canceled",
        message: "media quality validation canceled",
      };
    }
    // Images: light path — only require non-empty bytes.
    if (input.mimeType.toLowerCase().startsWith("image/")) {
      if (input.bytes.length === 0) {
        return { ok: false, code: "undecodable", message: "empty image payload" };
      }
      return { ok: true };
    }

    const dir = await mkdtemp(join(tmpdir(), "wisclaw-media-q-"));
    const path = join(dir, `artifact.${extensionForMime(input.mimeType)}`);
    try {
      await writeFile(path, input.bytes);
      const execOpts: MediaQualityExecOptions = {
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      };

      let durationOut: string;
      try {
        durationOut = await probe(
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
          ],
          execOpts,
        );
      } catch (err) {
        if (isCanceledError(err)) {
          return {
            ok: false,
            code: "canceled",
            message: "media quality validation canceled",
          };
        }
        if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
          return {
            ok: false,
            code: "tool_missing",
            message: "ffprobe is not available on this runtime",
          };
        }
        return {
          ok: false,
          code: "undecodable",
          message: "media is not decodable by runtime probe",
        };
      }

      const durationSec = parseDurationSec(durationOut);
      if (durationSec == null) {
        return {
          ok: false,
          code: "probe_failed",
          message: "media duration could not be determined",
        };
      }
      if (durationSec <= 0) {
        return {
          ok: false,
          code: "zero_duration",
          message: "media duration is zero",
        };
      }

      let streamsOut: string;
      try {
        streamsOut = await probe(
          ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
          execOpts,
        );
      } catch (err) {
        if (isCanceledError(err)) {
          return {
            ok: false,
            code: "canceled",
            message: "media quality validation canceled",
          };
        }
        return {
          ok: false,
          code: "undecodable",
          message: "media streams are not readable",
        };
      }
      const streamTypes = streamsOut
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean);
      const hasVideo = streamTypes.some((t) => t === "video" || t.startsWith("video,"));
      const hasAudio = streamTypes.some((t) => t === "audio" || t.startsWith("audio,"));
      if (!hasVideo) {
        return {
          ok: false,
          code: "no_video_stream",
          message: "media has no video stream",
        };
      }
      if (requireAudio && !hasAudio) {
        return {
          ok: false,
          code: "probe_failed",
          message: "media has no audio stream (required by policy)",
        };
      }

      // Decoded-frame black gate. Unlike blackdetect interval timestamps this
      // counts every black frame, including the final frame of low-FPS output.
      let blackFrameCheckSkipped = false;
      try {
        const capture = await ffmpeg(
          [
            "-v",
            "info",
            "-i",
            path,
            "-vf",
            "blackframe=amount=98:threshold=32",
            "-an",
            "-f",
            "null",
            "-",
          ],
          execOpts,
        );

        if (capture.toolMissing) {
          if (mode === "required") {
            return {
              ok: false,
              code: "tool_missing",
              message: "ffmpeg is not available on this runtime",
            };
          }
          blackFrameCheckSkipped = true;
        } else if (capture.exitCode !== 0 && capture.exitCode !== null) {
          if (isDecodeError(capture.stderr)) {
            return {
              ok: false,
              code: "undecodable",
              message: "media failed decode during quality validation",
            };
          }
          if (mode === "required") {
            return {
              ok: false,
              code: "probe_failed",
              message: "ffmpeg black-frame validation failed under required quality gate",
            };
          }
          // `on`: non-decode tool failure — caller records a soft skip.
          blackFrameCheckSkipped = true;
        } else {
          const ratio = parseBlackFrameRatio(capture.stderr);
          if (ratio == null) {
            if (mode === "required") {
              return {
                ok: false,
                code: "probe_failed",
                message: "ffmpeg did not report decoded frame count",
              };
            }
            blackFrameCheckSkipped = true;
          } else if (ratio >= blackLimit) {
            return {
              ok: false,
              code: "black_frame_dominant",
              message: "media is predominantly black frames",
            };
          }
        }
      } catch (err) {
        if (isCanceledError(err)) {
          return {
            ok: false,
            code: "canceled",
            message: "media quality validation canceled",
          };
        }
        if (mode === "required") {
          return {
            ok: false,
            code: "probe_failed",
            message:
              err instanceof Error ? err.message : "ffmpeg black-frame infrastructure failure",
          };
        }
        blackFrameCheckSkipped = true;
      }

      return {
        ok: true,
        durationSec,
        hasAudio,
        ...(blackFrameCheckSkipped ? { blackFrameCheckSkipped: true } : {}),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
