import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.sqlite.js";
import {
  createKlingAttemptCorrelationStore,
  type KlingAttemptIdentity,
} from "./kling-attempt-correlation-store.js";

const dirs: string[] = [];
afterEach(async () => {
  closePluginStateDatabase();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "kling-correlation-"));
  dirs.push(dir);
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
  const identity: KlingAttemptIdentity = {
    runtimeId: "runtime",
    workspaceId: "workspace",
    taskId: "task",
    executionAttempt: 1,
    frozenPlanDigest: `sha256:${"a".repeat(64)}`,
    accountBindingDigest: `sha256:${"b".repeat(64)}`,
    routeId: "kling-apikey-2.6-i2v-sg/v1",
  };
  return {
    env,
    identity,
    store: createKlingAttemptCorrelationStore({ env, runtimeId: "runtime" }),
  };
}
describe("Kling attempt correlation reservation", () => {
  it("persists before POST and treats a reopened or repeated attempt as recovery-only", async () => {
    const { env, identity, store } = await setup();
    const first = store.reserve(identity);
    expect(first.kind).toBe("created");
    expect(() => store.bindVendorJob(identity, first.externalTaskId, "provider-job")).toThrow();
    const digest = `sha256:${"c".repeat(64)}`;
    store.bindRequest(identity, first.externalTaskId, digest);
    store.bindVendorJob(identity, first.externalTaskId, "provider-job");
    closePluginStateDatabase();
    const reopened = createKlingAttemptCorrelationStore({ env, runtimeId: "runtime" });
    expect(reopened.resolve(identity)).toEqual({
      externalTaskId: first.externalTaskId,
      providerRequestDigest: digest,
      vendorJobId: "provider-job",
    });
    expect(reopened.reserve(identity)).toEqual({
      kind: "existing",
      externalTaskId: first.externalTaskId,
    });
    expect(() =>
      reopened.bindRequest(identity, first.externalTaskId, `sha256:${"d".repeat(64)}`),
    ).toThrow();
    expect(reopened.resolve(identity)?.providerRequestDigest).toBe(digest);
    expect(() => reopened.bindVendorJob(identity, first.externalTaskId, "other-job")).toThrow();
    expect(reopened.resolve(identity)?.vendorJobId).toBe("provider-job");
  });
  it("does not reuse one attempt across a changed plan or account and separates scoped attempts", async () => {
    const { identity, store } = await setup();
    const first = store.reserve(identity);
    expect(() =>
      store.reserve({ ...identity, frozenPlanDigest: `sha256:${"d".repeat(64)}` }),
    ).toThrow();
    expect(() =>
      store.reserve({ ...identity, accountBindingDigest: `sha256:${"e".repeat(64)}` }),
    ).toThrow();
    expect(store.resolve(identity)?.externalTaskId).toBe(first.externalTaskId);
    expect(store.reserve({ ...identity, executionAttempt: 2 }).externalTaskId).not.toBe(
      first.externalTaskId,
    );
    expect(store.resolve({ ...identity, workspaceId: "other" })).toBeUndefined();
  });
});
