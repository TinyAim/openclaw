import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  type FileEntry,
} from "@mariozechner/pi-coding-agent";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../../agents/tool-call-id.js";
import { formatSessionArchiveTimestamp } from "../../config/sessions.js";

type JsonRecord = Record<string, unknown>;

type ParsedSessionHeader = JsonRecord & {
  type: "session";
  id: string;
};

type ParsedSessionEntry = JsonRecord & {
  type: string;
  id: string;
  parentId: string | null;
};

export class SessionTranscriptCompactError extends Error {
  constructor(
    readonly kind: "malformed" | "io",
    message: string,
  ) {
    super(message);
    this.name = "SessionTranscriptCompactError";
  }
}

export type SessionTranscriptCompactResult = {
  compacted: boolean;
  kept: number;
  archived?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function malformed(message: string): never {
  throw new SessionTranscriptCompactError("malformed", message);
}

function parseJsonLinesStrict(raw: string): JsonRecord[] {
  const parsed: JsonRecord[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed(`invalid JSON at transcript line ${index + 1}`);
    }
    if (!isRecord(value)) {
      malformed(`transcript line ${index + 1} is not an object`);
    }
    parsed.push(value);
  }
  if (parsed.length === 0) {
    malformed("transcript is empty");
  }
  return parsed;
}

function normalizeAndValidateTranscript(params: { raw: string; sessionId: string }): {
  header: ParsedSessionHeader;
  entries: ParsedSessionEntry[];
} {
  const parsed = parseJsonLinesStrict(params.raw);
  const first = parsed[0];
  if (first?.type !== "session" || typeof first.id !== "string" || !first.id.trim()) {
    malformed("transcript does not start with a valid session header");
  }
  if (first.id !== params.sessionId) {
    malformed("transcript session header does not match the requested session");
  }
  if (
    first.version !== undefined &&
    (typeof first.version !== "number" || !Number.isInteger(first.version) || first.version < 1)
  ) {
    malformed("transcript session header has an invalid version");
  }

  // Preserve native compatibility with older valid Pi transcripts. Migration is
  // performed in memory and only persisted if this request actually compacts.
  migrateSessionEntries(parsed as unknown as FileEntry[]);
  const header = parsed[0] as ParsedSessionHeader;
  header.version = CURRENT_SESSION_VERSION;
  header.timestamp =
    typeof header.timestamp === "string" && header.timestamp.trim()
      ? header.timestamp
      : new Date().toISOString();
  header.cwd = typeof header.cwd === "string" ? header.cwd : "";

  const entries: ParsedSessionEntry[] = [];
  const byId = new Map<string, ParsedSessionEntry>();
  for (let index = 1; index < parsed.length; index += 1) {
    const candidate = parsed[index];
    if (candidate.type === "session") {
      malformed(`unexpected second session header at transcript entry ${index + 1}`);
    }
    if (typeof candidate.type !== "string" || !candidate.type.trim()) {
      malformed(`transcript entry ${index + 1} has no type`);
    }
    if (typeof candidate.id !== "string" || !candidate.id.trim()) {
      malformed(`transcript entry ${index + 1} has no id`);
    }
    if (byId.has(candidate.id)) {
      malformed(`transcript entry ${index + 1} has a duplicate id`);
    }
    if (candidate.parentId !== null && typeof candidate.parentId !== "string") {
      malformed(`transcript entry ${index + 1} has an invalid parentId`);
    }
    if (typeof candidate.parentId === "string" && !byId.has(candidate.parentId)) {
      malformed(`transcript entry ${index + 1} references a missing or later parent`);
    }
    if (candidate.type === "message") {
      if (!isRecord(candidate.message) || typeof candidate.message.role !== "string") {
        malformed(`message entry ${index + 1} has an invalid message body`);
      }
    }
    const entry = candidate as ParsedSessionEntry;
    entries.push(entry);
    byId.set(entry.id, entry);
  }

  validateEntryReferences(entries, byId);
  validateToolResultLineage(entries, byId);
  return { header, entries };
}

