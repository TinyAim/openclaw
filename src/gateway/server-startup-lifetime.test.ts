import { createServer } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel, gatewayKernelLogs } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { spatialReferenceRuntimeReasonCode } from "./server-start.js";

const startupTraceEventLoopDelay = vi.hoisted(() => ({
  instances: [] as Array<{
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    percentile: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  }>,
}));

const spatialRuntimeEnvKeys = [
  "OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED",
  "OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_V2_ENABLED",
  "OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_BUNDLE_DIR",
  "OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_CHROMIUM_PATH",
  "OPENCLAW_MEDIA_GEN_CONTROL_API_URL",
  "OPENCLAW_MEDIA_GEN_RUNTIME_ID",
  "OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN",
  "OPENCLAW_MEDIA_GEN_WORKSPACE_IDS",
  "OPENCLAW_MEDIA_GEN_REGISTER_INTERVAL_MS",
];

function preserveSpatialRuntimeEnv(): () => void {
  const prior = new Map(spatialRuntimeEnvKeys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return {
    ...actual,
    monitorEventLoopDelay: vi.fn(() => {
      const instance = {
        disable: vi.fn(),
        enable: vi.fn(),
        percentile: vi.fn(() => 0),
        reset: vi.fn(),
      };
      startupTraceEventLoopDelay.instances.push(instance);
      return { ...instance, max: 0 };
    }),
  };
});

function createStartupTestState(label: string) {
  return createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
}

