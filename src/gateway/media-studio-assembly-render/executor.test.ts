import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createAssemblyRenderControlApiBridge,
  createDefaultAssemblyRenderHandoffMaster,
  STUDIO_ASSEMBLY_RENDER_HANDOFF_PRESET,
} from "./control-api-callbacks.js";
import { createMediaStudioAssemblyRenderExecutor } from "./executor.js";
import { createMediaStudioAssemblyRenderFromEnv } from "./factory.js";
import type { MediaStudioAssemblyRenderDispatch } from "../media-studio-assembly-render-http.js";

function baseDispatch(
  overrides: Partial<MediaStudioAssemblyRenderDispatch> = {},
): MediaStudioAssemblyRenderDispatch {
  return {
    kind: "media_studio.assembly_render",
    workspaceId: "ws1",
    projectId: "p1",
    assemblyId: "asm1",
    renderId: "r1",
    dispatchEpoch: 2,
    dispatchAttemptId: "rda_1",
    timeline: [{ shotId: "s1", artifactId: "a1", durationSec: 1 }],
    callbackContract: {
      progressPath: "/v1/control/media-gen/runtime/render/progress",
      completePath: "/v1/control/media-gen/runtime/render/complete",
    },
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Gate 1E assembly-render executor", () => {
  it("posts progress then complete with handoff artifact id", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      posts.push({ url: String(url), body });
      return { ok: true, status: 200, text: async () => "{}" };
    });

    const bridge = createAssemblyRenderControlApiBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "rt-1",
      token: "secret",
      fetchImpl: fetchImpl as any,
      handoffMaster: async ({ sha256 }) => ({
        artifactId: `art_${sha256.slice(0, 8)}`,
      }),
    });

    const bytes = new Uint8Array([0, 0, 0, 1, 0x67]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const executor = createMediaStudioAssemblyRenderExecutor({
      bridge,
      encode: async () => ({
        bytes,
        mimeType: "video/mp4",
        durationSec: 1,
        resolution: "1280x720",
        codec: "h264",
        sha256,
      }),
    });

    const accept = await executor.dispatch(baseDispatch());
    expect(accept.accepted).toBe(true);

    for (let i = 0; i < 40 && posts.length < 4; i++) {
      await wait(10);
    }

    const progressPosts = posts.filter((p) => p.url.includes("/render/progress"));
    const completePosts = posts.filter(
      (p) => p.url.includes("/render/complete") && p.body.failed !== true,
    );
    expect(progressPosts.length).toBeGreaterThanOrEqual(2);
    expect(completePosts).toHaveLength(1);
    expect(completePosts[0]?.body.finalMasterArtifactId).toMatch(/^art_/);
    expect(completePosts[0]?.body.qcPassed).toBe(true);
    expect(completePosts[0]?.body.dispatchEpoch).toBe(2);
    expect(completePosts[0]?.body.runtimeId).toBe("rt-1");
  });

  it("cancel aborts in-flight encode and posts cancel ack fail", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      posts.push(init.body ? JSON.parse(init.body) : {});
      return { ok: true, status: 200, text: async () => "{}" };
    });
    const bridge = createAssemblyRenderControlApiBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "rt-1",
      token: "secret",
      fetchImpl: fetchImpl as any,
      handoffMaster: async () => ({ artifactId: "art_x" }),
    });

    let encodeStarted: () => void = () => undefined;
    const encodeGate = new Promise<void>((resolve) => {
      encodeStarted = resolve;
    });

    const executor = createMediaStudioAssemblyRenderExecutor({
      bridge,
      encode: async ({ signal }) => {
        encodeStarted();
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 5_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("cancelled"));
          });
        });
        return {
          bytes: new Uint8Array([1]),
          mimeType: "video/mp4",
          durationSec: 1,
          resolution: "1280x720",
          codec: "h264",
          sha256: "ab".repeat(32),
        };
      },
    });

    await executor.dispatch(
      baseDispatch({
        renderId: "r_cancel",
        dispatchEpoch: 2,
        dispatchAttemptId: "rda_cancel",
      }),
    );
    await encodeGate;
    const cancelResult = await executor.cancel?.({
      kind: "media_studio.assembly_render.cancel",
      workspaceId: "ws1",
      renderId: "r_cancel",
      dispatchEpoch: 2,
      dispatchAttemptId: "rda_cancel",
    });
    expect(cancelResult?.cancelled).toBe(true);

    for (let i = 0; i < 50; i++) {
      if (posts.some((p) => p.errorCode === "media_studio.render.cancelled")) break;
      await wait(20);
    }
    expect(
      posts.some(
        (p) =>
          p.failed === true &&
          p.errorCode === "media_studio.render.cancelled" &&
          p.cancelAcknowledged === true,
      ),
    ).toBe(true);
  });

  it("fails closed without handoff when synthetic master disallowed", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      posts.push(init.body ? JSON.parse(init.body) : {});
      return { ok: true, status: 200, text: async () => "{}" };
    });
    const bridge = createAssemblyRenderControlApiBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "rt-1",
      token: "secret",
      fetchImpl: fetchImpl as any,
    });
    const executor = createMediaStudioAssemblyRenderExecutor({
      bridge,
      allowSyntheticMasterId: false,
      encode: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "video/mp4",
        durationSec: 1,
        resolution: "1280x720",
        codec: "h264",
        sha256: "cd".repeat(32),
      }),
    });
    await executor.dispatch(baseDispatch({ renderId: "r_no_handoff" }));
    for (let i = 0; i < 40; i++) {
      if (posts.some((p) => p.errorCode === "media_studio.render.master_handoff_unavailable")) {
        break;
      }
      await wait(10);
    }
    expect(
      posts.some(
        (p) =>
          p.failed === true &&
          p.errorCode === "media_studio.render.master_handoff_unavailable",
      ),
    ).toBe(true);
  });
});

