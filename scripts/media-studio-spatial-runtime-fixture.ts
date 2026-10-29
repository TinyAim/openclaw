/**
 * Opt-in live fixture for the Wisclaw Spatial Frame Capture closed loop.
 *
 * This mounts the real OpenClaw machine-auth HTTP handler and production
 * render/upload/callback executor without starting a second full Gateway. It is
 * intended for a disposable local Control API instance backed by PostgreSQL and
 * real object storage; it is not a simulated Control API or a provider mock.
 */
import { createServer } from "node:http";
import {
  handleMediaStudioSpatialEnvironmentPanoramaHttpRequest,
  type MediaStudioSpatialEnvironmentPanoramaHttpOptions,
} from "../src/gateway/media-studio-spatial-environment-render-http.js";
import {
  handleMediaStudioSpatialReferenceRenderHttpRequest,
  type MediaStudioSpatialReferenceRenderHttpOptions,
} from "../src/gateway/media-studio-spatial-reference-render-http.js";
import { createMediaStudioSpatialReferenceRuntimeExecutor } from "../src/gateway/media-studio-spatial-reference-runtime/executor.js";
import { createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor } from "../src/gateway/media-studio-spatial-reference-runtime/panorama-executor.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positivePort(value: string | undefined): number {
  const parsed = Number(value ?? "18899");
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("SPATIAL_RUNTIME_FIXTURE_PORT must be a valid TCP port");
  }
  return parsed;
}

const port = positivePort(process.env.SPATIAL_RUNTIME_FIXTURE_PORT);
const host = process.env.SPATIAL_RUNTIME_FIXTURE_HOST?.trim() || "0.0.0.0";
const gatewayToken = required("SPATIAL_RUNTIME_FIXTURE_GATEWAY_TOKEN");
const runtimeToken = required("SPATIAL_RUNTIME_FIXTURE_REGISTRATION_TOKEN");
const runtimeId = required("SPATIAL_RUNTIME_FIXTURE_RUNTIME_ID");
const controlApiUrl = required("SPATIAL_RUNTIME_FIXTURE_CONTROL_API_URL");

const executor = createMediaStudioSpatialReferenceRuntimeExecutor({
  controlApiUrl,
  runtimeId,
  token: runtimeToken,
  log: { warn: (message) => console.warn(message) },
});
const options: MediaStudioSpatialReferenceRenderHttpOptions = {
  auth: {
    mode: "token",
    token: gatewayToken,
    password: undefined,
    allowTailscale: false,
  },
  executor,
};
const panoramaOptions: MediaStudioSpatialEnvironmentPanoramaHttpOptions = {
  auth: options.auth,
  executor: createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor({
    controlApiUrl,
    runtimeId,
    token: runtimeToken,
    log: { warn: (message) => console.warn(message) },
  }),
};

const server = createServer(async (request, response) => {
  try {
    if (await handleMediaStudioSpatialReferenceRenderHttpRequest(request, response, options)) {
      return;
    }
    if (
      await handleMediaStudioSpatialEnvironmentPanoramaHttpRequest(
        request,
        response,
        panoramaOptions,
      )
    ) {
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, code: "not_found" }));
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ ok: false, code: "fixture_failure" }));
  }
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      ok: true,
      kind: "media_studio_spatial_runtime_fixture",
      host,
      port,
      runtimeId,
      controlApiUrl,
    }),
  );
});

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