function requireExistingReference(params: {
  entry: ParsedSessionEntry;
  field: "firstKeptEntryId" | "fromId" | "targetId";
  byId: Map<string, ParsedSessionEntry>;
}): string {
  const value = params.entry[params.field];
  if (typeof value !== "string" || !value || !params.byId.has(value)) {
    malformed(`${params.entry.type} entry ${params.entry.id} has an invalid ${params.field}`);
  }
  return value;
}

function referenceIsOnParentLineage(params: {
  entry: ParsedSessionEntry;
  referenceId: string;
  byId: Map<string, ParsedSessionEntry>;
}): boolean {
  let parentId = params.entry.parentId;
  while (parentId) {
    if (parentId === params.referenceId) {
      return true;
    }
    parentId = params.byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

function validateEntryReferences(
  entries: ParsedSessionEntry[],
  byId: Map<string, ParsedSessionEntry>,
) {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      const firstKeptEntryId = requireExistingReference({
        entry,
        field: "firstKeptEntryId",
        byId,
      });
      if (
        !seen.has(firstKeptEntryId) ||
        !referenceIsOnParentLineage({ entry, referenceId: firstKeptEntryId, byId })
      ) {
        malformed(`compaction entry ${entry.id} has a non-ancestor firstKeptEntryId`);
      }
    } else if (entry.type === "branch_summary") {
      // SessionManager.branchWithSummary(null, ...) uses the native "root"
      // sentinel instead of an entry id when starting a new root branch.
      if (entry.fromId === "root" && entry.parentId === null) {
        seen.add(entry.id);
        continue;
      }
      const fromId = requireExistingReference({ entry, field: "fromId", byId });
      if (!seen.has(fromId) || entry.parentId !== fromId) {
        malformed(`branch_summary entry ${entry.id} has an invalid branch origin`);
      }
    } else if (entry.type === "label") {
      const targetId = requireExistingReference({ entry, field: "targetId", byId });
      if (!seen.has(targetId)) {
        malformed(`label entry ${entry.id} targets a later entry`);
      }
    }
    seen.add(entry.id);
  }
}

function messageForEntry(entry: ParsedSessionEntry): AgentMessage | null {
  if (entry.type !== "message" || !isRecord(entry.message)) {
    return null;
  }
  return entry.message as unknown as AgentMessage;
}

function entryContainsToolCall(entry: ParsedSessionEntry, toolCallId: string): boolean {
  const message = messageForEntry(entry);
  if (message?.role !== "assistant") {
    return false;
  }
  return extractToolCallsFromAssistant(message).some((call) => call.id === toolCallId);
}

function validateToolResultLineage(
  entries: ParsedSessionEntry[],
  byId: Map<string, ParsedSessionEntry>,
) {
  for (const entry of entries) {
    const message = messageForEntry(entry);
    if (message?.role !== "toolResult") {
      continue;
    }
    const toolCallId = extractToolResultId(message);
    if (!toolCallId) {
      malformed(`tool result entry ${entry.id} has no tool call id`);
    }
    let parentId = entry.parentId;
    let matched = false;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent) {
        break;
      }
      if (entryContainsToolCall(parent, toolCallId)) {
        matched = true;
        break;
      }
      parentId = parent.parentId;
    }
    if (!matched) {
      malformed(`tool result entry ${entry.id} has no tool call on its parent lineage`);
    }
  }
}

function resolveLeafBranch(
  entries: ParsedSessionEntry[],
  byId: Map<string, ParsedSessionEntry>,
): ParsedSessionEntry[] {
  const leaf = entries.at(-1);
  if (!leaf) {
    return [];
  }
  const branch: ParsedSessionEntry[] = [];
  let current: ParsedSessionEntry | undefined = leaf;
  while (current) {
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch;
}

function findUnsafeRetainedEntry(entries: ParsedSessionEntry[]): number {
  const retainedIds = new Set(entries.map((entry) => entry.id));
  const toolCallIds = new Set<string>();
  let lastUnsafeIndex = -1;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const message = messageForEntry(entry);
    if (message?.role === "assistant") {
      for (const call of extractToolCallsFromAssistant(message)) {
        toolCallIds.add(call.id);
      }
    } else if (message?.role === "toolResult") {
      const toolCallId = extractToolResultId(message);
      if (!toolCallId || !toolCallIds.has(toolCallId)) {
        lastUnsafeIndex = index;
      }
    }

    const reference =
      entry.type === "compaction"
        ? entry.firstKeptEntryId
        : entry.type === "branch_summary"
          ? entry.fromId === "root" && entry.parentId === null
            ? undefined
            : entry.fromId
          : entry.type === "label"
            ? entry.targetId
            : undefined;
    if (typeof reference === "string" && !retainedIds.has(reference)) {
      lastUnsafeIndex = index;
    }
  }
  return lastUnsafeIndex;
}