describe("Gate 1E dispatch/cancel fencing", () => {
  it("identical fence retry is idempotent (does not restart encode)", async () => {
    let encodeCalls = 0;
    const posts: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      posts.push(init.body ? JSON.parse(init.body) : {});
      return { ok: true, status: 200, text: async () => "{}" };
    });
    const bridge = createAssemblyRenderControlApiBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "rt-1",
      token: "secret",
      fetchImpl: fetchImpl as any,
      handoffMaster: async () => ({ artifactId: "art_idem" }),
    });
    let releaseEncode: () => void = () => undefined;
    const encodeHold = new Promise<void>((resolve) => {
      releaseEncode = resolve;
    });
    const executor = createMediaStudioAssemblyRenderExecutor({
      bridge,
      encode: async ({ signal }) => {
        encodeCalls += 1;
        await encodeHold;
        if (signal.aborted) throw new Error("cancelled");
        return {
          bytes: new Uint8Array([1]),
          mimeType: "video/mp4",
          durationSec: 1,
          resolution: "1280x720",
          codec: "h264",
          sha256: "aa".repeat(32),
        };
      },
    });
    const d = baseDispatch({
      renderId: "r_idem",
      dispatchEpoch: 3,
      dispatchAttemptId: "rda_same",
    });
    expect((await executor.dispatch(d)).accepted).toBe(true);
    for (let i = 0; i < 40 && encodeCalls < 1; i++) {
      await wait(5);
    }
    expect(encodeCalls).toBe(1);
    expect((await executor.dispatch(d)).accepted).toBe(true);
    expect(encodeCalls).toBe(1);
    releaseEncode();
    for (let i = 0; i < 40; i++) {
      if (posts.some((p) => p.finalMasterArtifactId === "art_idem")) break;
      await wait(15);
    }
    expect(posts.filter((p) => p.finalMasterArtifactId === "art_idem")).toHaveLength(
      1,
    );
  });

  it("same epoch different attemptId is conflict; active job is not aborted", async () => {
    let encodeCalls = 0;
    let firstCompleted = false;
    const executor = createMediaStudioAssemblyRenderExecutor({
      bridge: {
        runtimeId: "rt-1",
        postProgress: async () => undefined,
        postComplete: async () => undefined,
        postFail: async () => undefined,
        handoffMaster: async () => ({ artifactId: "art_conflict" }),
      } as any,
      encode: async ({ signal }) => {
        encodeCalls += 1;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 80);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("cancelled"));
          });
        });
        firstCompleted = true;
        return {
          bytes: new Uint8Array([1]),
          mimeType: "video/mp4",
          durationSec: 1,
          resolution: "1280x720",
          codec: "h264",
          sha256: "cc".repeat(32),
        };
      },
    });
    const first = baseDispatch({
      renderId: "r_conflict",
      dispatchEpoch: 3,
      dispatchAttemptId: "rda_A",
    });
    expect((await executor.dispatch(first)).accepted).toBe(true);
    for (let i = 0; i < 40 && encodeCalls < 1; i++) {
      await wait(5);
    }
    expect(encodeCalls).toBe(1);

    const conflict = await executor.dispatch(
      baseDispatch({
        renderId: "r_conflict",
        dispatchEpoch: 3,
        dispatchAttemptId: "rda_B",
      }),
    );
    expect(conflict.accepted).toBe(false);
    expect(conflict.messageKey).toBe(
      "media_studio.render.dispatch_fence_conflict",
    );
    expect(encodeCalls).toBe(1);

    // Wrong attempt cancel is rejected; exact match can cancel.
    const badCancel = await executor.cancel?.({
      kind: "media_studio.assembly_render.cancel",
      workspaceId: "ws1",
      renderId: "r_conflict",
      dispatchEpoch: 3,
      dispatchAttemptId: "rda_B",
    });
    expect(badCancel?.cancelled).toBe(false);

    for (let i = 0; i < 40 && !firstCompleted; i++) {
      await wait(10);
    }
    expect(firstCompleted).toBe(true);
  });

  it("stale dispatch and cancel are rejected; greater epoch replaces", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      posts.push(init.body ? JSON.parse(init.body) : {});
      return { ok: true, status: 200, text: async () => "{}" };
    });
    const bridge = createAssemblyRenderControlApiBridge({
      controlApiUrl: "https://control.example",
      runtimeId: "rt-1",
      token: "secret",
      fetchImpl: fetchImpl as any,
      handoffMaster: async () => ({ artifactId: "art_new" }),
    });
    let firstStarted: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const executor = createMediaStudioAssemblyRenderExecutor({
      bridge,
      encode: async ({ signal }) => {
        firstStarted();
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => resolve(), 5_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("cancelled"));
          });
        });
        return {
          bytes: new Uint8Array([1]),
          mimeType: "video/mp4",
          durationSec: 1,
          resolution: "1280x720",
          codec: "h264",
          sha256: "bb".repeat(32),
        };
      },
    });
    const first = baseDispatch({
      renderId: "r_fence",
      dispatchEpoch: 2,
      dispatchAttemptId: "rda_a",
    });
    expect((await executor.dispatch(first)).accepted).toBe(true);
    await firstGate;

    const stale = await executor.dispatch(
      baseDispatch({
        renderId: "r_fence",
        dispatchEpoch: 1,
        dispatchAttemptId: "rda_old",
      }),
    );
    expect(stale.accepted).toBe(false);
    expect(stale.messageKey).toBe("media_studio.render.stale_dispatch");

    const missingCancel = await executor.cancel?.({
      kind: "media_studio.assembly_render.cancel",
      workspaceId: "ws1",
      renderId: "r_fence",
    });
    expect(missingCancel?.cancelled).toBe(false);
    expect(missingCancel?.messageKey).toBe(
      "media_studio.render.cancel_fence_required",
    );

    const staleCancel = await executor.cancel?.({
      kind: "media_studio.assembly_render.cancel",
      workspaceId: "ws1",
      renderId: "r_fence",
      dispatchEpoch: 1,
      dispatchAttemptId: "rda_old",
    });
    expect(staleCancel?.cancelled).toBe(false);

    // Newer attempt replaces; old finally must not orphan the new job.
    let secondStarted: () => void = () => undefined;
    const secondGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    // Rebind encode via a second executor is not possible; use abort-then-fast
    // path: after replace, cancel the new attempt with matching fence.
    expect(
      (
        await executor.dispatch(
          baseDispatch({
            renderId: "r_fence",
            dispatchEpoch: 3,
            dispatchAttemptId: "rda_b",
          }),
        )
      ).accepted,
    ).toBe(true);

    const okCancel = await executor.cancel?.({
      kind: "media_studio.assembly_render.cancel",
      workspaceId: "ws1",
      renderId: "r_fence",
      dispatchEpoch: 3,
      dispatchAttemptId: "rda_b",
    });
    expect(okCancel?.cancelled).toBe(true);
    // Silence unused if encode never reaches second start.
    void secondStarted;
    void secondGate;
  });
});

