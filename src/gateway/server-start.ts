import { formatErrorMessage } from "../infra/errors.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  createGatewayKernel,
  gatewayKernelLogs,
  resetPreparedModelCatalogForTestCore,
} from "./server-kernel.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { createGatewayHttpTransport } from "./server-runtime-state.js";
import { rethrowGatewayStartupError, runGatewayShutdownSteps } from "./server-shutdown.js";
import { finishGatewayStartup } from "./server-startup-finish.js";
import { beginMacOSSystemCaWarmupOnce } from "./system-ca-warmup.js";

const loadGatewayStartupPostAttachModule = createLazyRuntimeModule(
  () => import("./server-startup-post-attach.js"),
);

const { log, logTailscale, logChannels, logHealth, logCron, logReload, logHooks, logWsControl } =
  gatewayKernelLogs;
const POST_READY_WORK_START_DELAY_MS = 500;
const spatialReferenceReasonCodes = new Set([
  "spatial_v2_host_memory_unavailable",
  "spatial_v2_qualification_scope_unconfirmed",
  "spatial_v2_qualification_admission_release_failed",
]);
const spatialReferenceStartupReasons = new Map([
  ["v2 bundle directory or Chromium executable is missing", "v2_bundle_or_chromium_missing"],
  ["configured Chromium path is not a file", "chromium_path_invalid"],
  ["reference renderer bundle manifest does not match v2 artifact", "v2_bundle_manifest_mismatch"],
  ["v2 packaged renderer worker is unavailable", "v2_packaged_renderer_unavailable"],
  ["control-api URL, runtime id, or token is missing", "runtime_binding_missing"],
  [
    "v2 resource qualification is blocked by durable Runtime admission",
    "runtime_admission_blocked",
  ],
  [
    "v2 resource qualification is blocked by durable Runtime admission: active_owner",
    "runtime_admission_active_owner",
  ],
]);

export function spatialReferenceRuntimeReasonCode(reason: string): string {
  if (spatialReferenceReasonCodes.has(reason)) return reason;
  if (reason.startsWith("v2 toolchain probe failed:")) return "v2_toolchain_probe_failed";
  return spatialReferenceStartupReasons.get(reason) ?? "qualification_failed";
}

export { resetPreparedModelCatalogForTestCore };

