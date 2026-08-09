import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MediaGenRuntimeDispatch,
  MediaGenRuntimeHttpExecutor,
  MediaGenRuntimeResult,
} from "../media-gen-runtime-http.js";
import type { MediaGenRuntimeExecutorOptions } from "./executor.js";
import type { MediaGenRuntimeSource } from "./types.js";

const executorHarness = vi.hoisted(() => ({
  resolvedSource: undefined as MediaGenRuntimeSource | undefined,
}));

vi.mock("./executor.js", () => ({
  createOpenClawMediaGenRuntimeExecutor: (
    options: MediaGenRuntimeExecutorOptions,
  ): MediaGenRuntimeHttpExecutor => ({
    async dispatch(dispatch: MediaGenRuntimeDispatch): Promise<MediaGenRuntimeResult> {
      const reference = dispatch.reference;
      if (
        dispatch.op === "submit" &&
        reference?.kind === "runtime_local" &&
        reference.runtimeLocalRef &&
        options.resolveRuntimeLocalReference
      ) {
        executorHarness.resolvedSource = await options.resolveRuntimeLocalReference({
          dispatch,
          runtimeLocalRef: reference.runtimeLocalRef,
          role: "subject",
          ordinal: 0,
        });
      }
      return {
        taskId: dispatch.taskId,
        workspaceId: dispatch.workspaceId,
        correlationId: dispatch.correlationId,
        status: "processing",
        runtimeJobId: "runtime-reference-map-stub",
      };
    },
  }),
}));

import { createOpenClawMediaGenRuntimeFromEnv } from "./factory.js";

function enabledEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
    OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
    OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-reference-map",
    OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "token-reference-map",
    OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "workspace-reference-map",
    KLING_ACCESS_KEY: "kling-access",
    KLING_SECRET: "kling-secret",
    OPENCLAW_MEDIA_GEN_MODERATION_WEBHOOK_URL: "https://moderation.example/check",
    OPENCLAW_MEDIA_GEN_LABELING_WEBHOOK_URL: "https://labeling.example/apply",
    ...overrides,
  };
}

function referenceMap(input: {
  handle: string;
  providerRef: string;
  mimeType?: string;
  sha256?: string;
}): string {
  return JSON.stringify({
    [input.handle]: {
      providerRef: input.providerRef,
      mimeType: input.mimeType ?? "video/mp4",
      sha256: input.sha256 ?? "a".repeat(64),
    },
  });
}

async function dispatchRuntimeLocal(
  result: ReturnType<typeof createOpenClawMediaGenRuntimeFromEnv>,
  runtimeLocalRef: string,
): Promise<MediaGenRuntimeSource | undefined> {
  expect(result.enabled).toBe(true);
  if (!result.enabled) {
    throw new Error(result.reason);
  }
  executorHarness.resolvedSource = undefined;
  await result.executor.dispatch({
    op: "submit",
    taskId: "task-reference-map",
    workspaceId: "workspace-reference-map",
    correlationId: "correlation-reference-map",
    presetId: "kling",
    mode: "image2video",
    reference: { kind: "runtime_local", runtimeLocalRef },
  });
  return executorHarness.resolvedSource;
}

