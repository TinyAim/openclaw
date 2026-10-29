import os from "node:os";
import { createDeferred } from "../../test/helpers/promise.js";
import { getFollowupQueue } from "../auto-reply/reply/queue/state.js";
import type { SessionCompactionCheckpoint } from "../config/sessions.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
const getSessionManagerModule = () => import("../agents/sessions/index.js");
async function createCheckpointFixture(
  dir: string,
  _options: { legacyPreCompactionSnapshot?: boolean } = {},
) {
  return createCompactedSessionFixture(dir);
}
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.queued-execution.js";
import type { CompactEmbeddedAgentSessionParams } from "../agents/embedded-agent-runner/compact.types.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { enqueueFollowupRun, type FollowupRun } from "../auto-reply/reply/queue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import {
  appendTranscriptMessage,
  appendTranscriptEvent,
  loadSessionEntry as loadAccessorSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
  patchSessionEntryCore as patchAccessorSessionEntry,
  replaceSessionEntry,
  createSessionEntryWithTranscript,
} from "../config/sessions/session-accessor.js";
import * as transcriptTargets from "../config/sessions/session-accessor.transcript-target.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import {
  getSessionStateVersion,
  listSessionStateEventsSince,
} from "../sessions/session-state-events.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  embeddedRunMock,
  onceMessage,
  agentDiscoveryMock,
  rpcReq,
  testState,
} from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { testConfigRoot } from "./test-helpers.runtime-state.js";
import { holdCompaction } from "./test/server-sessions-compaction.test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  getGatewayConfigModule,
  createCompactedSessionFixture,
  directSessionReq,
  expectNoSessionQueueCleanup,
} from "./test/server-sessions.test-helpers.js";
import { loseSessionSignalAcknowledgement } from "./test/session-signal-failure.test-support.js";
import { registerWorkerInferenceSessionControl } from "./worker-environments/inference-control-internal.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();

type CheckpointFixture = Awaited<ReturnType<typeof createCheckpointFixture>>;

