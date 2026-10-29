import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.sqlite.js";
import { mediaGenRuntimeFrozenPlanDigest } from "./frozen-plan.js";
import { klingFixture } from "./kling-apikey-i2v-test-fixture.js";
import { createKlingApiKeyI2VVendor } from "./kling-apikey-i2v-vendor.js";
import {
  createKlingAttemptCorrelationStore,
  type KlingAttemptIdentity,
} from "./kling-attempt-correlation-store.js";
import { createKlingSubmissionOwner } from "./kling-submission-owner.js";

const dirs: string[] = [];
afterEach(async () => {
  closePluginStateDatabase();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "kling-owner-"));
  dirs.push(dir);
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
  const { input, prepared } = klingFixture();
  input.workspaceId = "workspace";
  input.executionAttempt = 1;
  input.frozenPlanDigest = mediaGenRuntimeFrozenPlanDigest(input.frozenPlan)!;
  const identity: KlingAttemptIdentity = {
    runtimeId: input.frozenPlan!.runtimeRef.runtimeId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    executionAttempt: 1,
    frozenPlanDigest: input.frozenPlanDigest,
    accountBindingDigest: `sha256:${"b".repeat(64)}`,
    routeId: "kling-apikey-2.6-i2v-sg/v1",
  };
  const store = createKlingAttemptCorrelationStore({ env, runtimeId: identity.runtimeId });
  const prepareFrames = vi.fn(async () => prepared.frames);
  const prepareSubmission = createKlingSubmissionOwner({
    store,
    resolveIdentity: async () => identity,
    prepareFrames,
  });
  return { env, input, identity, store, prepareSubmission, prepareFrames };
}
describe("Kling submission owner", () => {
  it("reserves and binds the original attempt before POST and prohibits a repeated POST after timeout", async () => {
    const { env, input, identity, store, prepareSubmission, prepareFrames } = await setup();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        throw new Error("timeout");
      },
    );
    const vendor = createKlingApiKeyI2VVendor({ apiKey: "test", fetchImpl, prepareSubmission });
    const first = await vendor.submit(input);
    expect(first.state).toBe("submission_unknown");
    const stored = store.resolve(identity);
    expect(stored?.externalTaskId).toMatch(/^wis_[a-f0-9]{32}$/);
    expect(stored?.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    closePluginStateDatabase();
    const reopened = createKlingAttemptCorrelationStore({ env, runtimeId: identity.runtimeId });
    expect(reopened.resolve(identity)).toEqual(stored);
    expect(await vendor.submit(input)).toMatchObject({ state: "submission_unknown" });
    expect(prepareFrames).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("persists the provider task receipt and refuses altered frozen plan or scope", async () => {
    const { input, identity, store, prepareSubmission, prepareFrames } = await setup();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ code: 0, data: { id: "000123" } }),
    );
    const vendor = createKlingApiKeyI2VVendor({ apiKey: "test", fetchImpl, prepareSubmission });
    expect(await vendor.submit(input)).toMatchObject({
      state: "processing",
      vendorJobId: "000123",
    });
    expect(store.resolve(identity)?.vendorJobId).toBe("000123");
    expect(await vendor.submit(input)).toMatchObject({
      state: "processing",
      vendorJobId: "000123",
    });
    await expect(prepareSubmission({ ...input, workspaceId: "other" })).rejects.toThrow();
    await expect(
      prepareSubmission({ ...input, frozenPlanDigest: `sha256:${"a".repeat(64)}` }),
    ).rejects.toThrow();
    expect(prepareFrames).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
