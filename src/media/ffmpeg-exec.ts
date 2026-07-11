import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import {
  MEDIA_FFMPEG_MAX_BUFFER_BYTES,
  MEDIA_FFMPEG_TIMEOUT_MS,
  MEDIA_FFPROBE_TIMEOUT_MS,
} from "./ffmpeg-limits.js";

const execFileAsync = promisify(execFile);

export type MediaExecOptions = {
  timeoutMs?: number;
  maxBufferBytes?: number;
  /**
   * When aborted, Node kills the child with killSignal (default SIGTERM).
   * Assembly-render cancel paths should pass the job AbortSignal so in-flight
   * FFmpeg is terminated rather than only checked between segments.
   */
  signal?: AbortSignal;
  killSignal?: NodeJS.Signals | number;
};

function resolveExecOptions(
  defaultTimeoutMs: number,
  options: MediaExecOptions | undefined,
): ExecFileOptions {
  return {
    timeout: options?.timeoutMs ?? defaultTimeoutMs,
    maxBuffer: options?.maxBufferBytes ?? MEDIA_FFMPEG_MAX_BUFFER_BYTES,
    ...(options?.signal ? { signal: options.signal } : {}),
    killSignal: options?.killSignal ?? "SIGTERM",
  };
}

export async function runFfprobe(args: string[], options?: MediaExecOptions): Promise<string> {
  if (options?.signal?.aborted) {
    throw new Error("cancelled");
  }
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      args,
      resolveExecOptions(MEDIA_FFPROBE_TIMEOUT_MS, options),
    );
    return stdout.toString();
  } catch (err) {
    if (options?.signal?.aborted || isAbortError(err)) {
      throw new Error("cancelled");
    }
    throw err;
  }
}

export async function runFfmpeg(args: string[], options?: MediaExecOptions): Promise<string> {
  if (options?.signal?.aborted) {
    throw new Error("cancelled");
  }
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      args,
      resolveExecOptions(MEDIA_FFMPEG_TIMEOUT_MS, options),
    );
    return stdout.toString();
  } catch (err) {
    if (options?.signal?.aborted || isAbortError(err)) {
      throw new Error("cancelled");
    }
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  return (
    e.name === "AbortError" ||
    e.code === "ABORT_ERR" ||
    (typeof e.message === "string" && /abort/i.test(e.message))
  );
}

export function parseFfprobeCsvFields(stdout: string, maxFields: number): string[] {
  return stdout
    .trim()
    .toLowerCase()
    .split(/[,\r\n]+/, maxFields)
    .map((field) => field.trim());
}

export function parseFfprobeCodecAndSampleRate(stdout: string): {
  codec: string | null;
  sampleRateHz: number | null;
} {
  const [codecRaw, sampleRateRaw] = parseFfprobeCsvFields(stdout, 2);
  const codec = codecRaw ? codecRaw : null;
  const sampleRate = sampleRateRaw ? Number.parseInt(sampleRateRaw, 10) : Number.NaN;
  return {
    codec,
    sampleRateHz: Number.isFinite(sampleRate) ? sampleRate : null,
  };
}
