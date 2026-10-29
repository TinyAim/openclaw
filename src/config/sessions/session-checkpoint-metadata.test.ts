import { describe, expect, it } from "vitest";
import {
  readSessionCompactionCheckpoint,
  selectRetainedCompactionCheckpoints,
} from "./session-accessor.sqlite-checkpoint.js";
import type { InternalSessionEntry } from "./types.js";

const checkpoint = {
  checkpointId: "one",
  sessionKey: "agent:main:session",
  sessionId: "window",
  createdAt: 1,
  reason: "manual",
  preCompaction: { sessionId: "window", leafId: "a" },
  postCompaction: { sessionId: "window", leafId: "b" },
};
const entry = (items: unknown[]) => ({ compactionCheckpoints: items }) as InternalSessionEntry;

describe("checkpoint metadata validation", () => {
  it("accepts a single valid checkpoint and leaves unfamiliar token versions untrusted", () => {
    expect(
      readSessionCompactionCheckpoint(entry([{ ...checkpoint, tokensVersion: 99 }]), "one"),
    ).not.toHaveProperty("tokensVersion");
  });
  it("rejects duplicate IDs and malformed stored positions", () => {
    for (const items of [
      [checkpoint, checkpoint],
      [{ ...checkpoint, preCompaction: null }],
      [{ ...checkpoint, postCompaction: { sessionId: "" } }],
      [{ ...checkpoint, tokensBefore: -1 }],
      [{ ...checkpoint, createdAt: -1 }],
      [{ ...checkpoint, tokensAfter: 1.5 }],
      [{ ...checkpoint, reason: "invented" }],
      [null],
    ]) {
      expect(readSessionCompactionCheckpoint(entry(items), "one")).toBeUndefined();
    }
  });
  it("applies the old byte limit newest-first and requires size evidence", () => {
    const old = {
      ...checkpoint,
      checkpointId: "old",
      preCompaction: { ...checkpoint.preCompaction, sessionFile: "/old" },
    } as const;
    const recent = {
      ...checkpoint,
      checkpointId: "recent",
      preCompaction: { ...checkpoint.preCompaction, sessionFile: "/recent" },
    } as const;
    expect(selectRetainedCompactionCheckpoints([old, recent], new Map())).toBeNull();
    expect(
      selectRetainedCompactionCheckpoints(
        [old, recent],
        new Map([
          ["/old", 70 * 1024 * 1024],
          ["/recent", 70 * 1024 * 1024],
        ]),
      ),
    ).toEqual([recent]);
    expect(
      selectRetainedCompactionCheckpoints([old], new Map([["/old", 129 * 1024 * 1024]])),
    ).toEqual([old]);
    expect(selectRetainedCompactionCheckpoints([old], new Map([["/old", -1]]))).toBeNull();
  });
});
