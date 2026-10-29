import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.sqlite.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";
import { mediaGenRuntimeFrozenPlanDigest } from "./frozen-plan.js";
import { klingFixture } from "./kling-apikey-i2v-test-fixture.js";
import type { KlingAttemptIdentity } from "./kling-attempt-correlation-store.js";

const dirs: string[] = [];
afterEach(async () => {
  closePluginStateDatabase();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Kling factory scoped owner integration", () => {
  it("does not advertise the API-key route without a runtime preparation owner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kling-factory-disabled-"));
    dirs.push(dir);
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: dir,
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "workspace",
        KLING_API_KEY: "key",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
        OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://label.example/apply",
      },
    });
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.supportedPresetIds).toEqual([]);
      expect(
        result.capabilityRouteClaims.some(
          (claim) => claim.route.routeId === "kling-apikey-2.6-i2v-sg/v1",
        ),
      ).toBe(false);
    }
  });
  it("keeps the legacy admitted route and polls an old API-key receipt without enabling new API-key submits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kling-factory-mixed-"));
    dirs.push(dir);
    const { input } = klingFixture();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const target = String(url);
      calls.push(target);
      return Response.json({ code: 0, data: [{ id: "old-task", status: "processing" }] });
    });
    const result = createOpenClawMediaGenRuntimeFromEnv({
      fetchImpl,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: dir,
        OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: input.frozenPlan!.runtimeRef.runtimeId,
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token",
        OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "workspace",
        KLING_API_KEY: "key",
        KLING_ACCESS_KEY: "access",
        KLING_SECRET: "secret",
        KLING_BASE_URL: "",
        OPENCLAW_KLING_BASE_URL: "",
        OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
        OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://label.example/apply",
      },
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.supportedPresetIds).toContain("kling");
    expect(
      result.capabilityRouteClaims.some(
        (claim) => claim.presetId === "kling" && claim.mode === "text2video",
      ),
    ).toBe(true);
    expect(
      result.capabilityRouteClaims.some(
        (claim) => claim.route.routeId === "kling-apikey-2.6-i2v-sg/v1",
      ),
    ).toBe(false);
    const receipt: MediaGenRuntimeDispatch = {
      op: "poll",
      taskId: input.taskId,
      workspaceId: "workspace",
      correlationId: "read",
      presetId: "kling",
      mode: "image2video",
      runtimeJobId: "old-task",
      frozenPlan: input.frozenPlan,
    };
    expect(await result.executor.dispatch(receipt)).toMatchObject({
      status: "processing",
      runtimeJobId: "old-task",
    });
    expect(calls).toEqual(["https://api-singapore.klingai.com/tasks?task_ids=old-task"]);
    expect(
      await result.executor.dispatch({ ...receipt, op: "submit", runtimeJobId: undefined }),
    ).toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(1);
  });
  it("redeems an Artifact, saves the attempt, and recovers by external ID after a lost submit receipt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kling-factory-"));
    dirs.push(dir);
    const { input, prepared } = klingFixture();
    const plan = input.frozenPlan!;
    const digest = mediaGenRuntimeFrozenPlanDigest(plan)!;
    const source = input.sources![0]!.source;
    if (!source.bytes || !source.sha256) throw new Error("fixture missing source bytes");
    const identity: KlingAttemptIdentity = {
      runtimeId: plan.runtimeRef.runtimeId,
      workspaceId: "workspace",
      taskId: input.taskId,
      executionAttempt: 1,
      frozenPlanDigest: digest,
      accountBindingDigest: `sha256:${"b".repeat(64)}`,
      routeId: "kling-apikey-2.6-i2v-sg/v1",
    };
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
      OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
      OPENCLAW_MEDIA_GEN_RUNTIME_ID: identity.runtimeId,
      OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "runtime-token",
      OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: identity.workspaceId,
      KLING_API_KEY: "key",
      KLING_BASE_URL: "https://legacy.example",
      OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
      OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://label.example/apply",
    };
    let externalTaskId = "";
    const providerPosts: string[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const target = String(url);
        if (target === "https://moderation.example/check") return Response.json({ allowed: true });
        if (target.endsWith("/runtime/reference-grant"))
          return Response.json({
            data: { grantToken: "grant", mimeType: source.mimeType, sha256: source.sha256 },
          });
        if (target.endsWith("/runtime/reference-redeem"))
          return new Response(new Uint8Array(source.bytes!), {
            headers: { "content-type": source.mimeType },
          });
        if (target === "https://api-singapore.klingai.com/image-to-video/kling-2.6") {
          providerPosts.push(target);
          externalTaskId = JSON.parse(String(init?.body)).options.external_task_id;
          throw new Error("simulated receipt loss");
        }
        if (target.includes("external_task_ids="))
          return Response.json({ code: 0, data: [{ external_id: externalTaskId, id: "000123" }] });
        if (target.includes("task_ids=000123"))
          return Response.json({ code: 0, data: [{ id: "000123", status: "processing" }] });
        throw new Error(`unexpected request ${target}`);
      },
    );
    const port = {
      resolveSubmitIdentity: async () => identity,
      resolveRecoveryIdentity: async () => identity,
      prepareFrames: vi.fn(async () => prepared.frames),
    };
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: input.taskId,
      workspaceId: identity.workspaceId,
      correlationId: "submit",
      presetId: "kling",
      mode: "image2video",
      prompt: input.prompt,
      durationSec: input.durationSec,
      resolution: input.resolution,
      references: [
        { kind: "artifact", artifactId: "artifact-frame", role: "first_frame", ordinal: 0 },
      ],
      executionAttempt: 1,
      frozenPlanDigest: digest,
      frozenPlan: plan,
    };
    const first = createOpenClawMediaGenRuntimeFromEnv({
      env,
      fetchImpl,
      klingPreparationOwner: port,
    });
    expect(first.enabled).toBe(true);
    if (!first.enabled) return;
    expect(
      first.capabilityRouteClaims.some((claim) => claim.route.routeId === identity.routeId),
    ).toBe(true);
    expect(await first.executor.dispatch(dispatch)).toMatchObject({ status: "submission_unknown" });
    expect(providerPosts).toHaveLength(1);
    expect(externalTaskId).toMatch(/^wis_[a-f0-9]{32}$/);
    closePluginStateDatabase();
    const resumed = createOpenClawMediaGenRuntimeFromEnv({
      env,
      fetchImpl,
      klingPreparationOwner: port,
    });
    expect(resumed.enabled).toBe(true);
    if (!resumed.enabled) return;
    expect(
      await resumed.executor.dispatch({ ...dispatch, op: "reconcile", correlationId: "reconcile" }),
    ).toMatchObject({ status: "processing", runtimeJobId: "000123" });
    expect(providerPosts).toHaveLength(1);
    expect(port.prepareFrames).toHaveBeenCalledTimes(1);
  });
});
