import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMediaGenRuntimeResult } from "../../../../../../packages/contracts/src/dto/media-generation-runtime-executor/parsers/result.js";
import { ImageGenerationExactOutputError } from "../../image-generation/normalization.js";
import { createMediaGenRuntimeImageExecutor } from "./image-http.js";
import {
  createImageReceiptStore,
  parseImageReceipt,
  parseImageLifecycleReceipt,
  type ImageReceipt,
} from "./image-receipt.js";
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

describe("durable original Image lifecycle and stop-only recovery", () => {
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
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wisclaw-image-lifecycle-"));
    dirs.push(stateDir);
    const env = protectedImageEnv(stateDir);
    const generate = vi.fn(async () => ({
      images: [{ buffer: Buffer.from("controlled-image"), mimeType: "image/png" }],
    }));
    const handoff = vi.fn(
      async ({ sha256, output }: { sha256: string; output: { mimeType: string } }) => ({
        artifactId: "artifact-image-1",
        sha256,
        mimeType: output.mimeType,
      }),
    );
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
          enforcesModeration: true,
          appliesLabeling: true,
          registrationDisclosureStatus: "operator_self_declared",
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
    return {
      env,
      stateDir,
      generate,
      handoff,
      readback,
      create,
      read,
      input: protectedImageDispatch(),
    };
  }
  function lifecycle(raw: Record<string, unknown>) {
    const parsed = parseMediaGenRuntimeResult(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.imageLifecycleReceipt).toBeDefined();
    return parsed!.imageLifecycleReceipt!;
  }

  it("keeps original correlation and monotonic durable revision across duplicate submit and read restarts", async () => {
    const h = await harness();
    const original = await h.create().dispatch(h.input);
    const first = lifecycle(original);
    expect(original.status).toBe("processing");
    expect(first).toMatchObject({
      providerOutcome: "succeeded",
      submissionCorrelationId: h.input.correlationId,
    });
    const replay = await h.create().dispatch({ ...h.input, correlationId: "duplicate-request" });
    expect(replay.correlationId).toBe("duplicate-request");
    expect(lifecycle(replay)).toMatchObject({
      sequence: first.sequence,
      submissionCorrelationId: h.input.correlationId,
    });
    expect(h.handoff).not.toHaveBeenCalled();
    const settled = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "read-1" });
    const second = lifecycle(settled);
    expect(settled.status).toBe("succeeded");
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second.submissionCorrelationId).toBe(h.input.correlationId);
    const reread = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "read-2" });
    expect(lifecycle(reread).sequence).toBe(second.sequence);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.handoff).toHaveBeenCalledTimes(1);
    const { receiptPath } = await h.read();
    expect((await fs.stat(receiptPath)).mode & 0o777).toBe(0o600);
  });

  it("does not treat a missing or legacy journal as no effect or permit a new create", async () => {
    const h = await harness();
    const missing = await h.create().dispatch({ ...h.input, op: "reconcile" });
    expect(missing.status).toBe("submission_unknown");
    expect(missing.imageLifecycleReceipt).toBeUndefined();
    await h.create().dispatch(h.input);
    const { receiptPath, record } = await h.read();
    for (const key of [
      "submissionCorrelationId",
      "observedAt",
      "sequence",
      "providerOutcome",
      "providerDispatchStarted",
    ] as const)
      delete record[key];
    await fs.writeFile(receiptPath, JSON.stringify(record));
    const legacy = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "cannot-backfill" });
    expect(legacy).toMatchObject({
      status: "submission_unknown",
      runtimeJobId: record.runtimeJobId,
    });
    expect(legacy.imageLifecycleReceipt).toBeUndefined();
    expect((await h.read()).record.submissionCorrelationId).toBeUndefined();
    await h.create().dispatch({ ...h.input, op: "retry", correlationId: "cannot-recreate" });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it("only reports replacement_allowed for a durable, explicit pre-invocation failure", async () => {
    const h = await harness();
    delete h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON;
    const rejected = await h.create().dispatch(h.input);
    expect(rejected.status).toBe("failed");
    const proof = lifecycle(rejected);
    expect(proof).toMatchObject({
      providerOutcome: "not_submitted",
      retryDisposition: "replacement_allowed",
    });
    expect((await h.read()).record).toMatchObject({
      state: "failed",
      providerOutcome: "not_submitted",
      sequence: proof.sequence,
    });
    expect(h.generate).not.toHaveBeenCalled();
    const read = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "read-rejection" });
    expect(lifecycle(read).sequence).toBe(proof.sequence);
  });

  it("does not derive no-effect from ExactOutputError inside a potentially paid call", async () => {
    const h = await harness();
    h.generate.mockRejectedValue(
      new ImageGenerationExactOutputError("unknown after Provider effect"),
    );
    const first = await h.create().dispatch(h.input);
    const proof = lifecycle(first);
    expect(first.status).toBe("submission_unknown");
    expect(proof.providerOutcome).toBe("unknown");
    expect(proof.retryDisposition).toBeUndefined();
    const original = await h.read();
    expect(original.record.providerDispatchStarted).toBe(true);
    for (const op of ["retry", "reconcile"] as const) {
      const observed = await h.create().dispatch({ ...h.input, op, correlationId: `read-${op}` });
      expect(observed.runtimeJobId).toBe(first.runtimeJobId);
      expect(lifecycle(observed).sequence).toBe(proof.sequence);
    }
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it("keeps corrupt or contradictory no-effect journals closed instead of creating or handing off", async () => {
    const h = await harness();
    await h.create().dispatch(h.input);
    const { record, receiptPath } = await h.read();
    expect(parseImageReceipt({ ...record, retryDisposition: null })).toBeUndefined();
    const contradictory = {
      ...record,
      state: "failed",
      providerOutcome: "not_submitted",
      retryDisposition: "replacement_allowed",
    };
    expect(parseImageReceipt(contradictory)).toBeUndefined();
    await fs.writeFile(receiptPath, JSON.stringify(contradictory));
    const read = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "read-corrupt" });
    expect(read.status).toBe("submission_unknown");
    expect(read.imageLifecycleReceipt).toBeUndefined();
    await h.create().dispatch({ ...h.input, op: "retry", correlationId: "retry-corrupt" });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it("CAS preserves stop intent through late success and blocks every later handoff", async () => {
    const h = await harness();
    let finish!: (value: Awaited<ReturnType<typeof h.generate>>) => void;
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.generate.mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const submission = h.create().dispatch(h.input);
    await running;
    const before = (await h.read()).record;
    const stop = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", stopOnly: true, correlationId: "stop-original" });
    expect(stop).toMatchObject({
      status: "canceled",
      runtimeStopOutcome: { state: "not_supported" },
      runtimeJobId: before.runtimeJobId,
    });
    const stopProof = lifecycle(stop);
    expect(stopProof.providerOutcome).toBe("unknown");
    expect((await h.read()).record.stopRequested).toBe(true);
    finish({ images: [{ buffer: Buffer.from("late-image"), mimeType: "image/png" }] });
    expect(await submission).toMatchObject({ status: "canceled" });
    const late = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "read-late" });
    expect(late).toMatchObject({ status: "canceled", runtimeStopOutcome: { state: "confirmed" } });
    expect(lifecycle(late)).toMatchObject({
      providerOutcome: "succeeded",
      submissionCorrelationId: h.input.correlationId,
    });
    expect(lifecycle(late).sequence).toBeGreaterThan(stopProof.sequence);
    const again = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", stopOnly: true, correlationId: "stop-again" });
    expect(lifecycle(again).sequence).toBe(lifecycle(late).sequence);
    expect(h.handoff).not.toHaveBeenCalled();
    expect(h.readback).not.toHaveBeenCalled();
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("stop-only with no journal remains unknown and never manufactures no-effect proof", async () => {
    const h = await harness();
    const stop = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", stopOnly: true, correlationId: "stop-missing" });
    expect(stop).toMatchObject({ status: "submission_unknown" });
    expect(parseMediaGenRuntimeResult(stop)).not.toBeNull();
    expect(stop.runtimeStopOutcome).toBeUndefined();
    expect(stop.imageLifecycleReceipt).toBeUndefined();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.handoff).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(h.stateDir, "media-gen-image-receipts-v1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("after a lost handoff ACK only reads the exact original tuple and settles committed proof", async () => {
    const h = await harness();
    h.handoff.mockRejectedValue(new Error("ACK lost after possible commit"));
    const submitted = await h.create().dispatch(h.input);
    const poll = await h
      .create()
      .dispatch({ ...h.input, op: "poll", runtimeJobId: String(submitted.runtimeJobId) });
    expect(poll.status).toBe("processing");
    const pending = lifecycle(poll);
    expect(pending.providerOutcome).toBe("succeeded");
    expect((await h.read()).record.handoffStarted).toBe(true);
    delete h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON;
    const read = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "read-handoff" });
    expect(read.status).toBe("processing");
    expect(lifecycle(read).sequence).toBe(pending.sequence);
    const record = (await h.read()).record;
    h.readback.mockResolvedValue({
      state: "committed",
      artifact: {
        artifactId: "artifact-original",
        mimeType: record.mimeType!,
        sha256: record.sha256,
      },
    });
    const settled = await h
      .create()
      .dispatch({ ...h.input, op: "reconcile", correlationId: "read-commit" });
    expect(settled).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-original" },
    });
    expect(lifecycle(settled).sequence).toBeGreaterThan(pending.sequence);
    expect(h.readback).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionCorrelationId: h.input.correlationId,
        runtimeJobId: record.runtimeJobId,
        sha256: record.sha256,
        dispatch: expect.objectContaining({
          executionAttempt: h.input.executionAttempt,
          frozenPlanDigest: h.input.frozenPlanDigest,
        }),
      }),
    );
    expect(h.handoff).toHaveBeenCalledTimes(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting CAS identity and never steals a live expired journal lock", async () => {
    const h = await harness();
    await h.create().dispatch(h.input);
    const { record, receiptPath } = await h.read();
    const store = createImageReceiptStore({ env: h.env, runtimeId: "runtime-1" });
    await expect(
      store.update(h.input, (current) => ({ ...current, submissionCorrelationId: "other" })),
    ).rejects.toThrow("cas_conflict");
    await expect(
      store.update(h.input, (current) => ({
        ...current,
        state: "failed",
        providerOutcome: "not_submitted",
        retryDisposition: "replacement_allowed",
      })),
    ).rejects.toThrow("cas_conflict");
    const lockPath = `${receiptPath}.lock`;
    const payload = JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" });
    await fs.writeFile(lockPath, payload, { mode: 0o600 });
    await expect(
      store.update(h.input, (current) => ({ ...current, stopRequested: true })),
    ).rejects.toBeDefined();
    expect(await fs.readFile(lockPath, "utf8")).toBe(payload);
    expect((await h.read()).record.sequence).toBe(record.sequence);
  }, 10_000);

  it("advertises dispatcher2 only from constructed lifecycle source while real seams stay closed", async () => {
    const h = await harness();
    const registration = await h.create().registrationSnapshot!(h.input.workspaceId);
    expect(registration.imageExecutionEvidence[0]?.readinessReceipt).toMatchObject({
      executor: true,
      terminalReceiptParser: true,
      retry: true,
      revisions: { dispatcherRevision: 2, transportRevision: 0, adapterRevision: 1 },
      transport: false,
      artifactIngest: false,
      cancellation: false,
      ready: false,
      activeExecutionAllowed: false,
    });
    const malformed = {
      schemaVersion: 1,
      executionAttempt: 1,
      frozenPlanDigest: h.input.frozenPlanDigest,
      submissionCorrelationId: "corr-1",
      observedAt: new Date().toISOString(),
      sequence: 1,
      providerOutcome: "unknown",
      retryDisposition: "replacement_allowed",
    };
    expect(parseImageLifecycleReceipt(malformed)).toBeUndefined();
  });
});
