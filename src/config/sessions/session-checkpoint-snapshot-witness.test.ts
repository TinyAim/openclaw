import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureCheckpointSnapshotWitness,
  captureOwnedCheckpointSnapshotWitnesses,
  isCheckpointSnapshotWitnessCurrent,
} from "./session-checkpoint-snapshot-witness.js";

describe("checkpoint snapshot witness", () => {
  it("rejects content changes, replacement, missing files and symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-witness-"));
    try {
      const file = path.join(root, "snapshot");
      await fs.writeFile(file, "old");
      const initial = await captureCheckpointSnapshotWitness(file);
      expect(initial).not.toBeNull();
      expect(isCheckpointSnapshotWitnessCurrent(file, initial!)).toBe(true);
      await fs.writeFile(file, "changed");
      expect(isCheckpointSnapshotWitnessCurrent(file, initial!)).toBe(false);
      const beforeReplacement = await captureCheckpointSnapshotWitness(file);
      const replacement = path.join(root, "replacement");
      await fs.writeFile(replacement, "changed");
      await fs.rename(replacement, file);
      expect(isCheckpointSnapshotWitnessCurrent(file, beforeReplacement!)).toBe(false);
      await fs.unlink(file);
      expect(isCheckpointSnapshotWitnessCurrent(file, beforeReplacement!)).toBe(false);
      await fs.symlink(path.join(root, "absent"), file);
      expect(await captureCheckpointSnapshotWitness(file)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("requires a trusted directory, matching session filename and owner decision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-owned-"));
    try {
      const owned = path.join(root, "owned");
      const other = path.join(root, "other");
      await fs.mkdir(owned);
      await fs.mkdir(other);
      const file = path.join(owned, "session.jsonl");
      await fs.writeFile(file, "snapshot");
      const params = {
        directory: owned,
        snapshots: [{ sessionId: "session", file }],
        isOwnedSessionId: (id: string) => id === "session",
      };
      expect((await captureOwnedCheckpointSnapshotWitnesses(params))?.get(file)?.size).toBe(8);
      expect(
        await captureOwnedCheckpointSnapshotWitnesses({ ...params, directory: other }),
      ).toBeNull();
      expect(
        await captureOwnedCheckpointSnapshotWitnesses({ ...params, isOwnedSessionId: () => false }),
      ).toBeNull();
      expect(
        await captureOwnedCheckpointSnapshotWitnesses({
          ...params,
          snapshots: [{ sessionId: "foreign", file }],
        }),
      ).toBeNull();
      const link = path.join(
        owned,
        "session.checkpoint.123e4567-e89b-42d3-a456-426614174000.jsonl",
      );
      await fs.symlink(file, link);
      expect(
        await captureOwnedCheckpointSnapshotWitnesses({
          ...params,
          snapshots: [{ sessionId: "session", file: link }],
        }),
      ).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