describe("Gateway startup lifetime", () => {
  it("starts the configured Spatial Runtime heartbeat and stops it with the Gateway", async () => {
    const restoreSpatialRuntimeEnv = preserveSpatialRuntimeEnv();
    const port = await getFreePort();
    const state = await createStartupTestState("gateway-spatial-runtime-lifetime");
    state.envVars.OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED = "1";
    state.envVars.OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_V2_ENABLED = "0";
    state.envVars.OPENCLAW_MEDIA_GEN_CONTROL_API_URL = "http://control-api.invalid";
    state.envVars.OPENCLAW_MEDIA_GEN_RUNTIME_ID = "runtime-lifecycle-test";
    state.envVars.OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN = "runtime-lifecycle-test-token";
    state.envVars.OPENCLAW_MEDIA_GEN_WORKSPACE_IDS = "workspace-lifecycle-test";
    state.envVars.OPENCLAW_MEDIA_GEN_REGISTER_INTERVAL_MS = "60000";
    state.applyEnv();
    const registrationRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        registrationRequests.push(String(input));
        return { ok: true, status: 200 } as Response;
      }),
    );
    let server: GatewayServer | undefined;
    try {
      const token = "gateway-spatial-runtime-lifetime-token";
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      server = await startGatewayServerCore(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(registrationRequests).toEqual([
        "http://control-api.invalid/v1/control/media-gen/runtime/register",
      ]);
      await server.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registrationRequests).toHaveLength(1);
    } finally {
      await server?.close();
      await state.cleanup();
      restoreSpatialRuntimeEnv();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("preserves only allowlisted qualification codes and hides unknown text", () => {
    const suspicious = "untrusted spatial_v2_host_memory_unavailable secret-marker";
    expect(spatialReferenceRuntimeReasonCode(suspicious)).toBe("qualification_failed");
    expect(spatialReferenceRuntimeReasonCode("constructor")).toBe("qualification_failed");
    expect(
      spatialReferenceRuntimeReasonCode(
        "v2 toolchain probe failed: spatial_v2_browser_launch_failed",
      ),
    ).toBe("spatial_v2_browser_launch_failed");
    expect(
      spatialReferenceRuntimeReasonCode(
        "v2 toolchain probe failed: spatial_v2_libx264_encoder_missing",
      ),
    ).toBe("spatial_v2_libx264_encoder_missing");
    expect(
      spatialReferenceRuntimeReasonCode(
        "v2 toolchain probe failed: spatial_v2_host_memory_unavailable secret-marker",
      ),
    ).toBe("v2_toolchain_probe_failed");
    expect(
      spatialReferenceRuntimeReasonCode(
        "v2 toolchain probe failed: spatial_v2_browser_launch_failed token-secret",
      ),
    ).toBe("v2_toolchain_probe_failed");
    expect(spatialReferenceRuntimeReasonCode("spatial_v2_host_memory_unavailable")).toBe(
      "spatial_v2_host_memory_unavailable",
    );
  });

  it("logs only a sanitized reason when requested Spatial qualification is unavailable", async () => {
    const restoreSpatialRuntimeEnv = preserveSpatialRuntimeEnv();
    const port = await getFreePort();
    const state = await createStartupTestState("gateway-spatial-runtime-unavailable");
    state.envVars.OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED = "1";
    state.envVars.OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_V2_ENABLED = "1";
    state.envVars.OPENCLAW_MEDIA_GEN_CONTROL_API_URL = "http://control-api.invalid";
    state.envVars.OPENCLAW_MEDIA_GEN_RUNTIME_ID = "runtime-unavailable-test";
    state.envVars.OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN = "runtime-unavailable-test-token";
    state.envVars.OPENCLAW_MEDIA_GEN_WORKSPACE_IDS = "workspace-unavailable-test";
    state.applyEnv();
    const warn = vi.spyOn(gatewayKernelLogs.log, "warn").mockImplementation(() => {});
    let server: GatewayServer | undefined;
    try {
      const token = "gateway-spatial-runtime-unavailable-token";
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      server = await startGatewayServerCore(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(warn).toHaveBeenCalledWith(
        "spatial reference runtime startup skipped reason=v2_bundle_or_chromium_missing",
      );
      await server.close();
    } finally {
      await server?.close();
      await state.cleanup();
      restoreSpatialRuntimeEnv();
      warn.mockRestore();
    }
  });

  it("closes startup tracing when invalid config prevents bootstrap from returning", async () => {
    startupTraceEventLoopDelay.instances.length = 0;
    const state = await createStartupTestState("gateway-invalid-config-startup-trace");
    state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
    await state.writeConfig({ gateway: { mode: 42 } });
    state.applyEnv();
    try {
      await expect(createGatewayKernel()).rejects.toThrow("Invalid config");
      expect(startupTraceEventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
    } finally {
      await state.cleanup();
    }
  });

  it("closes startup tracing when required TLS material is unavailable", async () => {
    startupTraceEventLoopDelay.instances.length = 0;
    const port = await getFreePort();
    const state = await createStartupTestState("gateway-tls-startup-trace");
    state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
    const token = "gateway-tls-startup-trace-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
        tls: {
          enabled: true,
          autoGenerate: false,
          certPath: state.path("missing-cert.pem"),
          keyPath: state.path("missing-key.pem"),
        },
      },
    });
    state.applyEnv();
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway tls: cert/key missing");
      expect(startupTraceEventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
    } finally {
      await state.cleanup();
    }
  });

  it("closes startup tracing when public startup cannot bind its listener", async () => {
    startupTraceEventLoopDelay.instances.length = 0;
    const port = await getFreePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", () => {
        blocker.off("error", reject);
        resolve();
      });
    });
    const state = await createStartupTestState("gateway-public-startup-trace");
    state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
    const token = "gateway-public-startup-trace-token";
    await state.writeConfig({
      gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
    });
    state.applyEnv();
    try {
      const listenModule = await import("./server/http-listen.js");
      const listen = listenModule.listenGatewayHttpServer;
      // The owned blocker cannot leave; retry policy has its own listener tests.
      const listenSpy = vi
        .spyOn(listenModule, "listenGatewayHttpServer")
        .mockImplementation((params) => listen({ ...params, retryEaddrinuse: false }));
      try {
        const { startGatewayServerCore } = await import("./server-start.js");
        await expect(
          startGatewayServerCore(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          }),
        ).rejects.toThrow("another gateway instance is already listening");
        expect(startupTraceEventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
      } finally {
        listenSpy.mockRestore();
      }
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
      await state.cleanup();
    }
  });

  it.for(["clean", "failed"] as const)(
    "joins deferred startup failure while reporting %s cleanup independently",
    async (cleanup, { signal }) => {
      const port = await getFreePort();
      const state = await createStartupTestState(`gateway-deferred-startup-${cleanup}-cleanup`);
      const startupError = new Error("deferred startup failed");
      const cleanupError = new Error("deferred startup cleanup failed");
      const startup = createDeferred();
      const startupFailure = startup.promise.catch((error: unknown) => error);
      const startupEntered = createDeferred();
      const drainEntered = createDeferred();
      const releaseStartup = () => startup.reject(startupError);
      signal.addEventListener("abort", releaseStartup, { once: true });
      let failCleanup = cleanup === "failed";
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let server: GatewayServer | undefined;
      let publishedStartup: Promise<void> | undefined;
      let startupOutcome: Promise<unknown> | undefined;
      let closeOutcome: Promise<unknown> | undefined;
      const createKernel = createGatewayKernel;
      const kernelFactory = vi
        .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await createKernel(...args);
          return kernel;
        });
      const startupModule = await import("./server-startup-finish.js");
      const finishStartup = startupModule.finishGatewayStartup;
      const startupFactory = vi
        .spyOn(startupModule, "finishGatewayStartup")
        .mockImplementation(async (...args) => {
          const result = await finishStartup(...args);
          const operation = result.startupSettled.then(async () => {
            startupEntered.resolve();
            await startup.promise;
          });
          publishedStartup = args[0].kernelRuntime.connectionWork.track(() => operation);
          startupOutcome = publishedStartup.catch((error: unknown) => error);
          return { ...result, startupSettled: publishedStartup };
        });
      const cleanupOwner = {
        stop: vi.fn(async () => {
          if (failCleanup) {
            throw cleanupError;
          }
        }),
      };
      try {
        const token = "gateway-deferred-startup-cleanup-token";
        await state.writeConfig({
          gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
        });
        state.applyEnv();
        const { startGatewayServerCore } = await import("./server-start.js");
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await startupEntered.promise;
        expect(server.startupSettled).toBe(publishedStartup);
        if (!kernel) {
          throw new Error("Expected the real Gateway kernel");
        }
        const activeKernel = kernel;
        activeKernel.registerGatewayLifetimeSidecars([cleanupOwner]);
        const terminalDispose = vi.spyOn(activeKernel.terminalSessions, "disposeAll");
        const drain = activeKernel.connectionWork.drain.bind(activeKernel.connectionWork);
        vi.spyOn(activeKernel.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve();
          await drain();
        });
        const closeSettled = vi.fn();
        closeOutcome = server.close({ reason: "gateway startup failed" }).then(
          () => {
            closeSettled();
            return undefined;
          },
          (error: unknown) => {
            closeSettled();
            return error;
          },
        );
        await drainEntered.promise;
        await nextTurn();
        expect(closeSettled).not.toHaveBeenCalled();
        expect(terminalDispose).not.toHaveBeenCalled();
        expect(cleanupOwner.stop).not.toHaveBeenCalled();
        releaseStartup();
        expect(await startupOutcome).toBe(startupError);
        const outcome = await closeOutcome;
        if (cleanup === "failed") {
          expect(outcome).toMatchObject({
            errors: [
              {
                message: expect.stringContaining("gateway lifetime sidecars"),
                cause: cleanupError,
              },
              { message: expect.stringContaining("late sidecar cleanup"), cause: cleanupError },
            ],
          });
        } else {
          expect(outcome).toBeUndefined();
        }
        expect(terminalDispose).toHaveBeenCalledOnce();
        expect(cleanupOwner.stop).toHaveBeenCalled();
        await expect(server.startupSettled).rejects.toBe(startupError);
      } finally {
        releaseStartup();
        try {
          await Promise.all([startupFailure, startupOutcome]);
          const outcome = await closeOutcome;
          failCleanup = false;
          if (kernel && (!closeOutcome || outcome !== undefined)) {
            await kernel.closeOnStartupFailure();
          }
          await state.cleanup();
        } finally {
          signal.removeEventListener("abort", releaseStartup);
          startupFactory.mockRestore();
          kernelFactory.mockRestore();
          vi.restoreAllMocks();
        }
      }
    },
  );

  it("releases post-ready startup work after failure before joining cleanup", async () => {
    const port = await getFreePort();
    const state = await createStartupTestState("gateway-post-ready-startup-failure");
    const startupError = new Error("startup failed after post-attach installation");
    const emergencyRelease = createDeferred();
    const drainEntered = createDeferred<{ barrierReleased: boolean }>();
    const resumed = vi.fn<(state: { closing: boolean; listening: boolean }) => void>();
    let barrierReleased = false;
    let emergencyUsed = false;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    let postReadyWork: Promise<void> | undefined;
    let startupOutcome: Promise<unknown> | undefined;
    let unexpectedServer: GatewayServer | undefined;
    const startupModule = await import("./server-startup-finish.js");
    const finishStartup = startupModule.finishGatewayStartup;
    const startupFactory = vi
      .spyOn(startupModule, "finishGatewayStartup")
      .mockImplementation(async (params) => {
        const result = await finishStartup(params);
        await result.startupSettled;
        const owner = params.kernelRuntime;
        kernel = owner;
        const transport = owner.transportBridge.current();
        if (!transport?.httpServer.listening) {
          throw new Error("Expected the real Gateway listener before startup failure");
        }
        // Minimal boot skips this production continuation; retain the exact
        // public-start barrier and work owner used by nonminimal post-attach.
        const barrier = params.waitForPostReadyWork().then(() => {
          barrierReleased = true;
        });
        const operation = (async () => {
          const releasedBy = await Promise.race([
            barrier.then(() => "gateway" as const),
            emergencyRelease.promise.then(() => "fixture" as const),
          ]);
          emergencyUsed = releasedBy === "fixture";
          resumed({
            closing: owner.lifecycle.closePreludeStarted,
            listening: transport.httpServer.listening,
          });
        })();
        postReadyWork = owner.connectionWork.track(() => operation);
        const drain = owner.connectionWork.drain.bind(owner.connectionWork);
        vi.spyOn(owner.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve({ barrierReleased });
          await drain();
        });
        throw startupError;
      });
    try {
      const token = "gateway-post-ready-startup-token";
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      startupOutcome = startGatewayServerCore(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      }).then(
        (server) => {
          unexpectedServer = server;
          return undefined;
        },
        (error: unknown) => error,
      );
      const boundary = await Promise.race([drainEntered.promise, startupOutcome]);
      expect(boundary).toEqual({ barrierReleased: true });
      expect(await startupOutcome).toBe(startupError);
      await postReadyWork;
      expect(emergencyUsed).toBe(false);
      expect(resumed).toHaveBeenCalledExactlyOnceWith({ closing: true, listening: true });
      expect(kernel?.transportBridge.current()?.httpServer.listening).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
    } finally {
      // A broken catch path is already observable at drain entry. Release only
      // the synthetic tail here so its original cleanup can finish before state removal.
      emergencyRelease.resolve();
      try {
        await Promise.all([startupOutcome, postReadyWork]);
        await unexpectedServer?.close();
        await state.cleanup();
      } finally {
        startupFactory.mockRestore();
        vi.restoreAllMocks();
      }
    }
  });
});
