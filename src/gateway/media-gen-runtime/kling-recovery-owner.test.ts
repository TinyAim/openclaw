import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.sqlite.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { mediaGenRuntimeFrozenPlanDigest } from "./frozen-plan.js";
import { klingFixture } from "./kling-apikey-i2v-test-fixture.js";
import {
  createKlingAttemptCorrelationStore,
  type KlingAttemptIdentity,
} from "./kling-attempt-correlation-store.js";
import { createKlingRecoveryOwner } from "./kling-recovery-owner.js";

const dirs: string[] = [];
afterEach(async () => {
  closePluginStateDatabase();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "kling-recovery-"));
  dirs.push(dir);
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
  const { input } = klingFixture();
  const digest = mediaGenRuntimeFrozenPlanDigest(input.frozenPlan)!;
  const dispatch: MediaGenRuntimeDispatch = {
    op: "reconcile",
    taskId: input.taskId,
    workspaceId: "workspace",
    correlationId: "read",
    presetId: "kling",
    mode: "image2video",
    executionAttempt: 1,
    frozenPlanDigest: digest,
    frozenPlan: input.frozenPlan,
  };
  const identity: KlingAttemptIdentity = {
    runtimeId: input.frozenPlan!.runtimeRef.runtimeId,
    workspaceId: dispatch.workspaceId,
    taskId: dispatch.taskId,
    executionAttempt: 1,
    frozenPlanDigest: digest,
    accountBindingDigest: `sha256:${"b".repeat(64)}`,
    routeId: "kling-apikey-2.6-i2v-sg/v1",
  };
  const store = createKlingAttemptCorrelationStore({ env, runtimeId: identity.runtimeId });
  const reservation = store.reserve(identity);
  store.bindRequest(identity, reservation.externalTaskId, `sha256:${"c".repeat(64)}`);
  return { env, dispatch, identity, store, reservation };
}
describe("Kling recovery owner", () => {
  it("persists an exact external-ID match before returning the provider ID", async () => {
    const { env, dispatch, identity, store, reservation } = await setup();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ code: 0, data: [{ external_id: reservation.externalTaskId, id: "000123" }] }),
    );
    const resolve = createKlingRecoveryOwner({
      store,
      resolveIdentity: async () => identity,
      baseUrl: "https://provider.example",
      apiKey: "test",
      fetchImpl,
    });
    expect(await resolve(dispatch)).toBe("000123");
    expect(store.resolve(identity)?.vendorJobId).toBe("000123");
    closePluginStateDatabase();
    expect(
      createKlingAttemptCorrelationStore({ env, runtimeId: identity.runtimeId }).resolve(identity)
        ?.vendorJobId,
    ).toBe("000123");
    expect(await resolve(dispatch)).toBe("000123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not query a mismatched scope or accept ambiguous results", async () => {
    const { dispatch, identity, store, reservation } = await setup();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        code: 0,
        data: [
          { external_id: reservation.externalTaskId, id: "one" },
          { external_id: reservation.externalTaskId, id: "two" },
        ],
      }),
    );
    const resolve = createKlingRecoveryOwner({
      store,
      resolveIdentity: async () => identity,
      baseUrl: "https://provider.example",
      apiKey: "test",
      fetchImpl,
    });
    expect(await resolve({ ...dispatch, workspaceId: "other" })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await resolve(dispatch)).toBeUndefined();
    expect(store.resolve(identity)?.vendorJobId).toBeUndefined();
  });
});