describe("Gate 1E complete-after-handoff failure", () => {
  it("logs orphan and posts fail when complete throws after handoff", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const warns: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      posts.push({ url: String(url), ...body });
      if (String(url).includes("/render/complete") && body.failed !== true) {
        return { ok: false, status: 500, text: async () => "boom" };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    });
    // postComplete throws when response not ok — use bridge that throws on complete.
    const bridge = {
      runtimeId: "rt-1",
      postProgress: async () => undefined,
      postComplete: async () => {
        throw new Error("complete_rejected");
      },
      postFail: async (input: Record<string, unknown>) => {
        posts.push(input);
      },
      handoffMaster: async () => ({ artifactId: "art_orphan" }),
    };
    const executor = createMediaStudioAssemblyRenderExecutor({
      bridge: bridge as any,
      log: { warn: (m) => warns.push(m) },
      encode: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: "video/mp4",
        durationSec: 1,
        resolution: "1280x720",
        codec: "h264",
        sha256: "11".repeat(32),
      }),
    });
    await executor.dispatch(baseDispatch({ renderId: "r_orphan" }));
    for (let i = 0; i < 40; i++) {
      if (posts.some((p) => p.errorCode === "media_studio.render.complete_after_handoff_failed")) {
        break;
      }
      await wait(15);
    }
    expect(
      posts.some(
        (p) =>
          p.failed === true &&
          p.errorCode === "media_studio.render.complete_after_handoff_failed" &&
          p.orphanArtifactId === "art_orphan" &&
          typeof p.orphanChecksum === "string",
      ),
    ).toBe(true);
    expect(warns.some((w) => w.includes("orphan_master_handoff"))).toBe(true);
    expect(warns.some((w) => w.includes("art_orphan"))).toBe(true);
  });
});

