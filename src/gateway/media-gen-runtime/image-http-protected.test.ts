import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaGenRuntimeImageExecutor } from "./image-http.js";
import { imageCredentialBindingDigest } from "./image-route-config.js";
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

describe("original image attempt versus current credential authority", () => {
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
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wisclaw-image-protected-"));
    dirs.push(stateDir);
    const env = protectedImageEnv(stateDir);
    const generateImageFn = vi.fn(async () => ({
      images: [{ buffer: Buffer.from("controlled-image-bytes"), mimeType: "image/png" }],
    }));
    const handoffArtifact = vi.fn(
      async ({ sha256, output }: { sha256: string; output: { mimeType: string } }) => ({
        artifactId: "artifact-image-1",
        sha256,
        mimeType: output.mimeType,
      }),
    );
    const createExecutor = (getConfig = () => ({})) =>
      createMediaGenRuntimeImageExecutor({
        env,
        runtimeId: "runtime-1",
        route: protectedImageRoute(),
        bridge: { handoffArtifact } as unknown as MediaGenRuntimeBridge,
        getConfig,
        compliance: {
          enforcesModeration: true,
          appliesLabeling: true,
          registrationDisclosureStatus: "operator_self_declared",
        },
        generateImageFn,
      });
    return { env, generateImageFn, handoffArtifact, createExecutor };
  }

  it("reads and stops the original completed attempt after withdrawal, but refuses a new attempt", async () => {
    const h = await harness();
    const input = protectedImageDispatch();
    const submitted = await h.createExecutor().dispatch(input);
    expect(submitted.status).toBe("processing");
    delete h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON;
    delete h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_BINDING_DIGEST;
    const reopened = h.createExecutor();
    const runtimeJobId = String(submitted.runtimeJobId);
    expect(await reopened.registrationSnapshot!("workspace-1")).toEqual({
      imageCapabilityBindings: [],
      imageExecutionEvidence: [],
    });
    expect(h.handoffArtifact).not.toHaveBeenCalled();
    expect(await reopened.dispatch({ ...input, op: "poll", runtimeJobId })).toMatchObject({
      status: "succeeded",
      snapshot: { moderationStatus: "not_enforced", labelingStatus: "absent" },
    });
    expect(await reopened.dispatch({ ...input, op: "reconcile" })).toMatchObject({
      status: "succeeded",
    });
    expect(await reopened.dispatch({ ...input, op: "cancel", runtimeJobId })).toMatchObject({
      status: "canceled",
      runtimeStopOutcome: { state: "confirmed" },
    });
    expect(await reopened.dispatch({ ...input, op: "poll", runtimeJobId })).toMatchObject({
      status: "canceled",
    });
    expect(
      await reopened.dispatch({ ...input, workspaceId: "workspace-2", op: "reconcile" }),
    ).toMatchObject({ status: "submission_unknown" });
    expect(await reopened.dispatch({ ...input, executionAttempt: 2, op: "retry" })).toMatchObject({
      status: "failed",
      failureReason: "vendor_rejected",
    });
    expect(h.generateImageFn).toHaveBeenCalledTimes(1);
    expect(h.handoffArtifact).toHaveBeenCalledTimes(1);
  });

  it.each(["withdrawn", "revised", "rotated"])(
    "does not create if the protected slot is %s while auth preparation yields",
    async (change) => {
      const h = await harness();
      let configReads = 0;
      const executor = h.createExecutor(() => {
        configReads += 1;
        // The second preparation happens after the durable reservation. Its
        // asynchronous auth resolution must not retain this withdrawn sample.
        if (configReads === 2) {
          if (change === "withdrawn") delete h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON;
          else {
            const credential = JSON.parse(h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON!);
            if (change === "revised") credential.revision += 1;
            else credential.apiKey = "rotated-synthetic-key";
            h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON = JSON.stringify(credential);
            h.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_BINDING_DIGEST =
              imageCredentialBindingDigest(credential);
          }
        }
        return {};
      });
      expect(await executor.dispatch(protectedImageDispatch())).toMatchObject({
        status: "failed",
        failureReason: "vendor_rejected",
      });
      expect(h.generateImageFn).not.toHaveBeenCalled();
      expect(h.handoffArtifact).not.toHaveBeenCalled();
    },
  );
});
