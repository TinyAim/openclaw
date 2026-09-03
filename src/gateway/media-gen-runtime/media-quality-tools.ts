import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { MediaExecOptions } from "../../media/ffmpeg-exec.js";

const execFileAsync = promisify(execFile);

export type MediaQualityGateMode = "off" | "on" | "required";

export type FfmpegCaptureResult = {
  stdout: string;
  stderr: string;
  /** null when the process did not produce an exit code (spawn/signal). */
  exitCode: number | null;
  /** True when the binary itself was missing (ENOENT). */
  toolMissing?: boolean;
};

export type MediaQualityExecOptions = MediaExecOptions & { signal?: AbortSignal };

export function parseMediaQualityGateMode(
  raw: string | undefined,
): MediaQualityGateMode | { invalid: true; value: string } {
  const value = (raw ?? "off").trim().toLowerCase();
  if (value === "" || value === "off" || value === "0" || value === "false") {
    return "off";
  }
  if (value === "on" || value === "1" || value === "true") return "on";
  if (value === "required") return "required";
  return { invalid: true, value: raw ?? "" };
}

/**
 * Capture ffmpeg stdout+stderr AND exit code. Never treats non-zero exit as
 * silent success — callers decide hard-fail vs soft-skip by gate mode.
 */
export async function runFfmpegCapture(
  args: string[],
  options?: MediaQualityExecOptions,
): Promise<FfmpegCaptureResult> {
  if (options?.signal?.aborted) throw new Error("canceled");
  try {
    const { stdout, stderr } = await execFileAsync("ffmpeg", args, {
      timeout: options?.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
      ...(options?.signal ? { signal: options.signal } : {}),
      killSignal: "SIGTERM",
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
  } catch (err) {
    if (err && typeof err === "object") {
      const e = err as {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        message?: string;
        name?: string;
        code?: string | number;
        killed?: boolean;
        signal?: string;
      };
      if (options?.signal?.aborted || e.name === "AbortError" || e.code === "ABORT_ERR") {
        throw new Error("canceled");
      }
      if (e.code === "ENOENT") {
        return {
          stdout: "",
          stderr: String(e.message ?? "ffmpeg not found"),
          exitCode: null,
          toolMissing: true,
        };
      }
      return {
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? e.message ?? ""),
        exitCode: typeof e.code === "number" ? e.code : e.killed || e.signal ? null : 1,
      };
    }
    throw err;
  }
}

/** Synchronous bootstrap probe used to block `required` registration safely. */
export function probeMediaQualityToolsAvailableSync():
  | { ok: true }
  | { ok: false; missing: string[] } {
  const missing: string[] = [];
  for (const bin of ["ffprobe", "ffmpeg"] as const) {
    const result = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 5_000 });
    if (result.error || result.status !== 0) missing.push(bin);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** Async variant for tests and long-running health checks. */
export async function probeMediaQualityToolsAvailable(deps?: {
  runFfprobeVersion?: () => Promise<void>;
  runFfmpegVersion?: () => Promise<void>;
}): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  const ffprobe =
    deps?.runFfprobeVersion ??
    (() =>
      execFileAsync("ffprobe", ["-version"], { timeout: 5_000, maxBuffer: 256 * 1024 }).then(
        () => undefined,
      ));
  const ffmpeg =
    deps?.runFfmpegVersion ??
    (() =>
      execFileAsync("ffmpeg", ["-version"], { timeout: 5_000, maxBuffer: 256 * 1024 }).then(
        () => undefined,
      ));
  try {
    await ffprobe();
  } catch {
    missing.push("ffprobe");
  }
  try {
    await ffmpeg();
  } catch {
    missing.push("ffmpeg");
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
