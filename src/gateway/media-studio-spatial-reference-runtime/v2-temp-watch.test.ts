import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPATIAL_V2_MAX_TEMP_BYTES } from "./v2-renderer.contract.js";
import {
  spatialReferenceV2WorkDirBytes,
  startSpatialReferenceV2TempWatch,
} from "./v2-temp-watch.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "spatial-temp-watch-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("private render directory accounting", () => {
  it("counts nested regular files and ignores external profile symlinks", async () => {
    await fs.mkdir(path.join(root, "profile"));
    await fs.writeFile(path.join(root, "frame.png"), Buffer.alloc(17));
    await fs.writeFile(path.join(root, "profile/cache"), Buffer.alloc(23));
    await fs.symlink(os.tmpdir(), path.join(root, "profile/external"));
    expect(await spatialReferenceV2WorkDirBytes(root)).toBe(40);
  });

  it("counts remaining files when an enumerated frame disappears", async () => {
    const frame = path.join(root, "frame.png");
    await fs.writeFile(frame, Buffer.alloc(17));
    await fs.writeFile(path.join(root, "remaining.png"), Buffer.alloc(23));
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (file, options) => {
      if (file === frame) await fs.rm(frame, { force: true });
      return await original(file, options as never);
    });
    expect(await spatialReferenceV2WorkDirBytes(root)).toBe(23);
  });

  it("accepts a child directory removed before its scan", async () => {
    const child = path.join(root, "ephemeral-profile");
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, "cache"), Buffer.alloc(17));
    await fs.writeFile(path.join(root, "frame.png"), Buffer.alloc(23));
    const original = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (directory, options) => {
      if (directory === child) await fs.rm(child, { recursive: true });
      return await original(directory, options as never);
    });
    expect(await spatialReferenceV2WorkDirBytes(root)).toBe(23);
  });

  it("does not disguise a permission failure as an empty file", async () => {
    const file = path.join(root, "frame.png");
    await fs.writeFile(file, Buffer.alloc(17));
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (target === file) throw Object.assign(new Error("permission"), { code: "EACCES" });
      return await original(target, options as never);
    });
    await expect(spatialReferenceV2WorkDirBytes(root)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("fails closed when the root disappears during enumeration", async () => {
    await fs.writeFile(path.join(root, "frame.png"), Buffer.alloc(17));
    const original = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (directory, options) => {
      const entries = await original(directory, options as never);
      if (directory === root) await fs.rm(root, { recursive: true });
      return entries;
    });
    await expect(spatialReferenceV2WorkDirBytes(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the root was already missing", async () => {
    await fs.rm(root, { recursive: true });
    await expect(spatialReferenceV2WorkDirBytes(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed if the render root is replaced during a scan", async () => {
    const retained = `${root}-previous`;
    const original = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (directory, options) => {
      const entries = await original(directory, options as never);
      if (directory === root) {
        await fs.rename(root, retained);
        await fs.mkdir(root);
      }
      return entries;
    });
    try {
      await expect(spatialReferenceV2WorkDirBytes(root)).rejects.toThrow(
        "spatial_v2_temp_observation_unavailable",
      );
    } finally {
      await fs.rm(retained, { recursive: true, force: true });
    }
  });

  it("still aborts when a real file exceeds the unchanged byte limit", async () => {
    const file = path.join(root, "oversize.bin");
    await fs.writeFile(file, "");
    // Sparse file: account its real logical size without allocating the budget.
    await fs.truncate(file, SPATIAL_V2_MAX_TEMP_BYTES + 1);
    let receive!: (reason: Error) => void;
    const failed = new Promise<Error>((resolve) => {
      receive = resolve;
    });
    const stop = startSpatialReferenceV2TempWatch({
      workDir: root,
      signal: new AbortController().signal,
      abort: receive,
    });
    try {
      expect((await failed).message).toBe("spatial_v2_temp_limit_exceeded");
    } finally {
      stop();
    }
  });

  it("does not abort after stop while an old observation finishes", async () => {
    const original = fs.lstat.bind(fs);
    let rejectRead!: (error: Error) => void;
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (file, options) => {
      if (file !== root) return await original(file, options as never);
      entered();
      return await new Promise<never>((_, reject) => {
        rejectRead = reject;
      });
    });
    const abort = vi.fn();
    const stop = startSpatialReferenceV2TempWatch({
      workDir: root,
      signal: new AbortController().signal,
      abort,
    });
    await observed;
    stop();
    rejectRead(Object.assign(new Error("late read"), { code: "ENOENT" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(abort).not.toHaveBeenCalled();
  });
});
