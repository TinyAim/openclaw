import { createHash } from "node:crypto";
import type {
  MediaGenRuntimeArtifactHandoffIdentity,
  MediaGenRuntimeArtifactRef,
  MediaGenRuntimeBridge,
  MediaGenRuntimeByteSource,
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendorOutput,
} from "./types.js";

const RUNTIME_TOKEN_HEADER = "x-wisclaw-media-gen-runtime-token";
const REGISTER_PATH = "/v1/control/media-gen/runtime/register";
const REFERENCE_GRANT_PATH = "/v1/control/media-gen/runtime/reference-grant";
const REFERENCE_REDEEM_PATH = "/v1/control/media-gen/runtime/reference-redeem";
const ARTIFACT_HANDOFF_PATH = "/v1/control/media-gen/runtime/artifact-handoff";

export type ControlApiMediaGenBridgeOptions = {
  controlApiUrl: string;
  runtimeId: string;
  token: string;
  fetchImpl?: MediaGenRuntimeFetch;
  maxReferenceBytes?: number;
};

export type ControlApiMediaGenBridge = Omit<MediaGenRuntimeBridge, "resolveArtifactReference"> & {
  resolveArtifactReference(
    input: Parameters<MediaGenRuntimeBridge["resolveArtifactReference"]>[0],
  ): Promise<MediaGenRuntimeByteSource>;
};

type Envelope<T> = { data?: T };
const DEFAULT_MAX_REFERENCE_BYTES = 64 * 1024 * 1024;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readJson<T>(res: Response, context: string): Promise<T> {
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json || typeof json !== "object" || !("data" in json)) {
    throw new Error(`${context} failed with status ${res.status}`);
  }
  return json.data as T;
}

async function readBoundedBody(res: Response, maxBytes: number, context: string): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${context} exceeds max bytes`);
  }
  if (!res.body) {
    throw new Error(`${context} response has no readable body`);
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${context} exceeds max bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function buildHandoffUrl(
  baseUrl: string,
  runtimeId: string,
  dispatch: MediaGenRuntimeArtifactHandoffIdentity,
  runtimeJobId: string,
  output: MediaGenRuntimeVendorOutput,
  sha256: string,
): string {
  const params = new URLSearchParams({
    workspaceId: dispatch.workspaceId,
    runtimeId,
    taskId: dispatch.taskId,
    runtimeJobId,
    presetId: dispatch.presetId,
    mimeType: output.mimeType,
    sha256,
  });
  if (output.durationSec !== undefined) params.set("durationSec", String(output.durationSec));
  if (output.resolution) params.set("resolution", output.resolution);
  return `${joinUrl(baseUrl, ARTIFACT_HANDOFF_PATH)}?${params.toString()}`;
}

export function createControlApiMediaGenBridge(
  options: ControlApiMediaGenBridgeOptions,
): ControlApiMediaGenBridge {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.controlApiUrl.replace(/\/+$/, "");
  const maxReferenceBytes = options.maxReferenceBytes ?? DEFAULT_MAX_REFERENCE_BYTES;
  const authHeaders = {
    [RUNTIME_TOKEN_HEADER]: options.token,
  };

  async function postJson<T>(path: string, body: unknown, context: string): Promise<T> {
    const res = await fetchImpl(joinUrl(baseUrl, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });
    return readJson<T>(res, context);
  }

  return {
    runtimeId: options.runtimeId,
    async register(input) {
      await postJson(
        REGISTER_PATH,
        {
          runtimeId: options.runtimeId,
          workspaceId: input.workspaceId,
          supportedPresetIds: input.supportedPresetIds,
          enforcesModeration: input.enforcesModeration,
          appliesLabeling: input.appliesLabeling,
          // CP3 §8 honesty gate: only advertise multi-reference when a configured
          // vendor truly maps multi-slot sources. Omitted (⇒ control-plane false)
          // otherwise, so the control plane never builds a references[] dispatch we
          // would silently drop.
          ...(input.supportsMultiReference === true && { supportsMultiReference: true }),
          ...(input.capabilityRouteClaims && input.capabilityRouteClaims.length > 0
            ? { capabilityRouteClaims: input.capabilityRouteClaims }
            : {}),
          ...(input.modelServingClaims && input.modelServingClaims.length > 0
            ? { modelServingClaims: input.modelServingClaims }
            : {}),
        },
        "media-gen runtime register",
      );
    },
    async resolveArtifactReference(input): Promise<MediaGenRuntimeByteSource> {
      const grant = await postJson<{
        grantToken: string;
        mimeType?: string;
        sha256?: string;
      }>(
        REFERENCE_GRANT_PATH,
        {
          workspaceId: input.dispatch.workspaceId,
          runtimeId: options.runtimeId,
          taskId: input.dispatch.taskId,
          reference: { kind: "artifact", artifactId: input.artifactId },
          // CP3 §4.2.4: carry the slot role so the control plane authoritatively
          // rejects a role↔mime mismatch before minting the grant.
          ...(input.role !== undefined && { role: input.role }),
          ...(input.ordinal !== undefined && { ordinal: input.ordinal }),
        },
        "media-gen reference grant",
      );
      const res = await fetchImpl(joinUrl(baseUrl, REFERENCE_REDEEM_PATH), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({
          grantToken: grant.grantToken,
          workspaceId: input.dispatch.workspaceId,
          runtimeId: options.runtimeId,
        }),
      });
      if (!res.ok) {
        throw new Error(`media-gen reference redeem failed with status ${res.status}`);
      }
      const bytes = await readBoundedBody(res, maxReferenceBytes, "media-gen reference redeem");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (grant.sha256 && grant.sha256 !== sha256) {
        throw new Error("media-gen reference checksum mismatch");
      }
      return {
        bytes,
        mimeType: res.headers.get("content-type") ?? grant.mimeType ?? "application/octet-stream",
        sha256,
      };
    },
    async handoffArtifact(input): Promise<MediaGenRuntimeArtifactRef> {
      const res = await fetchImpl(
        buildHandoffUrl(
          baseUrl,
          options.runtimeId,
          input.dispatch,
          input.runtimeJobId,
          input.output,
          input.sha256,
        ),
        {
          method: "POST",
          headers: {
            "content-type": input.output.mimeType,
            accept: "application/json",
            ...authHeaders,
          },
          body: input.bytes as unknown as BodyInit,
        },
      );
      const data = await readJson<{ artifact?: MediaGenRuntimeArtifactRef }>(
        res,
        "media-gen artifact handoff",
      );
      if (!data.artifact) {
        throw new Error("media-gen artifact handoff returned no artifact");
      }
      return data.artifact;
    },
  };
}
