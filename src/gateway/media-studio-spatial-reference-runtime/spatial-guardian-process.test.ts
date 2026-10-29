import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectSpatialPosixScopeExtinction,
  observePosixScopeExtinction,
  observeGuardianOwnedWorkerSpawn,
  processGroupId,
} from "./spatial-guardian-process.js";

const missing = () => {
  throw Object.assign(new Error("absent"), { code: "ESRCH" });
};
const worker = { pid: 8123, startTime: 100 };
afterEach(() => {
  vi.useRealTimers();
});

describe("private original POSIX process-group extinction", () => {
  it("requires fresh negative-group and positive-root ESRCH, then checks the group again", () => {
    const probe = vi.fn(missing),
      readStart = vi.fn(() => null);
    expect(inspectSpatialPosixScopeExtinction(worker, worker.pid, { probe, readStart })).toEqual({
      protocol: "posix_group_observation_v1",
      processGroupId: worker.pid,
      rootState: "dead",
    });
    expect(probe.mock.calls.map(([pid]) => pid)).toEqual([-worker.pid, worker.pid, -worker.pid]);
    expect(readStart).not.toHaveBeenCalled();
  });
  it("a surviving group member blocks extinction even after the original root exits", () => {
    const probe = vi.fn((pid: number) => {
      if (pid > 0) missing();
    });
    expect(
      inspectSpatialPosixScopeExtinction(worker, worker.pid, { probe, readStart: () => null }),
    ).toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });
  it.each(["EPERM", "EACCES", "EIO", undefined])(
    "group probe %s is unknown, never empty",
    (code) => {
      const probe = () => {
        throw Object.assign(new Error("unknown"), { code });
      };
      expect(
        inspectSpatialPosixScopeExtinction(worker, worker.pid, { probe, readStart: () => null }),
      ).toBeUndefined();
    },
  );
  it("a root permission failure remains unknown even if both group probes could be empty", () => {
    const probe = (pid: number) => {
      if (pid < 0) missing();
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    expect(
      inspectSpatialPosixScopeExtinction(worker, worker.pid, { probe, readStart: () => 101 }),
    ).toBeUndefined();
  });
  it("a live root needs a successful fresh differing start identity before it can be called reused", () => {
    const probe = (pid: number) => {
      if (pid < 0) missing();
    };
    for (const start of [null, 100, NaN, -1]) {
      expect(
        inspectSpatialPosixScopeExtinction(worker, worker.pid, { probe, readStart: () => start }),
      ).toBeUndefined();
    }
    expect(
      inspectSpatialPosixScopeExtinction(worker, worker.pid, { probe, readStart: () => 101 }),
    ).toMatchObject({ rootState: "reused" });
  });
  it("group reuse between the root and final group probe blocks the former empty observation", () => {
    let calls = 0;
    const probe = () => {
      if (++calls < 3) missing();
    };
    expect(
      inspectSpatialPosixScopeExtinction(worker, worker.pid, { probe, readStart: () => null }),
    ).toBeUndefined();
  });
  it("invalid identities cannot issue broadcast or unrelated-group probes", () => {
    const probe = vi.fn(missing);
    for (const pgid of [-1, 0, 1, 9999, NaN]) {
      expect(
        inspectSpatialPosixScopeExtinction(worker, pgid, { probe, readStart: () => null }),
      ).toBeUndefined();
    }
    expect(probe).not.toHaveBeenCalled();
  });
  it("unknown samples stop at the original ten-second deadline with fifty-millisecond cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const probe = vi.fn(() => {});
    const result = observePosixScopeExtinction(worker, worker.pid, {
      probe,
      readStart: () => null,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeUndefined();
    expect(Date.now()).toBe(10_000);
    expect(probe).toHaveBeenCalledTimes(200);
  });
  it("a probe crossing the deadline cannot deliver late success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const probe = (pid: number) => {
      if (pid < 0) missing();
    };
    await expect(
      observePosixScopeExtinction(worker, worker.pid, {
        probe,
        readStart: () => {
          vi.setSystemTime(10_001);
          return 101;
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("actual isolated POSIX group probes", () => {
  it("takes PGID only from a successful trusted detached native spawn and agrees with a direct OS getpgid syscall", async () => {
    const code = `const {spawnSync}=require('node:child_process');const r=spawnSync('/usr/bin/python3',['-c','import os; print(os.getpgid(os.getppid()))'],{encoding:'utf8'});process.send({pgid:Number(r.stdout.trim())});setTimeout(()=>{},10000);`;
    const child = spawn(process.execPath, ["-e", code], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const receiptPromise = observeGuardianOwnedWorkerSpawn(child, true);
      const [message] = (await once(child, "message")) as [{ pgid: number }];
      const receipt = await receiptPromise;
      expect(receipt.child).toBe(child);
      expect(receipt.pid).toBe(child.pid);
      expect(message.pgid).toBe(child.pid);
      expect(processGroupId(receipt)).toBe(message.pgid);
      expect(processGroupId({ pid: child.pid, child } as never)).toBeUndefined();
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  it("rejects an arbitrary PID/object, non-detached request, and failed spawn without a native receipt", async () => {
    await expect(
      observeGuardianOwnedWorkerSpawn({ pid: process.pid } as never, true),
    ).rejects.toThrow("spatial_guardian_posix_scope_unavailable");
    await expect(observeGuardianOwnedWorkerSpawn(new ChildProcess(), false)).rejects.toThrow(
      "spatial_guardian_posix_scope_unavailable",
    );
    const child = spawn(process.execPath, ["-e", "0"], {
      detached: true,
      cwd: "/nonexistent/wisclaw-spatial-test-owned-dir",
      stdio: "ignore",
    });
    await expect(observeGuardianOwnedWorkerSpawn(child, true)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("proves an actual exited detached child group empty", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),30)"], {
      detached: true,
      stdio: "ignore",
    });
    await once(child, "exit");
    expect(child.pid).toBeTypeOf("number");
    expect(
      inspectSpatialPosixScopeExtinction({ pid: child.pid!, startTime: 0 }, child.pid!),
    ).toMatchObject({ rootState: "dead" });
  });
  it("retains the original root group obligation when its real descendant outlives it", async () => {
    const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});process.send({descendant:c.pid});setTimeout(()=>process.exit(0),30);`;
    const root = spawn(process.execPath, ["-e", code], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const [message] = (await once(root, "message")) as [{ descendant: number }];
      await once(root, "exit");
      expect(() => process.kill(message.descendant, 0)).not.toThrow();
      const identity = { pid: root.pid!, startTime: 0 };
      expect(inspectSpatialPosixScopeExtinction(identity, root.pid!)).toBeUndefined();
      process.kill(-root.pid!, "SIGTERM");
      await expect(observePosixScopeExtinction(identity, root.pid!)).resolves.toMatchObject({
        rootState: "dead",
      });
    } finally {
      try {
        process.kill(-root.pid!, "SIGKILL");
      } catch {
        /* the exact test-owned group has exited */
      }
    }
  }, 12_000);
});
