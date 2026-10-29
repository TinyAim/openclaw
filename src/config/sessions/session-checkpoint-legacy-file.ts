import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCheckpointBoundaryPath } from "./session-checkpoint-boundary.js";
import { isCompactionCheckpointTranscriptFileName } from "./transcript-file-names.js";

/** Read a legacy snapshot only after the caller has verified the session's owner. */
export async function readOwnedLegacyCheckpoint(params: {
  directory: string;
  file: string;
  sessionId: string;
  boundaryId: string;
  maxBytes?: number;
}): Promise<Record<string, unknown>[] | null> {
  if (!/^[A-Za-z0-9._-]+$/u.test(params.sessionId) || !params.boundaryId.trim()) return null;
  const name = path.basename(params.file);
  if (
    name !== `${params.sessionId}.jsonl` &&
    !(
      name.startsWith(`${params.sessionId}.checkpoint.`) &&
      isCompactionCheckpointTranscriptFileName(name)
    )
  )
    return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const root = await fs.realpath(params.directory);
    const resolved = await fs.realpath(params.file);
    if (path.dirname(resolved) !== root || path.basename(resolved) !== name) return null;
    handle = await fs.open(params.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const current = await fs.stat(resolved);
    const maxBytes = params.maxBytes ?? 64 * 1024 * 1024;
    if (
      !opened.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size <= 0 ||
      opened.size > maxBytes
    )
      return null;
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      return null;
    const content = bytes.subarray(0, length).toString("utf8");
    const events = content
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    const header = events[0];
    if (
      !header ||
      typeof header !== "object" ||
      Array.isArray(header) ||
      (header as Record<string, unknown>).type !== "session" ||
      (header as Record<string, unknown>).id !== params.sessionId
    )
      return null;
    const selected = resolveCheckpointBoundaryPath(events.slice(1), params.boundaryId);
    if (
      !selected ||
      selected.some((event) => !event || typeof event !== "object" || Array.isArray(event))
    )
      return null;
    return [header as Record<string, unknown>, ...(selected as Record<string, unknown>[])];
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
