import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// Isolate optional provider loading only. Executor, receipt store and handoff are real.
vi.mock("../../image-generation/runtime.js", () => ({ generateImage: vi.fn() }));
import {
  AUTH_TOKEN,
  createTestGatewayServer,
  withGatewayTempConfig,
} from "../server-http.test-harness.js";
import {
  createMediaGenRuntimeImageExecutor,
  MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH,
} from "./image-http.js";
import type { MediaGenRuntimeBridge } from "./types.js";
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function imageDispatch(overrides: Record<string, unknown> = {}) {
  const constraintPaths = [
    "mediaClass",
    "generationScenario",
    "compiledPrompt",
    "output.aspectRatio",
    "output.resolution",
    "output.format",
    "output.alphaPolicy",
    "output.qualityIntent",
  ];
  const plan = {
    schemaVersion: 3,
    previewId: "preview-1",
    presetId: "image-route-1",
    mediaClass: "image",
    generationIntent: {
      schemaVersion: 1,
      identity: { projectId: "p-1" },
      generationScenario: "text_to_image",
      compiledPrompt: "a product still life",
      references: [],
      operations: [],
      preserveConstraints: [],
      compiledSourceDigests: { sourceArtifactDigests: [], sourceAssetRefDigests: [] },
      output: {
        aspectRatio: "1:1",
        resolution: "1024x1024",
        format: "png",
        alphaPolicy: "forbid",
        qualityIntent: "high",
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: "image-intent-v1:test",
    generationScenario: "text_to_image",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: "route-1",
      providerId: "provider-1",
      modelId: "model-1",
      endpointId: "images.generate",
      region: "local",
      accountTier: "standard",
    },
    capabilityProfileRef: {
      profileId: "profile-1",
      revision: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
    adapterRevision: "adapter-1",
    runtimeRef: { runtimeId: "runtime-1", lastSeenAt: "2026-09-10T00:00:00.000Z" },
    constraintPlan: constraintPaths.map((intentPath) => ({
      intentPath,
      required: true,
      support: intentPath === "compiledPrompt" ? "prompt" : "native",
    })),
    inputFingerprint: "b".repeat(64),
    intentFingerprint: "c".repeat(64),
    resolvedPreservePlanDigest: `sha256:${"d".repeat(64)}`,
    resolvedReferenceBindingDigest: `sha256:${"e".repeat(64)}`,
    resolvedOutputSpecDigest: `sha256:${"f".repeat(64)}`,
    adapterCompilationDigest: `sha256:${"0".repeat(64)}`,
  };
  return {
    schemaVersion: 1,
    op: "submit",
    taskId: "task-1",
    workspaceId: "workspace-1",
    correlationId: "corr-1",
    presetId: "image-route-1",
    mediaClass: "image",
    frozenImagePlan: plan,
    frozenPlanDigest: `sha256:${createHash("sha256").update(stableJson(plan)).digest("hex")}`,
    executionAttempt: 1,
    ...overrides,
  };
}

function imageRoute() {
  return {
    providerId: "provider-1",
    modelId: "model-1",
    routeId: "route-1",
    endpointId: "images.generate",
    region: "local",
    accountTier: "standard",
    adapterRevision: "adapter-1",
    profileId: "profile-1",
    profileRevision: 1,
    profileDigest: `sha256:${"a".repeat(64)}`,
  };
}

function imageBridge() {
  return {
    handoffArtifact: vi.fn(
      async ({ sha256, output }: { sha256: string; output: { mimeType: string } }) => ({
        artifactId: "artifact-image-1",
        sha256,
        mimeType: output.mimeType,
      }),
    ),
  } as unknown as MediaGenRuntimeBridge;
}

describe("Host image stop-only and stop honesty", () => {
  async function harness() {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wisclaw-host-image-stop-"));
    const bridge = imageBridge();
    let complete!: (value: { images: Array<{ buffer: Buffer; mimeType: string }> }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const generation = new Promise<{ images: Array<{ buffer: Buffer; mimeType: string }> }>(
      (resolve) => {
        complete = resolve;
      },
    );
    const generateImageFn = vi.fn(() => {
      entered();
      return generation;
    });
    const executor = createMediaGenRuntimeImageExecutor({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      runtimeId: "runtime-1",
      route: imageRoute(),
      bridge,
      getConfig: () => ({}) as never,
      compliance: {
        enforcesModeration: true,
        appliesLabeling: true,
        registrationDisclosureStatus: "operator_self_declared",
      },
      generateImageFn: generateImageFn as never,
    });
    const input = imageDispatch() as Parameters<typeof executor.dispatch>[0];
    const submission = executor.dispatch(input);
    await started;
    const [receiptFile] = await fs.readdir(path.join(stateDir, "media-gen-image-receipts-v1"));
    const receiptPath = path.join(stateDir, "media-gen-image-receipts-v1", receiptFile!);
    const initial = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    return {
      executor,
      input,
      bridge,
      stateDir,
      receiptPath,
      initial,
      submission,
      generateImageFn,
      complete: () =>
        complete({
          images: [{ buffer: Buffer.from("controlled-image-bytes"), mimeType: "image/png" }],
        }),
    };
  }
  it("does not confirm stop while the provider generation is still running", async () => {
    const h = await harness();
    try {
      const stopped = await h.executor.dispatch({
        ...h.input,
        op: "cancel",
        runtimeJobId: h.initial.runtimeJobId,
      });
      expect(stopped).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: { state: "not_supported" },
      });
      expect(JSON.parse(await fs.readFile(h.receiptPath, "utf8")).state).toBe("started");
      expect(h.bridge.handoffArtifact).not.toHaveBeenCalled();
    } finally {
      h.complete();
      await h.submission;
      await fs.rm(h.stateDir, { recursive: true, force: true });
    }
  });
  it("does not hand off an already completed image from a stop-only operation", async () => {
    const h = await harness();
    try {
      h.complete();
      await h.submission;
      const stopped = await h.executor.dispatch({
        ...h.input,
        op: "cancel",
        runtimeJobId: h.initial.runtimeJobId,
      });
      expect(stopped).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: { state: "confirmed" },
      });
      expect(h.bridge.handoffArtifact).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(h.receiptPath, "utf8")).state).toBe("succeeded");
    } finally {
      h.complete();
      await h.submission;
      await fs.rm(h.stateDir, { recursive: true, force: true });
    }
  });
  it("does not treat a legacy local canceled receipt as confirmed provider stop", async () => {
    const h = await harness();
    try {
      // Previous gateway versions wrote this local state without stopping the
      // pending generation. Reopen its exact valid persisted receipt shape.
      await fs.writeFile(h.receiptPath, JSON.stringify({ ...h.initial, state: "canceled" }));
      const observed = await h.executor.dispatch({
        ...h.input,
        op: "poll",
        runtimeJobId: h.initial.runtimeJobId,
      });
      expect(observed).toMatchObject({
        status: "canceled",
        runtimeStopOutcome: { state: "unknown" },
      });
      expect(h.bridge.handoffArtifact).not.toHaveBeenCalled();
    } finally {
      h.complete();
      await h.submission;
      await fs.rm(h.stateDir, { recursive: true, force: true });
    }
  });
  it("rejects a mismatched job and never creates or hands off during repeated stop", async () => {
    const h = await harness();
    try {
      await expect(
        h.executor.dispatch({ ...h.input, op: "cancel", runtimeJobId: "other-job" }),
      ).resolves.toMatchObject({ status: "failed", failureReason: "vendor_rejected" });
      for (let n = 0; n < 2; n += 1)
        await expect(
          h.executor.dispatch({ ...h.input, op: "cancel", runtimeJobId: h.initial.runtimeJobId }),
        ).resolves.toMatchObject({
          status: "canceled",
          runtimeStopOutcome: { state: "not_supported" },
        });
      expect(h.generateImageFn).toHaveBeenCalledTimes(1);
      expect(h.bridge.handoffArtifact).not.toHaveBeenCalled();
    } finally {
      h.complete();
      await h.submission;
      await fs.rm(h.stateDir, { recursive: true, force: true });
    }
  });

  it("returns the honest stop receipt through the authenticated public HTTP parser", async () => {
    await withGatewayTempConfig("image-stop-public-http", async () => {
      const h = await harness();
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_TOKEN,
        overrides: { mediaGenRuntimeImageExecutor: h.executor },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("test server address unavailable");
        const response = await fetch(
          `http://127.0.0.1:${address.port}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`,
          {
            method: "POST",
            headers: { authorization: "Bearer test-token", "content-type": "application/json" },
            body: JSON.stringify({
              ...h.input,
              op: "cancel",
              runtimeJobId: h.initial.runtimeJobId,
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "canceled",
          runtimeJobId: h.initial.runtimeJobId,
          runtimeStopOutcome: { state: "not_supported", reasonCode: "adapter_not_supported" },
        });
        expect(h.bridge.handoffArtifact).not.toHaveBeenCalled();
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        h.complete();
        await h.submission;
        await fs.rm(h.stateDir, { recursive: true, force: true });
      }
    });
  });
});
