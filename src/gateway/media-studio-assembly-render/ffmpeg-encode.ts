/**
 * Gate 1E — FFmpeg timeline encode for assembly-render.
 *
 * Honesty:
 * - Produces a real MP4 when ffmpeg is available.
 * - Without local source files, synthesizes lavfi color clips per timeline
 *   segment duration (placeholder master length matches timeline, not shot pixels).
 * - Never invents FinalMaster on Control API; only returns encoded bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "../../media/ffmpeg-exec.js";
import type { AssemblyRenderEncodeFn, AssemblyRenderEncodeResult } from "./types.js";

export async function isFfmpegAvailable(
  run: (args: string[]) => Promise<string> = (args) => runFfmpeg(args, { timeoutMs: 5_000 }),
): Promise<boolean> {
  try {
    await run(["-version"]);
    return true;
  } catch {
    return false;
  }
}

export function createFfmpegTimelineEncoder(deps?: {
  runFfmpegImpl?: (args: string[]) => Promise<string>;
  /** Optional: map artifactId → local media path for real concat. */
  resolveLocalSourcePath?: (artifactId: string) => string | null | Promise<string | null>;
  resolution?: string;
}): AssemblyRenderEncodeFn {
  const run = deps?.runFfmpegImpl ?? ((args) => runFfmpeg(args));
  const resolution = deps?.resolution ?? "1280x720";
  const [w, h] = resolution.split("x").map((n) => Number.parseInt(n, 10));
  const size =
    Number.isFinite(w) && Number.isFinite(h) && w! > 0 && h! > 0
      ? `${w}x${h}`
      : "1280x720";

  return async (input) => {
    if (input.timeline.length === 0) {
      throw new Error("empty_timeline");
    }
    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "wisclaw-asm-render-"),
    );
    const outPath = path.join(tmpRoot, `${input.renderId}-${randomUUID().slice(0, 8)}.mp4`);
    try {
      if (input.signal.aborted) {
        throw new Error("cancelled");
      }

      const localPaths: string[] = [];
      if (deps?.resolveLocalSourcePath) {
        for (const row of input.timeline) {
          const p = await deps.resolveLocalSourcePath(row.artifactId);
          if (p) localPaths.push(p);
        }
      }

      let durationSec = 0;
      if (localPaths.length === input.timeline.length && localPaths.length > 0) {
        // Real concat demuxer when every segment resolves locally.
        const listPath = path.join(tmpRoot, "concat.txt");
        const listBody = localPaths
          .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
          .join("\n");
        await fs.writeFile(listPath, listBody, "utf8");
        await run([
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          "-movflags",
          "+faststart",
          outPath,
        ]);
        durationSec = input.timeline.reduce(
          (sum, row) => sum + (row.durationSec ?? 3),
          0,
        );
      } else {
        // Placeholder encode: one color clip per timeline row (duration-honest).
        const segmentPaths: string[] = [];
        for (let i = 0; i < input.timeline.length; i++) {
          if (input.signal.aborted) throw new Error("cancelled");
          const row = input.timeline[i]!;
          const dur = Math.max(0.5, row.durationSec ?? 3);
          durationSec += dur;
          const seg = path.join(tmpRoot, `seg_${i}.mp4`);
          const color = i % 2 === 0 ? "black" : "navy";
          await run([
            "-y",
            "-f",
            "lavfi",
            "-i",
            `color=c=${color}:s=${size}:d=${dur}`,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-t",
            String(dur),
            seg,
          ]);
          segmentPaths.push(seg);
        }
        if (segmentPaths.length === 1) {
          await fs.copyFile(segmentPaths[0]!, outPath);
        } else {
          const listPath = path.join(tmpRoot, "concat.txt");
          const listBody = segmentPaths
            .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
            .join("\n");
          await fs.writeFile(listPath, listBody, "utf8");
          await run([
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            listPath,
            "-c",
            "copy",
            outPath,
          ]);
        }
      }

      if (input.signal.aborted) throw new Error("cancelled");
      const bytes = await fs.readFile(outPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const result: AssemblyRenderEncodeResult = {
        bytes,
        mimeType: "video/mp4",
        durationSec,
        resolution: size,
        codec: "h264",
        sha256,
      };
      return result;
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