function buildSessionTranscriptLines(sessionId: string, totalLines: number): string[] {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-06-19T12:00:00.000Z",
    cwd: "/tmp",
  });
  const entries = Array.from({ length: Math.max(0, totalLines - 1) }, (_, index) =>
    JSON.stringify({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: `2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
      message: { role: "user", content: `line-${index}`, timestamp: index },
    }),
  );
  return [header, ...entries];
}

function compactionCheckpointEntry(
  fixture: CheckpointFixture,
  options: {
    checkpointId: string;
    sessionKey: string;
    createdAt: number;
    reason: SessionCompactionCheckpoint["reason"];
    summary: string;
    tokensBefore?: number;
    tokensAfter?: number;
  },
): SessionCompactionCheckpoint {
  return {
    checkpointId: options.checkpointId,
    sessionKey: options.sessionKey,
    sessionId: fixture.sessionId,
    createdAt: options.createdAt,
    reason: options.reason,
    tokensVersion: 1,
    summary: options.summary,
    ...(options.tokensBefore === undefined ? {} : { tokensBefore: options.tokensBefore }),
    ...(options.tokensAfter === undefined ? {} : { tokensAfter: options.tokensAfter }),
    firstKeptEntryId: fixture.preCompactionLeafId,
    preCompaction: {
      sessionId: fixture.sessionId,
      leafId: fixture.preCompactionLeafId,
    },
    postCompaction: {
      sessionId: fixture.sessionId,
      sessionFile: fixture.sessionFile,
      leafId: fixture.postCompactionLeafId,
      entryId: fixture.postCompactionLeafId,
    },
  };
}

async function seedSessionEntry(params: {
  agentId?: string;
  entry: ReturnType<typeof sessionStoreEntry>;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await upsertSessionEntryCore(
    {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.entry,
  );
}

async function seedTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  totalLines: number;
}): Promise<void> {
  const scope = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  if (params.totalLines <= 0) {
    return;
  }
  const header = JSON.parse(buildSessionTranscriptLines(params.sessionId, 1)[0] ?? "{}");
  await appendTranscriptEvent(scope, header);
  for (let index = 0; index < params.totalLines - 1; index += 1) {
    await appendTranscriptMessage(scope, {
      cwd: "/tmp",
      message: {
        role: "user",
        content: `line-${index}`,
        timestamp: index,
      },
      now: Date.parse(`2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`),
    });
  }
}

function isCompactOperationEvent(message: unknown, phase: "start" | "end") {
  const candidate = message as {
    event?: unknown;
    payload?: { operation?: unknown; phase?: unknown };
    type?: unknown;
  };
  return (
    candidate.type === "event" &&
    candidate.event === "session.operation" &&
    candidate.payload?.operation === "compact" &&
    candidate.payload?.phase === phase
  );
}

function expectMainCompactionResult(
  compacted: { ok?: boolean; payload?: { compacted?: boolean; key?: string } | null },
  expectedCompacted: boolean,
) {
  expect(compacted.ok, JSON.stringify(compacted)).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted, JSON.stringify(compacted)).toBe(expectedCompacted);
}

function loadSessionEntry(scope: Parameters<typeof loadAccessorSessionEntry>[0]) {
  return loadAccessorSessionEntry({ ...scope, readConsistency: "latest" });
}

async function createCompactionSession(
  sessionId = "sess-main",
  {
    totalLines = 3,
    entry = {},
    sessionKey = "agent:main:main",
  }: { totalLines?: number; entry?: Partial<InternalSessionEntry>; sessionKey?: string } = {},
) {
  const { dir, storePath } = await createSessionStoreDir();
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  await upsertSessionEntryCore(scope, sessionStoreEntry(sessionId, entry));
  if (totalLines > 0) {
    await appendTranscriptEvent(scope, {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-06-19T12:00:00.000Z",
      cwd: "/tmp",
    });
  }
  for (let index = 0; index < totalLines - 1; index += 1) {
    await appendTranscriptMessage(scope, {
      cwd: "/tmp",
      message: { role: "user", content: `line-${index}`, timestamp: index },
      now: Date.parse(`2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`),
    });
  }
  return { ...scope, dir };
}

async function loadTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<Record<string, unknown>>> {
  const rows = await loadTranscriptEvents({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  return rows.map((row) =>
    row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {},
  );
}

async function alignCheckpointBoundaryWithSqliteRows(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const rows = await loadTranscriptRows(params);
  const leafId = rows.toReversed().find((row) => row.type !== "session")?.id;
  if (typeof leafId !== "string") {
    throw new Error("expected a SQLite checkpoint boundary row");
  }
  await patchAccessorSessionEntry(params, (entry) => ({
    ...entry,
    compactionCheckpoints: entry.compactionCheckpoints?.map((checkpoint) => ({
      ...checkpoint,
      preCompaction: { ...checkpoint.preCompaction, leafId, entryId: leafId },
      postCompaction: { ...checkpoint.postCompaction, leafId, entryId: leafId },
    })),
  }));
}

test("sessions.compaction.* lists checkpoints and branches or restores from compacted transcripts", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  expect((await fs.readdir(dir)).some((file) => file.includes(".checkpoint."))).toBe(false);
  const checkpointCreatedAt = Date.now();
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-1",
    sessionKey: "agent:main:main",
    createdAt: checkpointCreatedAt,
    reason: "manual",
    summary: "checkpoint summary",
    tokensBefore: 123,
    tokensAfter: 45,
  });
  const { SessionManager } = await getSessionManagerModule();
  await seedSessionEntry({
    entry: sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: fixture.sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 2,
  });
  await alignCheckpointBoundaryWithSqliteRows({
    sessionId: fixture.sessionId,
    sessionKey: "agent:main:main",
    storePath,
  });
  const futureMessage = {
    role: "user",
    content: "future turn after checkpoint",
    timestamp: Date.now(),
  } as const;
  fixture.session.appendMessage(futureMessage);
  await appendTranscriptMessage(
    {
      agentId: "main",
      sessionId: fixture.sessionId,
      sessionKey: "agent:main:main",
      storePath,
    },
    { message: futureMessage, now: futureMessage.timestamp },
  );

  const { ws } = await openClient();

  const listedSessions = await rpcReq<{
    sessions: Array<{
      key: string;
      compactionCheckpointCount?: number;
      latestCompactionCheckpoint?: {
        checkpointId: string;
        createdAt: number;
        reason: string;
        summary?: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
    }>;
  }>(ws, "sessions.list", {});
  expect(listedSessions.ok).toBe(true);
  const main = listedSessions.payload?.sessions.find(
    (session) => session.key === "agent:main:main",
  );
  expect(main?.compactionCheckpointCount).toBe(1);
  expect(main?.latestCompactionCheckpoint).toEqual({
    checkpointId: "checkpoint-1",
    createdAt: checkpointCreatedAt,
    reason: "manual",
  });

  const listedCheckpoints = await rpcReq<{
    ok: true;
    key: string;
    checkpoints: Array<{ checkpointId: string; summary?: string; tokensBefore?: number }>;
  }>(ws, "sessions.compaction.list", { key: "main" });
  expect(listedCheckpoints.ok).toBe(true);
  expect(listedCheckpoints.payload?.key).toBe("agent:main:main");
  expect(listedCheckpoints.payload?.checkpoints).toHaveLength(1);
  expect(listedCheckpoints.payload?.checkpoints[0]).toMatchObject({
    checkpointId: checkpointEntry.checkpointId,
    reason: checkpointEntry.reason,
    sessionId: checkpointEntry.sessionId,
    sessionKey: checkpointEntry.sessionKey,
  });

  const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
  let branched: Awaited<
    ReturnType<
      typeof rpcReq<{
        ok: true;
        sourceKey: string;
        key: string;
        entry: {
          sessionId: string;
          sessionFile?: string;
          parentSessionKey?: string;
          totalTokens?: number;
          totalTokensFresh?: boolean;
        };
      }>
    >
  >;
  try {
    branched = await rpcReq<{
      ok: true;
      sourceKey: string;
      key: string;
      entry: {
        sessionId: string;
        sessionFile?: string;
        parentSessionKey?: string;
        totalTokens?: number;
        totalTokensFresh?: boolean;
      };
    }>(ws, "sessions.compaction.branch", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
  } finally {
    sessionManagerOpenSpy.mockRestore();
  }
  expect(branched.ok, JSON.stringify(branched)).toBe(true);
  expect(branched.payload?.sourceKey).toBe("agent:main:main");
  expect(branched.payload?.entry.parentSessionKey).toBe("agent:main:main");
  expect(branched.payload?.entry.totalTokens).toBe(123);
  expect(branched.payload?.entry.totalTokensFresh).toBe(true);
  expect(branched.payload?.entry).not.toHaveProperty("sessionFile");
  const branchedRows = await loadTranscriptRows({
    sessionId: branched.payload!.entry.sessionId,
    sessionKey: branched.payload!.key,
    storePath,
  });
  expect(branchedRows.length).toBeGreaterThan(0);
  expect(JSON.stringify(branchedRows)).not.toContain("future turn after checkpoint");

  const branchedEntry = loadSessionEntry({
    sessionKey: branched.payload!.key,
    storePath,
  });
  expect(branchedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(branchedEntry?.compactionCheckpoints).toBeUndefined();

  const restoreSessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
  let restored: Awaited<
    ReturnType<
      typeof rpcReq<{
        ok: true;
        key: string;
        sessionId: string;
        entry: {
          sessionId: string;
          sessionFile?: string;
          compactionCheckpoints?: unknown[];
          totalTokens?: number;
          totalTokensFresh?: boolean;
        };
      }>
    >
  >;
  try {
    restored = await rpcReq<{
      ok: true;
      key: string;
      sessionId: string;
      entry: {
        sessionId: string;
        sessionFile?: string;
        compactionCheckpoints?: unknown[];
        totalTokens?: number;
        totalTokensFresh?: boolean;
      };
    }>(ws, "sessions.compaction.restore", {
      key: "main",
      checkpointId: "checkpoint-1",
    });
    expect(restoreSessionManagerOpenSpy).not.toHaveBeenCalled();
  } finally {
    restoreSessionManagerOpenSpy.mockRestore();
  }
  expect(restored.ok, JSON.stringify(restored)).toBe(true);
  expect(restored.payload?.key).toBe("agent:main:main");
  expect(restored.payload?.sessionId).not.toBe(fixture.sessionId);
  expect(restored.payload?.entry.compactionCheckpoints).toHaveLength(1);
  expect(restored.payload?.entry.totalTokens).toBe(123);
  expect(restored.payload?.entry.totalTokensFresh).toBe(true);
  expect(restored.payload?.entry).not.toHaveProperty("sessionFile");
  const restoredRows = await loadTranscriptRows({
    sessionId: restored.payload!.entry.sessionId,
    sessionKey: "agent:main:main",
    storePath,
  });
  expect(restoredRows.length).toBeGreaterThan(0);
  expect(JSON.stringify(restoredRows)).not.toContain("future turn after checkpoint");

  const restoredEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(restoredEntry?.sessionId).toBe(restored.payload?.sessionId);
  expect(restoredEntry?.compactionCheckpoints).toHaveLength(1);

  ws.close();
});

test("sessions.compaction branch and restore retain the production native incognito owner", async () => {
  await createSessionStoreDir();
  const { resolveIncognitoOpenClawAgentSqlitePath } =
    await import("../state/openclaw-agent-db.paths.js");
  const { captureSqliteCompactionCheckpoint, persistSqliteCompactionCheckpoint } =
    await import("../config/sessions/session-accessor.sqlite-checkpoint.js");
  const target = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-checkpoint-rpc",
    sessionId: "native-incognito-rpc",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
  };
  expect(
    await createSessionEntryWithTranscript(target, () => ({
      ok: true,
      entry: sessionStoreEntry(target.sessionId, { incognito: true }),
    })),
  ).toMatchObject({ ok: true });
  await appendTranscriptMessage(target, {
    eventId: "private-original",
    parentId: null,
    message: { role: "user", content: "retained private prompt" },
    now: 1,
  });
  const before = await captureSqliteCompactionCheckpoint({ ...target, assertActive() {} });
  if (!before) throw new Error("missing native RPC original boundary");
  await appendTranscriptMessage(target, {
    eventId: "private-current",
    parentId: "private-original",
    message: { role: "assistant", content: "later private answer" },
    now: 2,
  });
  const after = await captureSqliteCompactionCheckpoint({ ...target, assertActive() {} });
  if (!after) throw new Error("missing native RPC current boundary");
  const checkpoint = {
    checkpointId: "native-rpc-retained",
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    reason: "manual" as const,
    createdAt: 3,
    preCompaction: { sessionId: before.sessionId, leafId: before.leafId },
    postCompaction: { sessionId: after.sessionId, leafId: after.leafId },
  };
  expect(
    await persistSqliteCompactionCheckpoint({
      ...target,
      source: before,
      expectedState: after,
      checkpoint,
      assertActive() {},
    }),
  ).toEqual({ status: "stored" });
  const { ws } = await openClient();
  try {
    const branch = await rpcReq<{ key: string; entry: { sessionId: string; incognito: boolean } }>(
      ws,
      "sessions.compaction.branch",
      { key: target.sessionKey, checkpointId: checkpoint.checkpointId },
    );
    expect(branch.ok, JSON.stringify(branch)).toBe(true);
    expect(branch.payload?.key).toContain(":dashboard:incognito-");
    expect(branch.payload?.entry.incognito).toBe(true);
    expect(
      JSON.stringify(
        await loadTranscriptEvents({
          ...target,
          sessionKey: branch.payload!.key,
          sessionId: branch.payload!.entry.sessionId,
        }),
      ),
    ).toContain("retained private prompt");
    const restore = await rpcReq<{ sessionId: string }>(ws, "sessions.compaction.restore", {
      key: target.sessionKey,
      checkpointId: checkpoint.checkpointId,
    });
    expect(restore.ok, JSON.stringify(restore)).toBe(true);
    expect(loadAccessorSessionEntry(target)?.sessionId).toBe(restore.payload!.sessionId);
    expect(
      JSON.stringify(
        await loadTranscriptEvents({ ...target, sessionId: restore.payload!.sessionId }),
      ),
    ).not.toContain("later private answer");
    await expect(fs.stat(target.storePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    ws.close();
  }
});

test.each([
  { identity: "operator", required: false },
  { identity: "operator", required: true },
  { identity: "system", required: false },
  { identity: "system", required: true },
  { identity: "owner", required: false },
  { identity: "owner", required: true },
  { identity: "identityless", required: false },
  { identity: "identityless", required: true },
] as const)(
  "sessions.compaction.branch preserves $identity isolation (profile requirement: $required)",
  async ({ identity, required }) => {
    const systemActor = identity !== "operator";
    const { dir, storePath } = await createSessionStoreDir();
    const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
    const sessionKey = "agent:main:main";
    const checkpoint = compactionCheckpointEntry(fixture, {
      checkpointId: "checkpoint-creator-policy",
      sessionKey,
      createdAt: Date.now(),
      reason: "manual",
      summary: "creator policy branch",
    });
    const sourceStamp = {
      createdVia: "operator" as const,
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: "checkpoint-source-owner",
      },
      createdAt: 123,
      ...(!required ? { sandbox: "required" as const } : {}),
    };
    await seedSessionEntry({
      entry: sessionStoreEntry(fixture.sessionId, {
        ...sourceStamp,
        compactionCheckpoints: [checkpoint],
      }),
      sessionKey,
      storePath,
    });
    const sourceScope = { sessionId: fixture.sessionId, sessionKey, storePath };
    await seedTranscriptRows({ ...sourceScope, totalLines: 2 });
    await alignCheckpointBoundaryWithSqliteRows(sourceScope);
    const profile =
      identity === "identityless"
        ? undefined
        : systemActor
          ? ensureGatewayOwnerProfile("Gateway Owner")
          : ensureProfileForEmail("checkpoint-requester@example.test");
    if (profile && !systemActor) {
      await setCanonicalUserProfileRole(profile.id, "requester");
    }
    const runtimeConfig = (await getGatewayConfigModule()).getRuntimeConfig();
    const cfg = {
      ...runtimeConfig,
      session: { ...runtimeConfig.session, store: storePath },
      gateway: {
        ...runtimeConfig.gateway,
        roles: {
          default: "requester",
          definitions: {
            requester: {
              sessions: { others: "view" as const },
              agents: ["main"],
              scopes: ["operator.read" as const, "operator.write" as const],
              ...(required ? { sandbox: "required" as const } : {}),
            },
          },
        },
      },
    };
    const branched = await directSessionReq<{ key: string }>(
      "sessions.compaction.branch",
      { key: "main", checkpointId: checkpoint.checkpointId },
      {
        client: {
          ...(systemActor && identity !== "owner"
            ? { internal: { operatorRoleActor: { kind: "system" as const } } }
            : {}),
          connect: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "test", mode: "test", platform: "test", version: "test" },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
          ...(profile
            ? {
                authenticatedUserProfile: {
                  profileId: profile.id,
                  displayName: profile.displayName,
                  hasAvatar: false,
                  updatedAt: profile.updatedAt,
                },
              }
            : {}),
        },
        context: {
          getRuntimeConfig: () =>
            identity === "owner" ? { ...cfg, gateway: { ...cfg.gateway, roles: undefined } } : cfg,
        },
      },
    );
    expect(branched.ok, JSON.stringify(branched.error)).toBe(true);
    const branch = loadSessionEntry({ sessionKey: branched.payload?.key ?? "", storePath });
    expect(branch).toMatchObject({
      createdVia: "operator",
      createdAt: expect.any(Number),
    });
    expect(branch?.createdActor).toEqual(
      profile ? { type: "human", source: "profile", id: profile.id } : sourceStamp.createdActor,
    );
    if (profile) {
      expect(branch?.createdAt).not.toBe(sourceStamp.createdAt);
    } else {
      expect(branch?.createdAt).toBe(sourceStamp.createdAt);
    }
    expect(branch?.sandbox).toBe((systemActor ? !required : required) ? "required" : undefined);
    const source = loadSessionEntry(sourceScope);
    expect(source).toMatchObject(sourceStamp);
    expect(source?.sandbox).toBe(required ? undefined : "required");
  },
);

test.each(["branch", "restore"] as const)(
  "sessions.compaction.%s preserves rejection messages and leaves the source unchanged",
  async (action) => {
    const { storePath } = await createSessionStoreDir();
    const source = { sessionKey: "agent:main:main", storePath };
    await seedSessionEntry({ ...source, entry: sessionStoreEntry("sess-checkpoint-invalid") });
    const before = loadSessionEntry(source);
    const { ws } = await openClient();
    try {
      for (const [params, message] of [
        [{ key: " ", checkpointId: "checkpoint-1" }, "key required"],
        [{ key: "main", checkpointId: " " }, "checkpointId required"],
        [
          { key: "agent:main:missing", checkpointId: "checkpoint-1" },
          "session not found: agent:main:missing",
        ],
        [{ key: "main", checkpointId: "missing" }, "checkpoint not found: missing"],
      ] as const) {
        await expect(rpcReq(ws, `sessions.compaction.${action}`, params)).resolves.toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message },
        });
        expect(loadSessionEntry(source)).toEqual(before);
      }
    } finally {
      ws.close();
    }
  },
);

test.each(["branch", "restore"] as const)(
  "sessions.compaction.%s rejects model-selection-locked session identities",
  async (action) => {
    const { dir, storePath } = await createSessionStoreDir();
    const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
    const checkpointEntry = compactionCheckpointEntry(fixture, {
      checkpointId: "checkpoint-locked-branch",
      sessionKey: "agent:main:main",
      createdAt: Date.now(),
      reason: "manual",
      summary: "locked checkpoint",
    });
    await seedSessionEntry({
      entry: sessionStoreEntry(fixture.sessionId, {
        sessionFile: fixture.sessionFile,
        compactionCheckpoints: [checkpointEntry],
        modelSelectionLocked: true,
      }),
      sessionKey: "agent:main:main",
      storePath,
    });
    const { ws } = await openClient();
    try {
      await expect(
        rpcReq(ws, `sessions.compaction.${action}`, {
          key: "main",
          checkpointId: "checkpoint-locked-branch",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Checkpoint branch and restore are unavailable while model selection is locked.",
        },
      });
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        modelSelectionLocked: true,
        sessionId: fixture.sessionId,
      });
    } finally {
      ws.close();
    }
  },
);

test("sessions.compaction list/get scopes selected global checkpoints to the requested agent", async () => {
  const { mainStorePath, storeTemplate, workStorePath } = await createSelectedGlobalSessionStore();
  const runtimeConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: { mainKey: "main", scope: "global", store: storeTemplate },
  };
  await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
  await fs.mkdir(path.dirname(workStorePath), { recursive: true });
  const checkpointCreatedAt = Date.now();
  const checkpointEntry: SessionCompactionCheckpoint = {
    checkpointId: "checkpoint-work",
    sessionKey: "global",
    createdAt: checkpointCreatedAt,
    reason: "manual",
    summary: "work checkpoint",
    sessionId: "sess-work-global",
    firstKeptEntryId: "entry-work-kept",
    preCompaction: {
      sessionId: "sess-work-global",
      leafId: "entry-work-before",
    },
    postCompaction: {
      sessionId: "sess-work-global",
      leafId: "entry-work-kept",
      entryId: "entry-work-kept",
    },
  };
  await seedSessionEntry({
    agentId: "main",
    entry: sessionStoreEntry("sess-main-global"),
    sessionKey: "global",
    storePath: mainStorePath,
  });
  await seedSessionEntry({
    agentId: "work",
    entry: sessionStoreEntry("sess-work-global", {
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "global",
    storePath: workStorePath,
  });

  const listed = await directSessionReq<{
    checkpoints: Array<{ checkpointId: string; summary?: string }>;
  }>(
    "sessions.compaction.list",
    { key: "global", agentId: "work" },
    {
      context: { getRuntimeConfig: () => runtimeConfig },
    },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.checkpoints).toHaveLength(1);
  expect(listed.payload?.checkpoints[0]).toMatchObject({
    checkpointId: "checkpoint-work",
    summary: "work checkpoint",
  });

  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath })
      ?.sessionId,
  ).toBe("sess-main-global");
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: "global", storePath: workStorePath })
      ?.sessionId,
  ).toBe("sess-work-global");
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
});

test.each([
  ["legacy omission", undefined, undefined],
  [
    "explicit focus",
    "  Current verified assignment: continuity steward.  ",
    "Current verified assignment: continuity steward.",
  ],
  ["blank focus", " \t\n", undefined],
  ["Unicode focus", "😀".repeat(800), "😀".repeat(800)],
])(
  "sessions.compact without maxLines runs embedded manual compaction: %s",
  runGatewayManualCompactionCase,
);

async function runGatewayManualCompactionCase(
  _label: string,
  customInstructions?: string,
  expectedFocus?: string,
) {
  const sessionScope = await createCompactionSession("sess-main", {
    totalLines: 1,
    entry: {
      spawnedCwd: "/tmp/task-repo",
      thinkingLevel: "medium",
      reasoningLevel: "stream",
      cliSessionIds: { "claude-cli": "claude-session", "codex-cli": "codex-session" },
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
        "codex-cli": { sessionId: "codex-session" },
      },
      claudeCliSessionId: "claude-session",
      inputTokens: 60,
      outputTokens: 10,
      cacheRead: 40,
      cacheWrite: 10,
      estimatedCostUsd: 0.02,
      contextBudgetStatus: contextBudgetStatusFixture(),
    },
  });
  const seedMessage = await appendTranscriptMessage(sessionScope, {
    message: { role: "user", content: "hello", timestamp: 1 },
    now: Date.parse("2026-06-19T12:00:01.000Z"),
  });
  await appendTranscriptMessage(sessionScope, {
    message: { role: "user", content: "follow-up", timestamp: 2 },
    now: Date.parse("2026-06-19T12:00:02.000Z"),
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (params) => {
    const call = params as CompactEmbeddedAgentSessionParams;
    if (
      !call.sessionTarget?.agentId ||
      !call.sessionTarget.sessionId ||
      !call.sessionTarget.sessionKey ||
      !call.sessionTarget.storePath
    ) {
      throw new Error("expected SQLite session target");
    }
    const targetScope = {
      agentId: call.sessionTarget.agentId,
      sessionId: call.sessionTarget.sessionId,
      sessionKey: call.sessionTarget.sessionKey,
      storePath: call.sessionTarget.storePath,
    };
    const rows = await loadTranscriptEvents(targetScope);
    expect(rows).toHaveLength(3);
    await appendTranscriptEvent(targetScope, {
      type: "compaction",
      id: "compact-1",
      parentId: seedMessage.messageId,
      timestamp: "2026-06-19T12:00:02.000Z",
      summary: "summary",
      firstKeptEntryId: seedMessage.messageId,
      tokensBefore: 120,
      tokensAfter: 80,
    });
    return {
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 80,
      },
    };
  });

  const { ws } = await openClient();
  // Prepare the lazy handler before arming the RPC and event observers.
  await import("./server-methods/sessions-compact.js");
  await rpcReq(ws, "sessions.subscribe", {});
  const signalVersion = await getSessionStateVersion(sessionScope.sessionKey, "main");
  const signal = loseSessionSignalAcknowledgement();
  using resolveTarget = vi.spyOn(transcriptTargets, "resolveSessionTranscriptRuntimeTarget");
  const [startEvent, endEvent, compacted] = await Promise.all([
    onceMessage(ws, (message) => isCompactOperationEvent(message, "start")),
    onceMessage(ws, (message) => isCompactOperationEvent(message, "end")),
    rpcReq(ws, "sessions.compact", {
      key: "main",
      ...(customInstructions !== undefined ? { customInstructions } : {}),
    }),
  ]).finally(signal.restore);

  expectMainCompactionResult(compacted, true);
  expect(resolveTarget).not.toHaveBeenCalled();
  expect(signal.attempts()).toBe(1);
  expect(
    (await listSessionStateEventsSince(sessionScope.sessionKey, "main", signalVersion)).events,
  ).toMatchObject([{ kind: "compacted", sessionId: sessionScope.sessionId }]);
  const startPayload = startEvent.payload as { operationId?: string };
  const endPayload = endEvent.payload as { operationId?: string };
  expect(startPayload).toMatchObject({
    operation: "compact",
    phase: "start",
    sessionKey: "agent:main:main",
    operationId: expect.any(String),
    ts: expect.any(Number),
  });
  expect(endPayload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: true,
    operationId: startPayload.operationId,
    ts: expect.any(Number),
  });
  expect(startPayload.operationId).toBeTruthy();
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  expect(embeddedRunMock.compactEmbeddedAgentSession.mock.calls[0]?.[0]).toMatchObject({
    sessionId: "sess-main",
    runId: startPayload.operationId,
    sessionKey: "agent:main:main",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath: sessionScope.storePath,
    },
    workspaceDir: "/tmp/task-repo",
    cwd: "/tmp/task-repo",
    config: {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          workspace: path.join(testConfigRoot.value, "workspace"),
        },
      },
    },
    provider: "anthropic",
    model: "claude-opus-4-6",
    allowGatewaySubagentBinding: true,
    agentHarnessId: undefined,
    thinkLevel: "medium",
    reasoningLevel: "stream",
    bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
    trigger: "manual",
  });
  const compactionCall = embeddedRunMock.compactEmbeddedAgentSession.mock.calls[0]?.[0];
  expect(compactionCall.trigger).toBe("manual");
  if (expectedFocus === undefined) {
    expect(compactionCall).not.toHaveProperty("customInstructions");
  } else {
    expect(compactionCall.customInstructions).toBe(expectedFocus);
  }

  const sqliteRows = await loadTranscriptEvents(sessionScope);
  expect(sqliteRows).toHaveLength(4);
  expect(sqliteRows.at(-1)).toMatchObject({
    type: "compaction",
    summary: "summary",
  });
  await expect(fs.readdir(sessionScope.dir)).resolves.not.toContain("sess-main.jsonl");
  const storedEntry = loadAccessorSessionEntry(sessionScope);
  expect(storedEntry).toMatchObject({
    compactionCount: 1,
    totalTokens: 80,
    totalTokensFresh: true,
  });
  expect(storedEntry).not.toHaveProperty("compactionCheckpoints");
  for (const field of [
    "cliSessionBindings",
    "cliSessionIds",
    "claudeCliSessionId",
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "estimatedCostUsd",
    "contextBudgetStatus",
  ] as const) {
    expect(storedEntry?.[field], field).toBeUndefined();
  }

  ws.close();
}

test("sessions.compact accounts against the host-accepted successor before returning", async () => {
  const { sessionId, sessionKey, storePath } = await createCompactionSession(
    "gateway-compaction-predecessor",
    { entry: { lifecycleRevision: "lifecycle" } },
  );
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (_input, hostInput) => {
    const entry = loadSessionEntry({ sessionKey, storePath });
    if (!entry) {
      throw new Error("expected gateway predecessor");
    }
    const host = hostInput as QueuedCompactionHostOptions;
    await acceptCompactionSuccessor({
      currentTarget: { agentId: "main", sessionId, sessionKey, storePath },
      expectedEntry: {
        sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      },
      assertActive: () => {},
      result: {
        ok: true,
        compacted: true,
        result: { sessionId: "gateway-compaction-successor", tokensBefore: 120 },
      },
      onCommitted: host.onCommitted,
    });
    return {
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
      result: { sessionId: "gateway-compaction-successor", tokensAfter: 42 },
    };
  });

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });

    expectMainCompactionResult(response, true);
    expect(response.payload).toMatchObject({ ok: true });
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "gateway-compaction-successor",
      lifecycleRevision: "lifecycle",
      compactionCount: 1,
      totalTokens: 42,
    });
  } finally {
    ws.close();
  }
});

test("sessions.compact accounting clears the transcript-byte latch after a manual host rewrite", async () => {
  const sessionScope = await createCompactionSession("sess-latch", {
    totalLines: 3,
    entry: {
      transcriptByteCompactionLatch: {
        activeBytes: 60_000,
        sessionId: "sess-latch",
        maxBytes: 50_000,
      },
    },
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    compactionKind: "context-engine",
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      sessionId: "sess-latch",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });

    expectMainCompactionResult(response, true);
    const storedEntry = loadSessionEntry(sessionScope);
    expect(storedEntry).toMatchObject({ compactionCount: 1, totalTokens: 80 });
    expect(storedEntry?.transcriptByteCompactionLatch).toBeUndefined();
  } finally {
    ws.close();
  }
});

test("sessions.compact records terminal Codex native compaction with a stale negative estimate", async () => {
  const latch = { activeBytes: 60_000, sessionId: "sess-codex", maxBytes: 50_000 };
  const scope = await createCompactionSession("sess-codex", {
    totalLines: 2,
    entry: {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      compactionCount: 2,
      transcriptByteCompactionLatch: latch,
      totalTokens: 54_321,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      cliSessionIds: { "codex-cli": "thread-1" },
      cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
    },
  });
  const details = {
    backend: "codex-app-server",
    threadId: "thread-1",
    signal: "thread/compact/start",
    pending: false,
    completed: true,
  };
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    compactionKind: "native-harness",
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 54_321,
      tokensAfter: -1,
      details,
    },
  });

  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));

  const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });
  expectMainCompactionResult(compacted, true);
  expect(compacted.payload).toMatchObject({ result: { details } });
  const endEvent = await endEventPromise;
  expect(endEvent.payload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: true,
  });

  const codexEntry = loadSessionEntry(scope);
  expect(codexEntry).toMatchObject({
    compactionCount: 3,
    cliSessionIds: { "codex-cli": "thread-1" },
    cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
    totalTokens: 54_321,
    totalTokensFresh: false,
  });
  expect(codexEntry?.totalTokensVersion).toBeUndefined();
  expect(codexEntry?.transcriptByteCompactionLatch).toEqual(latch);

  ws.close();
});

test("sessions.compact targets the persisted native CLI session", async () => {
  const pluginRegistry = getTestPluginRegistry();
  pluginRegistry.cliBackends.push({
    pluginId: "anthropic",
    source: "test",
    backend: {
      id: "claude-cli",
      modelProvider: "anthropic",
      config: { command: "claude" },
      bundleMcp: false,
    },
  });
  setActivePluginRegistry(pluginRegistry);
  await createCompactionSession("sess-claude", {
    totalLines: 2,
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      cliSessionBindings: {
        "claude-cli": { sessionId: "native-claude-session" },
      },
    },
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
  });
  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });
    expectMainCompactionResult(compacted, true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "claude-cli",
        cliSessionBinding: expect.objectContaining({ sessionId: "native-claude-session" }),
        cliSessionId: "native-claude-session",
        trigger: "manual",
      }),
      expect.objectContaining({ onCommitted: expect.any(Function) }),
    );
  } finally {
    ws.close();
  }
});

test("sessions.compact emits a terminal operation event when persistence fails", async () => {
  await createCompactionSession("sess-compact-write-failure");
  const compaction = holdCompaction({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      get tokensAfter(): number {
        throw new Error("forced persistence projection failure");
      },
    },
  });
  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await compaction.waitForEntry(compactResult);
  compaction.release();

  const response = await compactResult;
  expect(response.ok).toBe(false);
  expect(response.error?.code).toBe("UNAVAILABLE");
  expect((await endEventPromise).payload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: false,
  });
  ws.close();
});

test("sessions.compact rejects stale terminal persistence after the session changes", async () => {
  const { storePath } = await createCompactionSession("sess-compact-old");
  const compaction = holdCompaction({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
      sessionId: "sess-compacted-successor",
    },
  });

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  try {
    await compaction.waitForEntry(compactResult);
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:main", storePath },
      sessionStoreEntry("sess-replacement"),
    );
    compaction.release();

    const response = await compactResult;
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      details: { reason: "session-changed" },
    });
    const replacedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(replacedEntry?.sessionId).toBe("sess-replacement");
    expect(replacedEntry?.compactionCount).toBeUndefined();
  } finally {
    compaction.release();
    await Promise.allSettled([compactResult]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.reset waits for terminal compaction before replacing the session", async () => {
  const { storePath } = await createCompactionSession("sess-compact-reset");
  const compaction = holdCompaction();

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  let resetResult: ReturnType<typeof rpcReq<{ entry: { sessionId: string } }>> | undefined;
  try {
    await compaction.waitForEntry(compactResult);
    let resetSettled = false;
    resetResult = rpcReq<{ entry: { sessionId: string } }>(ws, "sessions.reset", {
      key: "main",
    }).finally(() => {
      resetSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resetSettled).toBe(false);

    compaction.release();
    expect((await compactResult).ok).toBe(true);
    const reset = await resetResult;
    expect(reset.ok).toBe(true);
    const resetSessionId = reset.payload?.entry.sessionId;
    expect(resetSessionId).toBe("sess-compact-reset");
    const resetEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(resetEntry?.sessionId).toBe(resetSessionId);
  } finally {
    compaction.release();
    await Promise.allSettled([compactResult, resetResult]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.compact blocks new work admission through terminal persistence", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-admission");
  const compaction = holdCompaction();

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  let pendingAdmission: ReturnType<typeof beginSessionWorkAdmission> | undefined;
  try {
    await compaction.waitForEntry(compactResult);

    let admitted = false;
    pendingAdmission = beginSessionWorkAdmission({
      scope: storePath,
      identities: ["agent:main:main", sessionId],
      assertAllowed: () => {},
    }).then((lease) => {
      admitted = true;
      return lease;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admitted).toBe(false);

    compaction.release();
    expect((await compactResult).ok).toBe(true);
    await pendingAdmission;
    expect(admitted).toBe(true);
  } finally {
    compaction.release();
    await Promise.allSettled([
      compactResult,
      pendingAdmission?.then((admission) => admission.release()),
    ]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.compact returns a no-op without interrupting an active admission", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-noop-active", {
    totalLines: 2,
  });

  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq<{
      ok: boolean;
      compacted: boolean;
      reason?: string;
    }>(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(true);
    expect(compacted.payload).toMatchObject({
      ok: false,
      compacted: false,
      reason: "Nothing to compact (session too small)",
    });
    expect(interrupted).toBe(false);
    expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    admission.release();
    ws.close();
  }
});

test("sessions.compact refuses real compaction without interrupting an active admission", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-queued-work");

  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has an active run"),
    });
    expect(interrupted).toBe(false);
    expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    admission.release();
    ws.close();
  }
});

test("sessions.compact preserves accepted queued follow-up work", async () => {
  const { sessionKey } = await createCompactionSession("sess-compact-followup-queue");
  const queuedRun = {
    prompt: "please also update the changelog",
    enqueuedAt: Date.now(),
    run: {},
  } as unknown as FollowupRun;
  expect(
    enqueueFollowupRun(
      sessionKey,
      queuedRun,
      { mode: "followup", debounceMs: 60_000 },
      "none",
      undefined,
      false,
    ),
  ).toBe(true);

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Session main has queued work; retry after it finishes.",
    });
    expect(getExistingFollowupQueue(sessionKey)?.items).toHaveLength(1);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    clearFollowupQueue(sessionKey);
    ws.close();
  }
});

test("sessions.compact preserves accepted command-lane work", async () => {
  const { sessionKey } = await createCompactionSession("sess-compact-command-queue");
  const lane = resolveEmbeddedSessionLane(sessionKey);
  setCommandLaneConcurrency(lane, 0);
  let commandRan = false;
  const queuedCommand = enqueueCommandInLane(lane, async () => {
    commandRan = true;
  });

  const { ws } = await openClient();
  try {
    expect(getCommandLaneSnapshot(lane)).toMatchObject({
      activeCount: 0,
      queuedCount: 1,
    });

    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Session main has queued work; retry after it finishes.",
    });
    expect(getCommandLaneSnapshot(lane).queuedCount).toBe(1);
    expect(commandRan).toBe(false);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    setCommandLaneConcurrency(lane, 1);
    await queuedCommand;
    ws.close();
  }
  expect(commandRan).toBe(true);
});

test("sessions.compact refuses real compaction while a worker inference owns the session", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-worker-inference");
  const hasSession = vi.fn((candidateSessionId: string) => candidateSessionId === sessionId);
  const workerEnvironmentService = {};
  registerWorkerInferenceSessionControl(workerEnvironmentService, {
    hasSession,
    reserveSessionDrain: () => {
      throw new Error("Compaction must reject active inference before draining");
    },
    captureSessionCancellation: () => ({ runIds: [], cancel: async () => [] }),
    resolveSessionTargetForRunId: () => undefined,
  });
  const runtimeConfig = {
    agents: { entries: { main: {} } },
    session: { store: storePath },
  };

  const compacted = await directSessionReq(
    "sessions.compact",
    { key: "main" },
    {
      context: {
        getRuntimeConfig: () => runtimeConfig,
        workerEnvironmentService,
      },
    },
  );

  expect(compacted.ok, JSON.stringify(compacted)).toBe(false);
  expect(compacted.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("has an active run"),
  });
  expect(hasSession).toHaveBeenCalledWith(sessionId);
  expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
  expectNoSessionQueueCleanup();
});

test("sessions.patch waits for terminal compaction before archiving the session", async () => {
  const { sessionKey } = await createCompactionSession("sess-compact-archive", {
    sessionKey: "agent:main:dashboard:compact-race",
  });
  const compaction = holdCompaction();

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: sessionKey });
  let archiveResult: ReturnType<typeof rpcReq> | undefined;
  try {
    await compaction.waitForEntry(compactResult);
    let archiveSettled = false;
    archiveResult = rpcReq(ws, "sessions.patch", {
      key: sessionKey,
      archived: true,
      expectedSessionId: "sess-compact-archive",
    }).then((result) => {
      archiveSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(archiveSettled).toBe(false);

    compaction.release();
    expect((await compactResult).ok).toBe(true);
    expect((await archiveResult).ok).toBe(true);
  } finally {
    compaction.release();
    await Promise.allSettled([compactResult, archiveResult]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.compact maxLines trims SQLite transcript rows without creating a transcript archive", async () => {
  const scope = await createCompactionSession("sess-main", {
    totalLines: 5,
    entry: {
      cliSessionIds: { "claude-cli": "claude-session", "codex-cli": "codex-session" },
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
        "codex-cli": { sessionId: "codex-session" },
      },
      claudeCliSessionId: "claude-session",
    },
  });
  const { ws } = await openClient();
  const signalVersion = await getSessionStateVersion(scope.sessionKey, "main");
  const signal = loseSessionSignalAcknowledgement();
  const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 }).finally(
    signal.restore,
  );
  expectMainCompactionResult(compacted, true);
  expect(signal.attempts()).toBe(1);
  expect(compacted.payload?.kept).toBe(3);

  const retained = await loadTranscriptEvents(scope);
  expect(retained).toHaveLength(3);
  expect(retained[0]).toMatchObject({ type: "session", id: "sess-main" });
  expect(retained[1]).toMatchObject({
    parentId: null,
    message: { content: "line-2" },
  });
  expect(retained.at(-1)).toMatchObject({
    message: { content: "line-3" },
  });
  expect(compacted.payload).not.toHaveProperty("archived");
  const files = await fs.readdir(scope.dir);
  expect(files.some((name) => name.includes(".jsonl.bak."))).toBe(false);
  expect(files).not.toContain("sess-main.jsonl");
  const trimmedEntry = loadSessionEntry(scope);
  expect(trimmedEntry?.cliSessionIds).toBeUndefined();
  expect(trimmedEntry?.cliSessionBindings).toBeUndefined();
  expect(trimmedEntry?.claudeCliSessionId).toBeUndefined();

  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  expect(
    (await listSessionStateEventsSince(scope.sessionKey, "main", signalVersion)).events,
  ).toMatchObject([{ kind: "compacted", sessionId: scope.sessionId }]);

  ws.close();
});

test("sessions.compact maxLines refuses an active run without trimming rows", async () => {
  const scope = await createCompactionSession("sess-main", { totalLines: 5 });

  const { ws } = await openClient();
  const runId = "manual-trim-active-run";
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    projectSessionActive: true,
  });
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

    expect(compacted.ok).toBe(false);
    expect(compacted.error?.message).toContain("has an active run");
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(embeddedRunMock.waitCalls).toEqual([]);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(5);
    expect((await fs.readdir(scope.dir)).some((name) => name.includes(".bak"))).toBe(false);
  } finally {
    clearAgentRunContext(runId);
    ws.close();
  }
});

test("sessions.compact maxLines does not interrupt an active run when row trimming is a no-op", async () => {
  await createCompactionSession("sess-main", { totalLines: 2 });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(false);
  expect(compacted.payload?.kept).toBe(2);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.compact maxLines does not interrupt an active run when no transcript exists", async () => {
  await createCompactionSession("sess-main", { totalLines: 0 });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(false);
  expect(compacted.payload?.reason).toBe("no transcript");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  await withTestDir({ prefix: "openclaw-gw-sessions-nested-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-test-a" },
        },
        entries: { main: { workspace: dir } },
      },
      session: { mainKey: "main", store: storePath },
    };
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:main", storePath },
      sessionStoreEntry("sess-main"),
    );

    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5 (NVIDIA)", provider: "nvidia" },
    ];

    const context = { getRuntimeConfig: () => runtimeConfig };
    const patched = await directSessionReq<{
      entry: {
        modelOverride?: string;
        providerOverride?: string;
        model?: string;
        modelProvider?: string;
      };
      resolved?: { model?: string; modelProvider?: string };
    }>(
      "sessions.patch",
      {
        key: "agent:main:main",
        model: "nvidia/moonshotai/kimi-k2.5",
      },
      { context },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.entry.modelOverride).toBe("moonshotai/kimi-k2.5");
    expect(patched.payload?.entry.providerOverride).toBe("nvidia");
    expect(patched.payload?.entry.model).toBeUndefined();
    expect(patched.payload?.entry.modelProvider).toBeUndefined();
    expect(patched.payload?.resolved?.modelProvider).toBe("nvidia");
    expect(patched.payload?.resolved?.model).toBe("moonshotai/kimi-k2.5");

    const listed = await directSessionReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>("sessions.list", {}, { context });
    expect(listed.ok).toBe(true);
    const mainSession = listed.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(mainSession?.modelProvider).toBe("nvidia");
    expect(mainSession?.model).toBe("moonshotai/kimi-k2.5");
  });
});

test("sessions.compaction.restore waits for terminal compaction before replacing the session", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-race",
    sessionKey: "agent:main:main",
    createdAt: Date.now(),
    reason: "manual",
    summary: "checkpoint summary",
    tokensBefore: 123,
    tokensAfter: 45,
  });
  await seedSessionEntry({
    entry: sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: fixture.sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  await alignCheckpointBoundaryWithSqliteRows({
    sessionId: fixture.sessionId,
    sessionKey: "agent:main:main",
    storePath,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await vi.waitFor(() => {
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  });
  let restoreSettled = false;
  const restoreResult = rpcReq<{ sessionId: string }>(ws, "sessions.compaction.restore", {
    key: "main",
    checkpointId: "checkpoint-race",
  }).finally(() => {
    restoreSettled = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(restoreSettled).toBe(false);

  compaction.resolve({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 123,
      tokensAfter: 45,
    },
  });
  expect((await compactResult).ok).toBe(true);
  const restored = await restoreResult;
  expect(restored.ok, JSON.stringify(restored)).toBe(true);
  expect(restored.payload?.sessionId).toBeTruthy();
  expect(restored.payload?.sessionId).not.toBe(fixture.sessionId);
  ws.close();
});

test("sessions.compaction.restore leaves replacement-session work untouched when queued state is stale", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir, { legacyPreCompactionSnapshot: false });
  const checkpointEntry = compactionCheckpointEntry(fixture, {
    checkpointId: "checkpoint-stale-restore",
    sessionKey: "agent:main:main",
    createdAt: Date.now(),
    reason: "manual",
    summary: "checkpoint summary",
  });
  await seedSessionEntry({
    entry: sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [checkpointEntry],
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  const replacementSessionId = "sess-replacement-after-restore-queued";
  let replacementInterrupted = false;
  const replacementAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      replacementInterrupted = true;
    },
  });
  const blockerStarted = createDeferred();
  const releaseBlocker = createDeferred();
  const blocker = runExclusiveSessionLifecycleMutation("compact", {
    scope: storePath,
    identities: ["main", "agent:main:main", fixture.sessionId],
    run: async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    },
  });
  await blockerStarted.promise;

  const { ws } = await openClient();
  const restore = rpcReq(ws, "sessions.compaction.restore", {
    key: "main",
    checkpointId: "checkpoint-stale-restore",
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await replaceSessionEntry(
    { sessionKey: "agent:main:main", storePath },
    sessionStoreEntry(replacementSessionId),
  );

  try {
    releaseBlocker.resolve();
    await blocker;
    const response = await restore;
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("INVALID_REQUEST");
    expect(response.error?.message).toMatch(
      /checkpoint not found|changed before checkpoint restore/,
    );
    expect(replacementInterrupted).toBe(false);
  } finally {
    releaseBlocker.resolve();
    replacementAdmission.release();
    await blocker;
    ws.close();
  }
});

test("sessions.compact preserves summary-elided queued follow-up work", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-elided-followup-queue";
  const sessionKey = "agent:main:main";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey,
    storePath,
    totalLines: 3,
  });
  const queue = getFollowupQueue(sessionKey, { mode: "followup" });
  const elidedRun = {
    prompt: "please also update the changelog",
    enqueuedAt: Date.now(),
    run: {},
  } as unknown as FollowupRun;
  queue.droppedCount = 1;
  queue.summaryElisions.push({
    contextKey: "test",
    count: 1,
    sources: [elidedRun],
    summaryLines: ["elided summary"],
    sourceRefs: new WeakMap(),
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Session main has queued work; retry after it finishes.",
    });
    expect(getExistingFollowupQueue(sessionKey)?.summaryElisions).toHaveLength(1);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    clearFollowupQueue(sessionKey);
    ws.close();
  }
});
