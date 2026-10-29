import { existsSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { hasExistingNativeIncognitoCheckpointOwner } from "./session-checkpoint-native-incognito.js";
afterEach(() => vi.restoreAllMocks());
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { upsertSessionEntryCore, loadTranscriptEvents } from "./session-accessor.js";
import { restoreCompactionCheckpointSession } from "./session-accessor.sqlite-checkpoint.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";
import {
  withOwnedSessionTranscriptWrites,
  SessionTranscriptWriterClaimReboundError,
} from "./transcript-write-context.js";

it.each(["codex", "agentsapi"] as const)(
  "restores checkpoint through the real %s native owner and retires its binding in workers",
  async (kind) => {
    await withNativeBindingFixture(kind, async (fixture) => {
      const original = fixture.readEntry()!;
      await upsertSessionEntryCore(fixture.scope, {
        ...original,
        compactionCheckpoints: [
          {
            checkpointId: "native",
            sessionKey: fixture.scope.sessionKey,
            sessionId: original.sessionId,
            createdAt: 1,
            reason: "manual",
            preCompaction: { sessionId: original.sessionId, leafId: "synthetic-user" },
            postCompaction: { sessionId: original.sessionId, leafId: "synthetic-user" },
          },
        ],
      });
      expect(fixture.readBinding()).toBeDefined();
      const sql = observeHostDataSql();
      try {
        const result = await withPluginRuntimeRegistryScope(fixture.registry, () =>
          restoreCompactionCheckpointSession({
            ...fixture.scope,
            checkpointId: "native",
            expectedState: {
              sessionId: original.sessionId,
              lifecycleRevision: original.lifecycleRevision,
              activeWriterRunId: original.activeWriterRunId,
            },
          }),
        );
        expect(result.status).toBe("created");
        if (result.status !== "created") throw new Error("expected acknowledged native restore");
        expect(fixture.readEntry()?.sessionId).toBe(result.entry.sessionId);
        expect(fixture.readBinding()).toBeUndefined();
        const events = await loadTranscriptEvents({
          ...fixture.scope,
          sessionId: result.entry.sessionId,
        });
        expect(events.map((row) => (row as { id?: string }).id)).toEqual([
          result.entry.sessionId,
          "synthetic-user",
        ]);
        expect(
          sql.queries.filter((query) =>
            /\b(?:delete\s+from|insert(?:\s+or\s+\w+)?\s+into)\s+["`]?plugin_state_entries\b/i.test(
              query,
            ),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  },
);
it.each(["codex", "agentsapi"] as const)(
  "compensates the %s native binding when checkpoint agent commit rolls back",
  async (kind) => {
    await withNativeBindingFixture(kind, async (fixture) => {
      const original = fixture.readEntry()!;
      await upsertSessionEntryCore(fixture.scope, {
        ...original,
        compactionCheckpoints: [
          {
            checkpointId: "native",
            sessionKey: fixture.scope.sessionKey,
            sessionId: original.sessionId,
            createdAt: 1,
            reason: "manual",
            preCompaction: { sessionId: original.sessionId, leafId: "synthetic-user" },
            postCompaction: { sessionId: original.sessionId, leafId: "synthetic-user" },
          },
        ],
      });
      const before = fixture.readEntry();
      const binding = structuredClone(fixture.readBinding());
      const refusal = new Error("checkpoint agent commit veto");
      let commitSeen = false;
      probe.admission(admission, (request, grant, admit) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind === "session-native-binding"
        ) {
          commitSeen = true;
          expect(fixture.readBinding()).toBeUndefined();
          throw refusal;
        }
        admit(request, grant);
      });
      await expect(
        withPluginRuntimeRegistryScope(fixture.registry, () =>
          restoreCompactionCheckpointSession({
            ...fixture.scope,
            checkpointId: "native",
            expectedState: {
              sessionId: original.sessionId,
              lifecycleRevision: original.lifecycleRevision,
              activeWriterRunId: original.activeWriterRunId,
            },
          }),
        ),
      ).rejects.toBe(refusal);
      expect(commitSeen).toBe(true);
      expect(fixture.readEntry()).toEqual(before);
      expect(fixture.readBinding()).toEqual(binding);
    });
  },
);

async function withOpaqueCheckpointFixture(
  run: (
    fixture: Parameters<Parameters<typeof withNativeBindingFixture>[1]>[0],
    restore: (commitGuard?: () => void) => ReturnType<typeof restoreCompactionCheckpointSession>,
  ) => Promise<void>,
) {
  return withNativeBindingFixture(
    "agentsapi",
    async (fixture) => {
      const current = fixture.readEntry()!;
      await upsertSessionEntryCore(fixture.scope, {
        ...current,
        compactionCheckpoints: [
          {
            checkpointId: "opaque",
            sessionKey: fixture.scope.sessionKey,
            sessionId: current.sessionId,
            createdAt: 1,
            reason: "manual",
            preCompaction: { sessionId: current.sessionId, leafId: "synthetic-user" },
            postCompaction: { sessionId: current.sessionId, leafId: "synthetic-user" },
          },
        ],
      });
      return run(fixture, (commitGuard) =>
        withPluginRuntimeRegistryScope(fixture.registry, () =>
          restoreCompactionCheckpointSession({
            ...fixture.scope,
            checkpointId: "opaque",
            commitGuard,
            expectedState: {
              sessionId: current.sessionId,
              lifecycleRevision: current.lifecycleRevision,
              activeWriterRunId: current.activeWriterRunId,
            },
          }),
        ),
      );
    },
    "native",
  );
}
it("preserves a real released SDK opaque native context reset", async () => {
  await withOpaqueCheckpointFixture(async (fixture, restore) => {
    const sql = observeHostDataSql();
    try {
      const result = await restore();
      expect(result.status).toBe("created");
      expect(fixture.readBinding()).toBeUndefined();
      expect(fixture.readEntry()?.previousSessionId).toBe(fixture.scope.sessionId);
      expect(
        sql.queries.some((query) => /\bdelete\s+from\s+["`]?plugin_state_entries\b/i.test(query)),
      ).toBe(true);
    } finally {
      sql.restore();
    }
  });
});
it("rolls the real opaque SDK native binding back when the agent transaction is vetoed", async () => {
  await withOpaqueCheckpointFixture(async (fixture, restore) => {
    const before = fixture.readEntry();
    const binding = structuredClone(fixture.readBinding());
    const refusal = new Error("opaque checkpoint veto");
    let vetoed = false;
    await expect(
      restore(() => {
        if (!vetoed && fixture.readBinding() === undefined) {
          vetoed = true;
          throw refusal;
        }
      }),
    ).rejects.toBe(refusal);
    expect(vetoed).toBe(true);
    expect(fixture.readEntry()).toEqual(before);
    expect(fixture.readBinding()).toEqual(binding);
  });
});
it("refuses opaque SDK fallback inside an assert-only owned transcript context", async () => {
  await withOpaqueCheckpointFixture(async (fixture, restore) => {
    const before = fixture.readEntry();
    const binding = structuredClone(fixture.readBinding());
    await expect(
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: fixture.scope,
          assertCommitAllowed() {},
          withTranscriptWrite: async (run) => await run(),
        },
        restore,
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    expect(fixture.readEntry()).toEqual(before);
    expect(fixture.readBinding()).toEqual(binding);
  });
});
it("reports opaque SDK compensation refusal without claiming a restored binding", async () => {
  await withOpaqueCheckpointFixture(async (fixture, restore) => {
    const before = fixture.readEntry();
    const originalReset = fixture.harness.withSessionContextReset!;
    // A released opaque SDK may refuse its rollback. Preserve that contract's
    // explicit failure instead of advertising atomic restoration or overwriting a peer.
    fixture.harness.withSessionContextReset = (params, run) =>
      originalReset(params, (mutation) =>
        run({
          commit: () => mutation.commit(),
          rollback() {
            throw new Error("opaque SDK compensation refused");
          },
        }),
      );
    let vetoed = false;
    const failure = await restore(() => {
      if (!vetoed && fixture.readBinding() === undefined) {
        vetoed = true;
        throw new Error("opaque SDK agent commit refused");
      }
    }).catch((error: unknown) => error);
    expect(vetoed).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toContain("rollback failed");
    expect(fixture.readEntry()).toEqual(before);
    expect(fixture.readBinding()).toBeUndefined();
  });
});

it.each(["codex", "agentsapi"] as const)(
  "rejects mixed %s native participant and opaque SDK before checkpoint or history mutation",
  async (kind) => {
    await withNativeBindingFixture(kind, async (fixture) => {
      const original = fixture.readEntry()!;
      await upsertSessionEntryCore(fixture.scope, {
        ...original,
        compactionCheckpoints: [
          {
            checkpointId: "mixed",
            sessionKey: fixture.scope.sessionKey,
            sessionId: original.sessionId,
            createdAt: 1,
            reason: "manual",
            preCompaction: { sessionId: original.sessionId, leafId: "synthetic-user" },
            postCompaction: { sessionId: original.sessionId, leafId: "synthetic-user" },
          },
        ],
      });
      const opaqueCommit = vi.fn();
      const opaqueRollback = vi.fn();
      fixture.registry.agentHarnesses.push({
        pluginId: "core",
        source: "runtime",
        harness: {
          ...fixture.harness,
          id: "test-opaque-mixed",
          withSessionContextReset: async (_params, run) =>
            run({ commit: opaqueCommit, rollback: opaqueRollback }),
        },
      });
      const before = structuredClone(fixture.readEntry());
      const binding = structuredClone(fixture.readBinding());
      const transcript = await loadTranscriptEvents(fixture.scope);
      const sql = observeHostDataSql();
      try {
        const restore = () =>
          withPluginRuntimeRegistryScope(fixture.registry, () =>
            restoreCompactionCheckpointSession({
              ...fixture.scope,
              checkpointId: "mixed",
              expectedState: {
                sessionId: original.sessionId,
                lifecycleRevision: original.lifecycleRevision,
                activeWriterRunId: original.activeWriterRunId,
              },
            }),
          );
        await expect(restore()).rejects.toThrow(
          "Mixed native worker participants and opaque session deletion hooks are unsupported",
        );
        await expect(fixture.cut("switch", "synthetic-user")).rejects.toThrow(
          "Mixed native worker participants and opaque session deletion hooks are unsupported",
        );
        expect(opaqueCommit).not.toHaveBeenCalled();
        expect(opaqueRollback).not.toHaveBeenCalled();
        expect(fixture.readEntry()).toEqual(before);
        expect(fixture.readBinding()).toEqual(binding);
        expect(await loadTranscriptEvents(fixture.scope)).toEqual(transcript);
        expect(
          sql.queries.filter((query) =>
            /\b(?:delete\s+from|insert(?:\s+or\s+\w+)?\s+into)\s+["`]?plugin_state_entries\b/i.test(
              query,
            ),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  },
);

it.each(["codex", "agentsapi"] as const)(
  "rejects real %s minted participants in synchronous native-incognito restore, including mixed hooks",
  async (kind) => {
    for (const mixed of [false, true]) {
      await withNativeBindingFixture(
        kind,
        async (fixture) => {
          expect(hasExistingNativeIncognitoCheckpointOwner(fixture.scope)).toBe(true);
          expect(existsSync(fixture.scope.storePath)).toBe(false);
          const current = fixture.readEntry()!;
          await upsertSessionEntryCore(fixture.scope, {
            ...current,
            compactionCheckpoints: [
              {
                checkpointId: "incognito-minted",
                sessionKey: fixture.scope.sessionKey,
                sessionId: current.sessionId,
                createdAt: 1,
                reason: "manual",
                preCompaction: { sessionId: current.sessionId, leafId: "synthetic-user" },
                postCompaction: { sessionId: current.sessionId, leafId: "synthetic-user" },
              },
            ],
          });
          const opaqueCommit = vi.fn();
          if (mixed)
            fixture.registry.agentHarnesses.push({
              pluginId: "core",
              source: "runtime",
              harness: {
                ...fixture.harness,
                id: "test-incognito-opaque-mixed",
                withSessionContextReset: async (_params, run) =>
                  run({ commit: opaqueCommit, rollback() {} }),
              },
            });
          const before = structuredClone(fixture.readEntry());
          const binding = structuredClone(fixture.readBinding());
          const transcript = await loadTranscriptEvents(fixture.scope);
          const sql = observeHostDataSql();
          try {
            await expect(
              withPluginRuntimeRegistryScope(fixture.registry, () =>
                restoreCompactionCheckpointSession({
                  ...fixture.scope,
                  checkpointId: "incognito-minted",
                  expectedState: {
                    sessionId: current.sessionId,
                    lifecycleRevision: current.lifecycleRevision,
                    activeWriterRunId: current.activeWriterRunId,
                  },
                }),
              ),
            ).rejects.toThrow(
              "Native incognito checkpoint cannot synchronously commit a worker participant",
            );
            expect(opaqueCommit).not.toHaveBeenCalled();
            expect(fixture.readEntry()).toEqual(before);
            expect(fixture.readBinding()).toEqual(binding);
            expect(await loadTranscriptEvents(fixture.scope)).toEqual(transcript);
            expect(existsSync(fixture.scope.storePath)).toBe(false);
            expect(
              sql.queries.filter((query) =>
                /\b(?:delete\s+from|insert(?:\s+or\s+\w+)?\s+into)\s+["`]?plugin_state_entries\b/i.test(
                  query,
                ),
              ),
            ).toEqual([]);
          } finally {
            sql.restore();
          }
        },
        "worker",
        true,
      );
    }
  },
);

it("preserves existing-only native-incognito restore for an opaque SDK owner", async () => {
  await withNativeBindingFixture(
    "agentsapi",
    async (fixture) => {
      expect(hasExistingNativeIncognitoCheckpointOwner(fixture.scope)).toBe(true);
      const current = fixture.readEntry()!;
      await upsertSessionEntryCore(fixture.scope, {
        ...current,
        compactionCheckpoints: [
          {
            checkpointId: "incognito-opaque",
            sessionKey: fixture.scope.sessionKey,
            sessionId: current.sessionId,
            createdAt: 1,
            reason: "manual",
            preCompaction: { sessionId: current.sessionId, leafId: "synthetic-user" },
            postCompaction: { sessionId: current.sessionId, leafId: "synthetic-user" },
          },
        ],
      });
      const result = await withPluginRuntimeRegistryScope(fixture.registry, () =>
        restoreCompactionCheckpointSession({
          ...fixture.scope,
          checkpointId: "incognito-opaque",
          expectedState: {
            sessionId: current.sessionId,
            lifecycleRevision: current.lifecycleRevision,
            activeWriterRunId: current.activeWriterRunId,
          },
        }),
      );
      expect(result.status).toBe("created");
      expect(fixture.readBinding()).toBeUndefined();
      expect(existsSync(fixture.scope.storePath)).toBe(false);
    },
    "native",
    true,
  );
});
