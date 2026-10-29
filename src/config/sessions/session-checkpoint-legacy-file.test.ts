import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readOwnedLegacyCheckpoint } from "./session-checkpoint-legacy-file.js";

describe("legacy checkpoint file read", () => {
  it("reads the owned exact boundary and rejects wrong roots, headers, symlinks and oversized files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-file-"));
    try {
      const dir = path.join(root, "owned");
      const other = path.join(root, "other");
      await fs.mkdir(dir);
      await fs.mkdir(other);
      const file = path.join(dir, "session.jsonl");
      const events = [
        { type: "session", id: "session" },
        { type: "message", id: "a", parentId: null },
        { type: "message", id: "b", parentId: "a" },
        { type: "message", id: "other", parentId: "a" },
      ];
      await fs.writeFile(file, events.map((event) => JSON.stringify(event)).join("\n"));
      const params = { directory: dir, file, sessionId: "session", boundaryId: "b" };
      expect(await readOwnedLegacyCheckpoint(params)).toEqual(events.slice(0, 3));
      expect(await readOwnedLegacyCheckpoint({ ...params, directory: other })).toBeNull();
      expect(await readOwnedLegacyCheckpoint({ ...params, maxBytes: 1 })).toBeNull();
      expect(await readOwnedLegacyCheckpoint({ ...params, boundaryId: "missing" })).toBeNull();
      const checkpointFile = path.join(
        dir,
        "session.checkpoint.123e4567-e89b-42d3-a456-426614174000.jsonl",
      );
      await fs.copyFile(file, checkpointFile);
      expect(await readOwnedLegacyCheckpoint({ ...params, file: checkpointFile })).toEqual(
        events.slice(0, 3),
      );
      await fs.symlink(file, path.join(other, "session.jsonl"));
      expect(
        await readOwnedLegacyCheckpoint({
          ...params,
          directory: other,
          file: path.join(other, "session.jsonl"),
        }),
      ).toBeNull();
      await fs.writeFile(file, JSON.stringify({ type: "session", id: "foreign" }));
      expect(await readOwnedLegacyCheckpoint(params)).toBeNull();
      await fs.writeFile(file, `${JSON.stringify(events[0])}\n{broken`);
      expect(await readOwnedLegacyCheckpoint(params)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
