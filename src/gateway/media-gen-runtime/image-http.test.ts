import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("dedicated image runtime gateway", () => {
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
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const bytes = Buffer.from("real-image-test-bytes");
    const generateImageFn = vi.fn(async () => ({
      images: [{ buffer: bytes, mimeType: "image/png" }],
    }));
    const bridge = imageBridge();
    const createExecutor = () =>
      createMediaGenRuntimeImageExecutor({
        env,
        runtimeId: "runtime-1",
        route: imageRoute(),
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
      const dispatch = imageDispatch();
      const [left, right] = await Promise.all([
        createExecutor().dispatch(dispatch),
        createExecutor().dispatch(dispatch),
      ]);
      expect([left.status, right.status].sort()).toEqual(["processing", "submission_unknown"]);
      expect(generateImageFn).toHaveBeenCalledTimes(1);

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
          moderationStatus: "runtime_enforced",
          labelingStatus: "runtime_applied",
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
});