export async function startGatewayServerCore(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  let releasePostReadyWork: () => void = () => {};
  const postReadyWorkBarrier = new Promise<void>((resolve) => {
    releasePostReadyWork = resolve;
  });
  const gatewayKernel = await createGatewayKernel(port, opts, { deferEarlyRuntime: true });
  if (!gatewayKernel.minimalTestGateway) {
    // Start the Keychain read early so it overlaps bootstrap; post-attach awaits the
    // shared promise before plugins can use TLS.
    void beginMacOSSystemCaWarmupOnce({ log });
  }
  let startupSettled: Promise<void>;
  const {
    beginClosePrelude,
    closeOnStartupFailure,
    prepareClose,
    sealAndJoinRegisteredSidecarStops,
    runClosePrelude,
    stopRegisteredGatewayLifetimeSidecars,
    stopRegisteredPostReadySidecars,
    stopConnectionDependentSidecars,
    terminalSessions,
    shutdownRuntime,
  } = gatewayKernel;
  try {
    const envMediaGenRuntime =
      opts.mediaGenRuntimeExecutor === undefined &&
      process.env.OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED === "1"
        ? (await import("./media-gen-runtime/index.js")).createOpenClawMediaGenRuntimeFromEnv({
            log: {
              info: (msg) => log.info(msg),
              warn: (msg) => log.warn(msg),
            },
          })
        : {
            enabled: false as const,
            reason: "media-gen runtime executor not requested",
          };
    const envSpatialReferenceRuntime =
      opts.spatialReferenceRuntimeExecutor === undefined &&
      opts.spatialEnvironmentPanoramaRuntimeExecutor === undefined &&
      opts.spatialEnvironmentDepthMeshRuntimeExecutor === undefined
        ? await (
            await import("./media-studio-spatial-reference-runtime/index.js")
          ).createMediaStudioSpatialReferenceRuntimeFromEnv({
            log: {
              info: (msg) => log.info(msg),
              warn: (msg) => log.warn(msg),
            },
          })
        : { enabled: false as const, reason: "spatial runtime executor option provided" };
    const spatialReferenceRequested = /^(1|true|yes|on)$/i.test(
      process.env.OPENCLAW_MEDIA_STUDIO_SPATIAL_RENDER_ENABLED?.trim() ?? "",
    );
    if (spatialReferenceRequested && !envSpatialReferenceRuntime.enabled) {
      log.warn(
        `spatial reference runtime startup skipped reason=${spatialReferenceRuntimeReasonCode(envSpatialReferenceRuntime.reason)}`,
      );
    }
    const transport = await createGatewayHttpTransport({
      ...gatewayKernel.createHttpTransportOptions(),
      mediaGenRuntimeExecutor:
        opts.mediaGenRuntimeExecutor ??
        (envMediaGenRuntime.enabled ? envMediaGenRuntime.executor : undefined),
      mediaGenRuntimeImageExecutor:
        opts.mediaGenRuntimeImageExecutor ??
        (envMediaGenRuntime.enabled ? envMediaGenRuntime.imageExecutor : undefined),
      spatialReferenceRuntimeExecutor:
        opts.spatialReferenceRuntimeExecutor ??
        (envSpatialReferenceRuntime.enabled ? envSpatialReferenceRuntime.executor : undefined),
      spatialEnvironmentPanoramaRuntimeExecutor:
        opts.spatialEnvironmentPanoramaRuntimeExecutor ??
        (envSpatialReferenceRuntime.enabled
          ? envSpatialReferenceRuntime.panoramaExecutor
          : undefined),
      spatialEnvironmentDepthMeshRuntimeExecutor:
        opts.spatialEnvironmentDepthMeshRuntimeExecutor ??
        (envSpatialReferenceRuntime.enabled
          ? envSpatialReferenceRuntime.depthMeshExecutor
          : undefined),
      ...(!gatewayKernel.minimalTestGateway && gatewayKernel.tailscaleMode !== "off"
        ? {
            prepareManagedTailscaleIngress: async (backend) => {
              const { startGatewayTailscaleExposure } = await import("./server-tailscale.js");
              const cleanup = await startGatewayTailscaleExposure({
                tailscaleMode: gatewayKernel.tailscaleMode,
                preserveFunnel: gatewayKernel.tailscaleConfig.preserveFunnel ?? false,
                port,
                backend,
                controlUiBasePath: gatewayKernel.controlUiBasePath,
                logTailscale,
              });
              // The server close handle is not published until this callback settles.
              // Startup failure therefore owns teardown before normal close can race it.
              gatewayKernel.kernel.setTailscaleCleanup(cleanup);
            },
          }
        : {}),
    });
    gatewayKernel.transportBridge.attach(transport);
    const startup = await finishGatewayStartup({
      kernelRuntime: { ...gatewayKernel, ...transport },
      port,
      opts,
      bootId: gatewayKernel.bootId,
      log,
      logHealth,
      logWsControl,
      logHooks,
      logChannels,
      logCron,
      logReload,
      loadGatewayStartupPostAttachModule,
      waitForPostReadyWork: () => postReadyWorkBarrier,
    });
    if (envSpatialReferenceRuntime.enabled) {
      gatewayKernel.registerGatewayLifetimeSidecars([
        { stop: envSpatialReferenceRuntime.startHeartbeat() },
      ]);
    }
    startupSettled = startup.startupSettled;
  } catch (err) {
    // Failed startup must release work whose normal timer was never armed.
    releasePostReadyWork();
    return await rethrowGatewayStartupError(err, closeOnStartupFailure);
  }
  // The public server is fully initialized now. Leave a short I/O window before
  // background prewarms and cleanup imports compete for the startup CPU.
  const postReadyWorkTimer = setTimeout(releasePostReadyWork, POST_READY_WORK_START_DELAY_MS);
  postReadyWorkTimer.unref?.();

  let closePromise: Promise<void> | undefined;

  return {
    startupSettled,
    getTailscaleIngressEndpoint: gatewayKernel.transportBridge.getTailscaleIngressEndpoint,
    close: (optsLocal) => {
      if (!closePromise) {
        const prelude = beginClosePrelude(optsLocal);
        clearTimeout(postReadyWorkTimer);
        releasePostReadyWork();
        closePromise = (async () => {
          await prelude;
          const close = await prepareClose(optsLocal);
          await runGatewayShutdownSteps({
            steps: [
              {
                name: "connection-dependent sidecars",
                run: stopConnectionDependentSidecars,
                required: true,
              },
              {
                name: "received connection work",
                run: () => gatewayKernel.connectionWork.drain(),
                required: true,
              },
              { name: "terminal sessions", run: () => terminalSessions.disposeAll() },
              { name: "gateway lifetime sidecars", run: stopRegisteredGatewayLifetimeSidecars },
              { name: "post-ready sidecars", run: stopRegisteredPostReadySidecars },
              {
                name: "gateway_stop plugin hooks",
                run: async () => {
                  await shutdownRuntime.runGlobalGatewayStopSafely({
                    event: { reason: optsLocal?.reason ?? "gateway stopping" },
                    ctx: { port },
                    onError: (error) =>
                      log.warn(`gateway_stop hook failed: ${formatErrorMessage(error)}`),
                  });
                },
              },
              { name: "gateway close prelude", run: runClosePrelude },
              {
                name: "late sidecar cleanup",
                run: sealAndJoinRegisteredSidecarStops,
                required: true,
              },
              { name: "gateway close", run: close },
            ],
            onError: (message) => log.error(message),
          });
        })();
      }
      return closePromise;
    },
  };
}