function retainLineageSafeSuffix(params: {
  entries: ParsedSessionEntry[];
  maxEntries: number;
}): ParsedSessionEntry[] {
  const byId = new Map(params.entries.map((entry) => [entry.id, entry]));
  const branch = resolveLeafBranch(params.entries, byId);
  let start = Math.max(0, branch.length - params.maxEntries);

  // Never retain a tool result (or another entry with an explicit reference)
  // after dropping the entry it points to. Advancing the boundary preserves a
  // true suffix and stays within maxLines without fabricating transcript data.
  while (start < branch.length) {
    const retained = branch.slice(start);
    const unsafeIndex = findUnsafeRetainedEntry(retained);
    if (unsafeIndex < 0) {
      break;
    }
    start += unsafeIndex + 1;
  }

  return branch.slice(start).map((entry, index) =>
    index === 0
      ? {
          ...entry,
          parentId: null,
        }
      : entry,
  );
}

async function reserveBackupPath(filePath: string): Promise<string> {
  const startedAt = Date.now();
  for (let offset = 0; offset < 1_000; offset += 1) {
    const candidate = `${filePath}.bak.${formatSessionArchiveTimestamp(startedAt + offset)}`;
    try {
      await fs.copyFile(filePath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("unable to reserve a unique transcript backup path");
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Some supported platforms do not allow fsync on directory handles. The
    // transcript itself was fsynced before rename, which remains the hard gate.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicReplaceWithBackup(params: {
  filePath: string;
  content: string;
}): Promise<string> {
  const stat = await fs.stat(params.filePath);
  const tempPath = `${params.filePath}.compact-${process.pid}-${randomUUID()}.tmp`;
  let tempHandle: fs.FileHandle | undefined;
  let renamed = false;
  try {
    tempHandle = await fs.open(tempPath, "wx", stat.mode & 0o777);
    await tempHandle.writeFile(params.content, "utf8");
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    const archived = await reserveBackupPath(params.filePath);
    await fs.chmod(archived, stat.mode);
    await syncFile(archived);
    await fs.rename(tempPath, params.filePath);
    renamed = true;
    await syncDirectoryBestEffort(path.dirname(params.filePath));
    return archived;
  } finally {
    await tempHandle?.close().catch(() => undefined);
    if (!renamed) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function compactSessionTranscript(params: {
  filePath: string;
  sessionId: string;
  maxLines: number;
}): Promise<SessionTranscriptCompactResult> {
  const lock = await acquireSessionWriteLock({
    sessionFile: params.filePath,
    timeoutMs: 15_000,
    maxHoldMs: 60_000,
  });
  try {
    let raw: string;
    try {
      raw = await fs.readFile(params.filePath, "utf8");
    } catch (error) {
      throw new SessionTranscriptCompactError(
        "io",
        `failed to read transcript: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { header, entries } = normalizeAndValidateTranscript({
      raw,
      sessionId: params.sessionId,
    });
    const originalLineCount = entries.length + 1;
    if (originalLineCount <= params.maxLines) {
      return { compacted: false, kept: originalLineCount };
    }

    const retained = retainLineageSafeSuffix({
      entries,
      maxEntries: Math.max(0, params.maxLines - 1),
    });
    const outputEntries: JsonRecord[] = [header, ...retained];
    const content = `${outputEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    let archived: string;
    try {
      archived = await atomicReplaceWithBackup({ filePath: params.filePath, content });
    } catch (error) {
      throw new SessionTranscriptCompactError(
        "io",
        `failed to replace transcript: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { compacted: true, archived, kept: outputEntries.length };
  } finally {
    await lock.release();
  }
}
