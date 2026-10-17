import fs from "node:fs/promises";
import path from "node:path";
import { SPATIAL_V2_MAX_TEMP_BYTES } from "./v2-renderer.contract.js";

function disappeared(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Count the private render directory while Chromium and the encoder change it. */
export async function spatialReferenceV2WorkDirBytes(directory: string): Promise<number> {
  const rootBefore = await fs.lstat(directory);
  if (!rootBefore.isDirectory()) throw new Error("spatial_v2_temp_observation_unavailable");
  const walk = async (current: string, root: boolean): Promise<number> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      // A removed child consumes no bytes. Losing the render root or any
      // other observation failure still fails closed.
      if (!root && disappeared(error)) return 0;
      throw error;
    }
    let total = 0;
    for (const entry of entries) {
      const item = path.join(current, entry.name);
      let info;
      try {
        info = await fs.lstat(item);
      } catch (error) {
        if (disappeared(error)) continue;
        throw error;
      }
      if (info.isDirectory()) total += await walk(item, false);
      // Do not follow Chromium profile symlinks outside the private tree.
      else if (info.isFile()) total += info.size;
    }
    return total;
  };
  const bytes = await walk(directory, true);
  const rootAfter = await fs.lstat(directory);
  if (
    !rootAfter.isDirectory() ||
    rootBefore.dev !== rootAfter.dev ||
    rootBefore.ino !== rootAfter.ino
  ) {
    throw new Error("spatial_v2_temp_observation_unavailable");
  }
  return bytes;
}

export function startSpatialReferenceV2TempWatch(params: {
  workDir: string;
  signal: AbortSignal;
  abort: (reason: Error) => void;
}): () => void {
  let stopped = false;
  let sampling = false;
  const sample = async () => {
    if (stopped || sampling || params.signal.aborted) return;
    sampling = true;
    try {
      const bytes = await spatialReferenceV2WorkDirBytes(params.workDir);
      if (!stopped && !params.signal.aborted && bytes > SPATIAL_V2_MAX_TEMP_BYTES) {
        params.abort(new Error("spatial_v2_temp_limit_exceeded"));
      }
    } catch {
      if (!stopped && !params.signal.aborted) {
        params.abort(new Error("spatial_v2_temp_observation_unavailable"));
      }
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => void sample(), 100);
  timer.unref?.();
  void sample();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
