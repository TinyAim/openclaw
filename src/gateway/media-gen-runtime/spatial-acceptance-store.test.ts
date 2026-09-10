import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closePluginStateDatabase } from "../../plugin-state/plugin-state-store.js";
import type {
  MediaGenRuntimeDispatch,
  MediaGenRuntimeSpatialInputAcceptance,
} from "../media-gen-runtime-http.js";
import { createMediaGenRuntimeSpatialAcceptanceStore } from "./spatial-acceptance-store.js";

const frozenPlanDigest = `sha256:${"c".repeat(64)}`;
const providerRequestDigest = `sha256:${"d".repeat(64)}`;
const envelopeDigest = `spa_env:sha256:${"a".repeat(64)}`;
const checksum = `sha256:${"b".repeat(64)}`;
const dirs: string[] = [];

afterEach(async () => {
  closePluginStateDatabase();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function dispatch(overrides: Partial<MediaGenRuntimeDispatch> = {}): MediaGenRuntimeDispatch {
  return {
    op: "submit",
    taskId: "task-spatial-acceptance",
    workspaceId: "workspace-spatial-acceptance",
    correlationId: "correlation-spatial-acceptance",
    presetId: "seedance",
    mode: "image2video",
    executionAttempt: 1,
    frozenPlanDigest,
    spatialInputEnvelope: {
      schemaVersion: 1,
      envelopeDigest,
      references: [
        {
          artifactId: "artifact-composition",
          checksum,
          role: "composition_frame",
          ordinal: 0,
        },
      ],
    },
    ...overrides,
  };
}

function acceptance(): MediaGenRuntimeSpatialInputAcceptance {
  return {
    ...dispatch().spatialInputEnvelope!,
    executionAttempt: 1,
    frozenPlanDigest,
    runtimeJobId: "seedance-v2:image2video:provider-job-1",
    providerRequestDigest,
  };
}

async function env(): Promise<NodeJS.ProcessEnv> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "media-gen-spatial-acceptance-"));
  dirs.push(stateDir);
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

describe("MediaGen runtime Spatial acceptance store", () => {
  it("persists the exact acceptance and resolves it after reopening SQLite", async () => {
    const runtimeEnv = await env();
    const first = createMediaGenRuntimeSpatialAcceptanceStore({
      env: runtimeEnv,
      runtimeId: "runtime-spatial-acceptance",
    });
    first.persist(dispatch(), acceptance());
    expect(first.resolveRuntimeJobId(dispatch({ op: "reconcile" }))).toBe(
      "seedance-v2:image2video:provider-job-1",
    );

    closePluginStateDatabase();
    const reopened = createMediaGenRuntimeSpatialAcceptanceStore({
      env: runtimeEnv,
      runtimeId: "runtime-spatial-acceptance",
    });
    expect(reopened.resolve(dispatch({ op: "reconcile" }))).toEqual(acceptance());
  });

  it("does not resolve a different attempt or a mismatched explicit job", async () => {
    const runtimeEnv = await env();
    const store = createMediaGenRuntimeSpatialAcceptanceStore({
      env: runtimeEnv,
      runtimeId: "runtime-spatial-acceptance",
    });
    store.persist(dispatch(), acceptance());

    expect(store.resolve(dispatch({ op: "reconcile", executionAttempt: 2 }))).toBeUndefined();
    expect(
      store.resolve(
        dispatch({ op: "reconcile", runtimeJobId: "seedance-v2:image2video:other-job" }),
      ),
    ).toBeUndefined();
  });

  it("rejects a conflicting acceptance for the same frozen attempt", async () => {
    const runtimeEnv = await env();
    const store = createMediaGenRuntimeSpatialAcceptanceStore({
      env: runtimeEnv,
      runtimeId: "runtime-spatial-acceptance",
    });
    store.persist(dispatch(), acceptance());

    await expect(() =>
      store.persist(dispatch(), {
        ...acceptance(),
        runtimeJobId: "seedance-v2:image2video:provider-job-2",
      }),
    ).toThrow("media_gen_spatial_acceptance_conflict");
  });
});
