import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMediaGenRuntimeResult } from "../../../../../../packages/contracts/src/dto/media-generation-runtime-executor/parsers/result.js";
import { createMediaGenRuntimeImageExecutor } from "./image-http.js";
import { type ImageReceipt } from "./image-receipt.js";
import {
  protectedImageDispatch,
  protectedImageEnv,
  protectedImageRoute,
} from "./protected-image.test-helpers.js";
import type { MediaGenRuntimeBridge } from "./types.js";

vi.mock("../../image-generation/runtime.js", () => ({ generateImage: vi.fn() }));
vi.mock("../../media-generation/registry.js", async () => {
  const { protectedImageModelAuth } = await import("./protected-image.test-helpers.js");
  const { buildOpenAIImageGenerationProvider } =
    await import("../../../extensions/openai/image-generation-provider.js");
  return {
    getImageGenerationProvider: (provider: string) =>
      provider === "openai"
        ? buildOpenAIImageGenerationProvider(protectedImageModelAuth)
        : undefined,
  };
});

describe("original Image handoff and durable stop concurrency", () => {
  const dirs: string[] = [];
  beforeEach(() => {
    for (const key of ["OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"])
      vi.stubEnv(key, undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });
  async function harness() {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wisclaw-image-handoff-race-"));
    dirs.push(stateDir);
    const env = protectedImageEnv(stateDir);
    const generate = vi.fn(async () => ({
      images: [{ buffer: Buffer.from("controlled-image"), mimeType: "image/png" }],
    }));
    const handoff = vi.fn<MediaGenRuntimeBridge["handoffArtifact"]>(async (input) => ({
      artifactId: "artifact-original",
      sha256: input.sha256,
      mimeType: input.output.mimeType,
    }));
    const readback = vi.fn<NonNullable<MediaGenRuntimeBridge["readImageArtifactHandoff"]>>(
      async () => ({ state: "pending" }),
    );
    const create = () =>
      createMediaGenRuntimeImageExecutor({
        env,
        runtimeId: "runtime-1",
        route: protectedImageRoute(),
        getConfig: () => ({}),
        bridge: {
          handoffArtifact: handoff,
          readImageArtifactHandoff: readback,
        } as unknown as MediaGenRuntimeBridge,
        compliance: {
          enforcesModeration: false,
          appliesLabeling: false,
          registrationDisclosureStatus: "undeclared",
        },
        generateImageFn: generate as never,
      });
    const read = async () => {
      const dir = path.join(stateDir, "media-gen-image-receipts-v1");
      const file = (await fs.readdir(dir)).find((name) => name.endsWith(".json"));
      if (!file) throw new Error("receipt missing");
      const receiptPath = path.join(dir, file);
      return {
        receiptPath,
        record: JSON.parse(await fs.readFile(receiptPath, "utf8")) as ImageReceipt,
      };
    };
    return { env, generate, handoff, readback, create, read, input: protectedImageDispatch() };
  }

  it.each(["POST", "GET"] as const)(
    "persists stop while Artifact %s is in flight and suppresses its late committed result",
    async (operation) => {
      const h = await harness();
      await h.create().dispatch(h.input);
      const original = (await h.read()).record;
      let enter!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const response = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const artifact = {
        artifactId: "artifact-original",
        sha256: original.sha256!,
        mimeType: original.mimeType!,
      };
      if (operation === "GET") {
        h.handoff.mockRejectedValue(new Error("lost POST ACK"));
        await h.create().dispatch({ ...h.input, op: "reconcile", correlationId: "first-handoff" });
        h.readback.mockImplementation(async () => {
          enter();
          await response;
          return { state: "committed", artifact };
        });
      } else {
        h.handoff.mockImplementation(async () => {
          enter();
          await response;
          return artifact;
        });
      }
      const observing = h
        .create()
        .dispatch({ ...h.input, op: "reconcile", correlationId: "inflight-handoff" });
      await entered;
      let late: Record<string, unknown> | undefined;
      try {
        const stop = await h.create().dispatch({
          ...h.input,
          op: "reconcile",
          stopOnly: true,
          correlationId: "stop-inflight",
        });
        expect((await h.read()).record.stopRequested).toBe(true);
        expect(stop).toMatchObject({
          status: "canceled",
          runtimeStopOutcome: { state: "confirmed" },
        });
        expect(parseMediaGenRuntimeResult(stop)).not.toBeNull();
      } finally {
        finish();
        late = await observing;
      }
      expect(late?.status).toBe("canceled");
      expect(late?.artifact).toBeUndefined();
      const after = (await h.read()).record;
      expect(after).toMatchObject({
        stopRequested: true,
        handoffStarted: true,
        runtimeJobId: original.runtimeJobId,
        submissionCorrelationId: h.input.correlationId,
      });
      expect(after.artifact).toBeUndefined();
      expect(after.sequence).toBeGreaterThan(original.sequence!);
      for (const op of ["poll", "reconcile", "retry"] as const) {
        const read = await h.create().dispatch({
          ...h.input,
          op,
          runtimeJobId: op === "poll" ? original.runtimeJobId : undefined,
          correlationId: `after-stop-${op}`,
        });
        expect(read).toMatchObject({
          status: "canceled",
          runtimeStopOutcome: { state: "confirmed" },
        });
        expect(read.artifact).toBeUndefined();
      }
      expect(h.generate).toHaveBeenCalledTimes(1);
      expect(h.handoff).toHaveBeenCalledTimes(1);
      expect(h.readback).toHaveBeenCalledTimes(operation === "GET" ? 1 : 0);
    },
    10_000,
  );

  it("reports unknown when a live journal owner prevents the stop fence from persisting", async () => {
    const h = await harness();
    await h.create().dispatch(h.input);
    const { record, receiptPath } = await h.read();
    const lockPath = `${receiptPath}.lock`;
    const payload = JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" });
    await fs.writeFile(lockPath, payload, { mode: 0o600 });
    const stop = await h
      .create()
      .dispatch({ ...h.input, op: "cancel", runtimeJobId: record.runtimeJobId });
    expect(stop).toMatchObject({
      status: "canceled",
      runtimeStopOutcome: { state: "unknown", reasonCode: "transport_uncertain" },
    });
    expect(parseMediaGenRuntimeResult(stop)).not.toBeNull();
    expect((await h.read()).record.stopRequested).toBeUndefined();
    expect((await h.read()).record.sequence).toBe(record.sequence);
    expect(await fs.readFile(lockPath, "utf8")).toBe(payload);
    expect(h.handoff).not.toHaveBeenCalled();
  }, 10_000);

  it("uses only original GET readback when a second observer races an in-flight first POST", async () => {
    const h = await harness();
    await h.create().dispatch(h.input);
    const record = (await h.read()).record;
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.handoff.mockImplementation(async (input) => {
      enter();
      await response;
      return {
        artifactId: "artifact-original",
        sha256: input.sha256,
        mimeType: input.output.mimeType,
      };
    });
    const first = h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "first-observer" });
    await entered;
    try {
      const second = await h
        .create()
        .dispatch({ ...h.input, op: "reconcile", correlationId: "second-observer" });
      expect(second.status).toBe("processing");
      expect(h.readback).toHaveBeenCalledWith(
        expect.objectContaining({
          submissionCorrelationId: h.input.correlationId,
          runtimeJobId: record.runtimeJobId,
          dispatch: expect.objectContaining({
            executionAttempt: h.input.executionAttempt,
            frozenPlanDigest: h.input.frozenPlanDigest,
          }),
        }),
      );
    } finally {
      finish();
      expect((await first).status).toBe("succeeded");
    }
    const settled = await h.create().dispatch({ ...h.input, op: "reconcile" });
    expect(settled.status).toBe("succeeded");
    expect(h.handoff).toHaveBeenCalledTimes(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("reclaims a definitely dead owner for stop while preserving the original unknown Provider attempt", async () => {
    const h = await harness();
    h.generate.mockRejectedValue(new Error("Provider outcome unknown"));
    const first = await h.create().dispatch(h.input);
    const { record, receiptPath } = await h.read();
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { env: {} });
    expect(child.status).toBe(0);
    expect(child.pid).toBeGreaterThan(0);
    await fs.writeFile(
      `${receiptPath}.lock`,
      JSON.stringify({ pid: child.pid, createdAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    const stop = await h.create().dispatch({ ...h.input, op: "reconcile", stopOnly: true });
    expect(stop).toMatchObject({
      status: "canceled",
      runtimeJobId: record.runtimeJobId,
      runtimeStopOutcome: { state: "not_supported" },
    });
    expect((await h.read()).record).toMatchObject({
      stopRequested: true,
      providerOutcome: "unknown",
      submissionCorrelationId: h.input.correlationId,
    });
    expect((await h.read()).record.sequence).toBeGreaterThan(record.sequence!);
    const replay = await h
      .create()
      .dispatch({ ...h.input, op: "retry", correlationId: "no-recreate-after-death" });
    expect(replay.runtimeJobId).toBe(first.runtimeJobId);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.handoff).not.toHaveBeenCalled();
  }, 10_000);
});