describe("OpenClaw generic runtime-local reference map factory", () => {
  beforeEach(() => {
    executorHarness.resolvedSource = undefined;
  });

  it("resolves an opaque handle from the generic map through the executor seam", async () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv({
        OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON: referenceMap({
          handle: "generic-video-1",
          providerRef: "asset://runtime-inputs/generic-video-1.mp4",
          mimeType: "VIDEO/MP4",
          sha256: `sha256:${"b".repeat(64)}`,
        }),
      }),
    });

    await expect(dispatchRuntimeLocal(result, "generic-video-1")).resolves.toEqual({
      providerRef: "asset://runtime-inputs/generic-video-1.mp4",
      mimeType: "video/mp4",
      sha256: "b".repeat(64),
    });
  });

  it("fails closed on an invalid non-empty generic map without consulting legacy", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv({
        OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON: referenceMap({
          handle: "generic-invalid",
          providerRef: "http://runtime.example/insecure.mp4",
        }),
        OPENCLAW_SEEDANCE_RUNTIME_REFERENCE_MAP_JSON: referenceMap({
          handle: "legacy-valid",
          providerRef: "https://runtime.example/legacy.mp4",
        }),
      }),
    });

    expect(result).toEqual({
      enabled: false,
      reason: "OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON is invalid",
    });
  });

  it("keeps the legacy Seedance map as a fallback when the generic variable is empty", async () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv({
        OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON: "   ",
        OPENCLAW_SEEDANCE_RUNTIME_REFERENCE_MAP_JSON: referenceMap({
          handle: "legacy-video-1",
          providerRef: "https://runtime.example/legacy-video-1.mp4",
          sha256: "c".repeat(64),
        }),
      }),
    });

    await expect(dispatchRuntimeLocal(result, "legacy-video-1")).resolves.toEqual({
      providerRef: "https://runtime.example/legacy-video-1.mp4",
      mimeType: "video/mp4",
      sha256: "c".repeat(64),
    });
  });

  it("uses a valid generic map even when the non-selected legacy value is invalid", async () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv({
        OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON: referenceMap({
          handle: "generic-video-2",
          providerRef: "https://runtime.example/generic-video-2.mp4",
          sha256: "d".repeat(64),
        }),
        OPENCLAW_SEEDANCE_RUNTIME_REFERENCE_MAP_JSON: "{not-valid-json",
      }),
    });

    await expect(dispatchRuntimeLocal(result, "generic-video-2")).resolves.toEqual({
      providerRef: "https://runtime.example/generic-video-2.mp4",
      mimeType: "video/mp4",
      sha256: "d".repeat(64),
    });
  });

  it("withholds the Luma runtime-local I2V claim when no reference map is configured", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv({
        KLING_ACCESS_KEY: "",
        KLING_SECRET: "",
        LUMAAI_API_KEY: "luma-key",
      }),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }

    expect(result.supportedPresetIds).toEqual(["luma"]);
    expect(result.supportsMultiReference).toBe(false);
    expect(result.capabilityRouteClaims).toHaveLength(1);
    expect(result.capabilityRouteClaims.map((claim) => claim.route.routeId)).not.toContain(
      "luma.dream_machine.v1.ray_2.first_frame_to_video",
    );
  });

  it("keeps unpinned Luma I2V private even when a runtime-local map is configured", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv({
        KLING_ACCESS_KEY: "",
        KLING_SECRET: "",
        LUMAAI_API_KEY: "luma-key",
        OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON: referenceMap({
          handle: "luma-first-frame",
          providerRef: "https://runtime.example/luma-first-frame.png",
          mimeType: "image/png",
          sha256: "e".repeat(64),
        }),
      }),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }

    expect(result.supportedPresetIds).toEqual(["luma"]);
    expect(result.supportsMultiReference).toBe(false);
    expect(result.capabilityRouteClaims).toHaveLength(1);
    expect(result.capabilityRouteClaims.map((claim) => claim.route.routeId)).not.toContain(
      "luma.dream_machine.v1.ray_2.first_frame_to_video",
    );
  });

  it("withholds Luma I2V when a non-empty map has no usable HTTPS image", () => {
    const result = createOpenClawMediaGenRuntimeFromEnv({
      env: enabledEnv({
        KLING_ACCESS_KEY: "",
        KLING_SECRET: "",
        LUMAAI_API_KEY: "luma-key",
        OPENCLAW_MEDIA_GEN_RUNTIME_REFERENCE_MAP_JSON: referenceMap({
          handle: "seedance-video",
          providerRef: "asset://runtime-inputs/seedance-video.mp4",
          mimeType: "video/mp4",
        }),
      }),
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) {
      return;
    }
    expect(result.supportsMultiReference).toBe(false);
    expect(result.capabilityRouteClaims.map((claim) => claim.route.routeId)).not.toContain(
      "luma.dream_machine.v1.ray_2.first_frame_to_video",
    );
  });
});
