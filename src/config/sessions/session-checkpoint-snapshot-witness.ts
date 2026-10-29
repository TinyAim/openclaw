import { lstatSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";

export type CheckpointSnapshotWitness = {
  size: number;
  device: bigint;
  inode: bigint;
  modifiedNs: bigint;
  changedNs: bigint;
};

function witness(stat: BigIntStats): CheckpointSnapshotWitness | null {
  const size = Number(stat.size);
  return stat.isFile() && Number.isSafeInteger(size) && size >= 0
    ? { size, device: stat.dev, inode: stat.ino, modifiedNs: stat.mtimeNs, changedNs: stat.ctimeNs }
    : null;
}

/** Caller must establish the file's trusted directory and session ownership separately. */
export async function captureCheckpointSnapshotWitness(
  file: string,
): Promise<CheckpointSnapshotWitness | null> {
  try {
    return witness(await lstat(file, { bigint: true }));
  } catch {
    return null;
  }
}

/** Reject a replaced, changed, missing or symlinked snapshot before committing retention. */
export function isCheckpointSnapshotWitnessCurrent(
  file: string,
  expected: CheckpointSnapshotWitness,
): boolean {
  try {
    const actual = witness(lstatSync(file, { bigint: true }));
    return (
      actual !== null &&
      actual.size === expected.size &&
      actual.device === expected.device &&
      actual.inode === expected.inode &&
      actual.modifiedNs === expected.modifiedNs &&
      actual.changedNs === expected.changedNs
    );
  } catch {
    return false;
  }
}

/** Prepare sizes only for snapshots whose session ownership was established by the caller. */
export async function captureOwnedCheckpointSnapshotWitnesses(params: {
  directory: string;
  snapshots: readonly { sessionId: string; file: string }[];
  isOwnedSessionId: (sessionId: string) => boolean;
}): Promise<Map<string, CheckpointSnapshotWitness> | null> {
  const path = await import("node:path");
  const { realpath } = await import("node:fs/promises");
  const { isCompactionCheckpointTranscriptFileName } = await import("./transcript-file-names.js");
  try {
    const root = await realpath(params.directory);
    const result = new Map<string, CheckpointSnapshotWitness>();
    for (const snapshot of params.snapshots) {
      if (
        !/^[A-Za-z0-9._-]+$/u.test(snapshot.sessionId) ||
        !params.isOwnedSessionId(snapshot.sessionId)
      )
        return null;
      const name = path.basename(snapshot.file);
      if (
        name !== `${snapshot.sessionId}.jsonl` &&
        !(
          name.startsWith(`${snapshot.sessionId}.checkpoint.`) &&
          isCompactionCheckpointTranscriptFileName(name)
        )
      )
        return null;
      const actual = await realpath(snapshot.file);
      if (path.dirname(actual) !== root || path.basename(actual) !== name) return null;
      const captured = await captureCheckpointSnapshotWitness(snapshot.file);
      if (!captured || !isCheckpointSnapshotWitnessCurrent(snapshot.file, captured)) return null;
      result.set(snapshot.file, captured);
    }
    return result;
  } catch {
    return null;
  }
}