describe("Gate 1H default handoff master", () => {
  it("posts renderId ownership query to artifact-handoff", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init.headers });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ data: { artifact: { artifactId: "art_from_handoff" } } }),
      };
    });
    const handoff = createDefaultAssemblyRenderHandoffMaster({
      controlApiUrl: "https://control.example",
      runtimeId: "rt-1",
      token: "tok",
      fetchImpl: fetchImpl as any,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const out = await handoff({
      workspaceId: "ws1",
      projectId: "p1",
      renderId: "r_h1",
      bytes,
      mimeType: "video/mp4",
      sha256: "ab".repeat(32),
      durationSec: 2,
      resolution: "1280x720",
    });
    expect(out.artifactId).toBe("art_from_handoff");
    expect(calls[0]?.url).toContain("renderId=r_h1");
    expect(calls[0]?.url).toContain("projectId=p1");
    expect(calls[0]?.url).toContain(
      `presetId=${encodeURIComponent(STUDIO_ASSEMBLY_RENDER_HANDOFF_PRESET)}`,
    );
    expect(calls[0]?.headers["x-wisclaw-media-gen-runtime-token"]).toBe("tok");
  });
});

describe("Gate 1E factory env gate", () => {
  it("disabled without enable flag", async () => {
    const result = await createMediaStudioAssemblyRenderFromEnv({
      env: {},
      skipFfmpegCheck: true,
      encodeImpl: async () => {
        throw new Error("unused");
      },
    });
    expect(result.enabled).toBe(false);
  });

  it("enabled with synthetic master and inject encode", async () => {
    const result = await createMediaStudioAssemblyRenderFromEnv({
      env: {
        OPENCLAW_MEDIA_STUDIO_ASSEMBLY_RENDER_ENABLED: "1",
        OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example",
        OPENCLAW_MEDIA_GEN_RUNTIME_ID: "rt-1",
        OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "tok",
        OPENCLAW_MEDIA_STUDIO_ASSEMBLY_RENDER_ALLOW_SYNTHETIC_MASTER: "1",
      },
      skipFfmpegCheck: true,
      encodeImpl: async () => ({
        bytes: new Uint8Array([9]),
        mimeType: "video/mp4",
        durationSec: 1,
        resolution: "640x360",
        codec: "h264",
        sha256: "ef".repeat(32),
      }),
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    });
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      const accept = await result.executor.dispatch(baseDispatch());
      expect(accept.accepted).toBe(true);
    }
  });
});
