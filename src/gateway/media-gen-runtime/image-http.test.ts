import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMediaGenRuntimeResult } from "../../../../../../packages/contracts/src/dto/media-generation-runtime-executor/parsers/result.js";
import { ImageGenerationExactOutputError } from "../../image-generation/normalization.js";
import {
  AUTH_TOKEN,
  createTestGatewayServer,
  withGatewayTempConfig,
} from "../server-http.test-harness.js";
import {
  MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH,
  createMediaGenRuntimeImageExecutor,
  type ImageRouteExecutor,
} from "./image-http.js";
import {
  protectedImageDispatch,
  protectedImageEnv,
  protectedImageRoute,
} from "./protected-image.test-helpers.js";
import type { MediaGenRuntimeBridge } from "./types.js";

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

async function withServer(
  executor: ImageRouteExecutor | undefined,
  run: (url: string) => Promise<void>,
): Promise<void> {
  await withGatewayTempConfig("media-gen-runtime-image-http", async () => {
    const server: Server = createTestGatewayServer({
      resolvedAuth: AUTH_TOKEN,
      overrides: { mediaGenRuntimeImageExecutor: executor },
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
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

describe("dedicated image runtime gateway", () => {
  beforeEach(() => {
    for (const key of ["OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"])
      vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("keeps the image route behind gateway authentication and reaches only the image executor", async () => {
    const executor: ImageRouteExecutor = {
      dispatch: vi.fn(async (input) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing",
        runtimeJobId: "job-1",
      })),
    };
    await withServer(executor, async (url) => {
      const unauthenticated = await fetch(`${url}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`, {
        method: "POST",
        body: JSON.stringify(imageDispatch()),
      });
      expect(unauthenticated.status).toBe(401);
      const response = await fetch(`${url}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(imageDispatch()),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "processing", runtimeJobId: "job-1" });
      expect(executor.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects edit/source semantics before an executor can run", async () => {
    const executor: ImageRouteExecutor = { dispatch: vi.fn() };
    await withServer(executor, async (url) => {
      const body = imageDispatch({
        frozenImagePlan: {
          ...imageDispatch().frozenImagePlan,
          generationScenario: "image_edit",
        },
      });
      const response = await fetch(`${url}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it.each([
    { op: "submit", stopOnly: true },
    { op: "retry", stopOnly: true },
    { op: "poll", runtimeJobId: "job-1", stopOnly: true },
    { op: "cancel", runtimeJobId: "job-1", stopOnly: true },
    { op: "reconcile", stopOnly: false },
  ])("rejects illegal stopOnly grammar before execution: %j", async (overrides) => {
    const executor: ImageRouteExecutor = { dispatch: vi.fn() };
    await withServer(executor, async (url) => {
      const response = await fetch(`${url}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(imageDispatch(overrides)),
      });
      expect(response.status).toBe(400);
      expect(executor.dispatch).not.toHaveBeenCalled();
    });
  });

  it("accepts stopOnly reconcile without a job and preserves unknown stop honesty", async () => {
    const executor: ImageRouteExecutor = {
      dispatch: vi.fn(async (input) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "submission_unknown",
        providerRequestDigest: input.frozenPlanDigest,
      })),
    };
    await withServer(executor, async (url) => {
      const response = await fetch(`${url}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(imageDispatch({ op: "reconcile", stopOnly: true })),
      });
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(receipt.status).toBe("submission_unknown");
      expect(parseMediaGenRuntimeResult(receipt)).not.toBeNull();
      expect(executor.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ op: "reconcile", stopOnly: true }),
      );
    });
  });

  it("rejects a jobless unknown stop receipt that the shared contract also rejects", async () => {
    const executor: ImageRouteExecutor = {
      dispatch: vi.fn(async (input) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "canceled",
        runtimeStopOutcome: { state: "unknown", reasonCode: "transport_uncertain" },
      })),
    };
    await withServer(executor, async (url) => {
      const input = imageDispatch({ op: "reconcile", stopOnly: true });
      expect(parseMediaGenRuntimeResult(await executor.dispatch(input as never))).toBeNull();
      const response = await fetch(`${url}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(502);
    });
  });

  it("rejects an executor receipt with an untrusted extra field", async () => {
    const executor: ImageRouteExecutor = {
      dispatch: vi.fn(async (input) => ({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        status: "processing",
        runtimeJobId: "job-1",
        unexpected: "must-not-cross-the-gateway",
      })),
    };
    await withServer(executor, async (url) => {
      const response = await fetch(`${url}${MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(imageDispatch()),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ status: "failed", failureReason: "internal" });
    });
  });

  it("keeps one same-attempt provider create across a race and a new executor instance", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-receipt-"));
    const env = protectedImageEnv(stateDir);
    const bytes = Buffer.from("real-image-test-bytes");
    const generateImageFn = vi.fn(async () => ({
      images: [{ buffer: bytes, mimeType: "image/png" }],
    }));
    const bridge = imageBridge();
    const createExecutor = () =>
      createMediaGenRuntimeImageExecutor({
        env,
        runtimeId: "runtime-1",
        route: protectedImageRoute(),
        bridge,
        getConfig: () => ({}) as never,
        compliance: {
          enforcesModeration: true,
          appliesLabeling: true,
          registrationDisclosureStatus: "operator_self_declared",
        },
        generateImageFn,
      });
    try {
      const dispatch = protectedImageDispatch();
      const [left, right] = await Promise.all([
        createExecutor().dispatch(dispatch),
        createExecutor().dispatch(dispatch),
      ]);
      expect([left.status, right.status]).toContain("processing");
      expect(
        [left.status, right.status].every((status) =>
          ["processing", "submission_unknown"].includes(String(status)),
        ),
      ).toBe(true);
      expect(generateImageFn).toHaveBeenCalledTimes(1);
      expect(generateImageFn).toHaveBeenCalledWith(
        expect.objectContaining({
          requireExactOutput: true,
          autoProviderFallback: false,
          count: 1,
          modelOverride: "openai/gpt-image-1.5",
          size: "1024x1024",
          quality: "high",
          outputFormat: "png",
          background: "opaque",
        }),
      );

      const recovered = await createExecutor().dispatch({
        ...dispatch,
        op: "reconcile",
      });
      expect(recovered).toMatchObject({
        status: "succeeded",
        runtimeJobId: expect.any(String),
        artifact: {
          artifactId: "artifact-image-1",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        snapshot: {
          executionOwner: "user_runtime",
          // Configuration claims alone do not prove image processing.
          moderationStatus: "not_enforced",
          labelingStatus: "absent",
        },
      });
      expect(generateImageFn).toHaveBeenCalledTimes(1);
      expect(bridge.handoffArtifact).toHaveBeenCalledTimes(1);
      expect(bridge.handoffArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatch: expect.objectContaining({
            executionAttempt: 1,
            frozenPlanDigest: dispatch.frozenPlanDigest,
          }),
        }),
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves uncertain Provider effects across replay and restart without another create", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-unknown-"));
    const generateImageFn = vi.fn(async () => {
      throw new Error("connection lost after request");
    });
    const bridge = imageBridge();
    const createExecutor = () =>
      createMediaGenRuntimeImageExecutor({
        env: protectedImageEnv(stateDir),
        runtimeId: "runtime-1",
        route: protectedImageRoute(),
        bridge,
        getConfig: () => ({}),
        compliance: {
          enforcesModeration: false,
          appliesLabeling: false,
          registrationDisclosureStatus: "undeclared",
        },
        generateImageFn,
      });
    try {
      const dispatch = protectedImageDispatch();
      const first = await createExecutor().dispatch(dispatch);
      expect(first).toMatchObject({
        status: "submission_unknown",
        providerRequestDigest: expect.any(String),
      });
      const replay = await createExecutor().dispatch(dispatch);
      const reconcile = await createExecutor().dispatch({ ...dispatch, op: "reconcile" });
      expect(replay).toMatchObject({
        status: "submission_unknown",
        providerRequestDigest: first.providerRequestDigest,
      });
      expect(reconcile).toMatchObject({
        status: "submission_unknown",
        providerRequestDigest: first.providerRequestDigest,
      });
      const [file] = await fs.readdir(path.join(stateDir, "media-gen-image-receipts-v1"));
      expect(
        JSON.parse(
          await fs.readFile(path.join(stateDir, "media-gen-image-receipts-v1", file!), "utf8"),
        ),
      ).toMatchObject({ state: "started" });
      expect(generateImageFn).toHaveBeenCalledTimes(1);
      expect(bridge.handoffArtifact).not.toHaveBeenCalled();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps an ExactOutputError from inside generation unknown without a no-effect proof", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-preflight-"));
    const generateImageFn = vi.fn(async () => {
      throw new ImageGenerationExactOutputError("Frozen output unsupported.");
    });
    const bridge = imageBridge();
    const executor = createMediaGenRuntimeImageExecutor({
      env: protectedImageEnv(stateDir),
      runtimeId: "runtime-1",
      route: protectedImageRoute(),
      bridge,
      getConfig: () => ({}),
      compliance: {
        enforcesModeration: false,
        appliesLabeling: false,
        registrationDisclosureStatus: "undeclared",
      },
      generateImageFn,
    });
    try {
      expect(await executor.dispatch(protectedImageDispatch())).toMatchObject({
        status: "submission_unknown",
        imageLifecycleReceipt: { providerOutcome: "unknown" },
      });
      expect(bridge.handoffArtifact).not.toHaveBeenCalled();
      expect(generateImageFn).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
