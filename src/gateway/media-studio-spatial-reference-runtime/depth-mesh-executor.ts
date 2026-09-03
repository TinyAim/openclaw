/** Grant-based asynchronous deterministic depth-mesh executor. */
import { createHash } from "node:crypto";
import type {
  SpatialDepthMeshGrant,
  SpatialEnvironmentDepthMeshRuntimeExecutor,
  SpatialEnvironmentDepthMeshRuntimeRequest,
  SpatialEnvironmentDepthMeshRuntimeResult,
} from "../media-studio-spatial-depth-mesh-render-http.js";
import {
  createInMemoryDepthMeshCallbackOutbox,
  type DepthMeshCallbackOutbox,
  type DepthMeshCallbackOutboxEntry,
  type DepthMeshTerminalCallbackPayload,
} from "./depth-mesh-callback-outbox.js";
import {
  createTerminalCallbackReplayBackoff,
  readTerminalCallbackResponse,
} from "./terminal-callback-delivery.js";

const RUNTIME_TOKEN_HEADER = "x-wisclaw-media-gen-runtime-token";
const GRANT_HEADER = "x-wisclaw-spatial-upload-grant";
const SOURCE_GRANT_HEADER = "x-wisclaw-spatial-source-grant";
const TERMINAL_CALLBACK_HEADER = "x-wisclaw-spatial-terminal-callback";
const SOURCE_PATH = "/v1/control/media-gen/runtime/spatial-reference/source";
const UPLOAD_PATH = "/v1/control/media-gen/runtime/spatial-reference/upload";
const CALLBACK_PATH = "/v1/control/media-gen/runtime/spatial-environment-depth-mesh/callback";

type RuntimeFetch = typeof fetch;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function executionId(input: SpatialEnvironmentDepthMeshRuntimeRequest): string {
  return `spdepth_${createHash("sha256")
    .update(`${input.runtimeId}:${input.dispatchAttemptId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function ack(
  input: SpatialEnvironmentDepthMeshRuntimeRequest,
): SpatialEnvironmentDepthMeshRuntimeResult {
  return {
    ok: true,
    accepted: true,
    deferredSettlement: true,
    runtimeId: input.runtimeId,
    executionId: executionId(input),
    taskId: input.taskId,
    materializationId: input.materializationId,
    requestFingerprint: input.requestFingerprint,
    executionFingerprint: input.executionFingerprint,
    dispatchAttemptId: input.dispatchAttemptId,
    sequence: input.sequence,
    attempt: input.attempt,
    leaseExpiresAt: input.leaseExpiresAt,
  };
}

async function envelope<T>(response: Response): Promise<T> {
  const raw = (await response.json().catch(() => null)) as {
    data?: T;
    code?: string;
    error?: { code?: string };
  } | null;
  if (!response.ok || !raw?.data) {
    throw new Error(raw?.code ?? raw?.error?.code ?? `http_${response.status}`);
  }
  return raw.data;
}

async function redeemSource(input: {
  fetchImpl: RuntimeFetch;
  controlApiUrl: string;
  token: string;
  workspaceId: string;
  runtimeId: string;
  grant: SpatialDepthMeshGrant;
}): Promise<{ bytes: Buffer; mimeType: string }> {
  const url = new URL(joinUrl(input.controlApiUrl, SOURCE_PATH));
  url.searchParams.set("workspaceId", input.workspaceId);
  url.searchParams.set("runtimeId", input.runtimeId);
  const response = await input.fetchImpl(url, {
    method: "POST",
    headers: {
      [RUNTIME_TOKEN_HEADER]: input.token,
      [SOURCE_GRANT_HEADER]: input.grant.grantToken,
    },
  });
  if (!response.ok) throw new Error(`source_redeem_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  const mimeType = (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .split(";", 1)[0]!
    .trim();
  if (
    !input.grant.allowedMimeTypes.includes(mimeType) ||
    bytes.length < 1 ||
    bytes.length > input.grant.maxBytes ||
    digest !== input.grant.expectedSha256Hex
  )
    throw new Error(`source_receipt_mismatch:${input.grant.slot}`);
  return { bytes, mimeType };
}

function u16le(bytes: Buffer, expectedSamples: number): Uint16Array {
  if (bytes.length !== expectedSamples * 2) {
    throw new Error("depth_adapter_size_mismatch");
  }
  const samples = new Uint16Array(expectedSamples);
  for (let index = 0; index < expectedSamples; index += 1) {
    samples[index] = bytes.readUInt16LE(index * 2);
  }
  return samples;
}

export function createMediaStudioSpatialEnvironmentDepthMeshRuntimeExecutor(options: {
  controlApiUrl: string;
  runtimeId: string;
  token: string;
  fetchImpl?: RuntimeFetch;
  log?: { warn?: (message: string) => void };
  callbackOutbox?: DepthMeshCallbackOutbox;
  callbackRetryIntervalMs?: number;
}): SpatialEnvironmentDepthMeshRuntimeExecutor {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cancelled = new Set<string>();
  const acknowledgements = new Map<string, SpatialEnvironmentDepthMeshRuntimeResult>();
  const callbackOutbox = options.callbackOutbox ?? createInMemoryDepthMeshCallbackOutbox();
  const callbackRetryIntervalMs = Math.max(250, options.callbackRetryIntervalMs ?? 5_000);
  const callbackBackoff = createTerminalCallbackReplayBackoff({
    baseDelayMs: callbackRetryIntervalMs,
  });
  let stopped = false;
  let flushing: Promise<void> | undefined;

  const callback = async (body: unknown) => {
    const response = await fetchImpl(joinUrl(options.controlApiUrl, CALLBACK_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNTIME_TOKEN_HEADER]: options.token,
      },
      body: JSON.stringify(body),
    });
    return readTerminalCallbackResponse<{ accepted: boolean }>(response);
  };

  const flushCallbackOutbox = (force = false): Promise<void> => {
    if (flushing) return flushing;
    flushing = (async () => {
      const entries = await callbackOutbox.list();
      let attempted = 0;
      for (const entry of entries) {
        if (stopped) break;
        const key = `${entry.identity}\n${entry.payloadDigest}`;
        if (!force && !callbackBackoff.isDue(key)) continue;
        if (attempted >= 25) break;
        attempted += 1;
        try {
          const result = await callback(entry.payload);
          if (result.disposition === "terminal_rejection") {
            options.log?.warn?.(
              `depth mesh terminal callback discarded task=${entry.payload.taskId} code=${result.code}`,
            );
          }
          await callbackOutbox.remove({
            identity: entry.identity,
            payloadDigest: entry.payloadDigest,
          });
          callbackBackoff.clear(key);
        } catch (error) {
          callbackBackoff.recordRetry(key);
          options.log?.warn?.(
            `depth mesh terminal callback pending durable replay task=${entry.payload.taskId}: ${String(error)}`,
          );
        }
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  const deliverDurably = async (payload: DepthMeshTerminalCallbackPayload): Promise<void> => {
    try {
      await callbackOutbox.enqueue(payload);
    } catch (error) {
      options.log?.warn?.(
        `depth mesh callback outbox persist failed task=${payload.taskId}: ${String(error)}`,
      );
      return;
    }
    await flushCallbackOutbox(true).catch(() => {});
  };

  void flushCallbackOutbox(true).catch(() => {});
  const callbackRetryTimer = setInterval(() => {
    if (!stopped) void flushCallbackOutbox().catch(() => {});
  }, callbackRetryIntervalMs);
  callbackRetryTimer.unref?.();

  const run = async (
    input: SpatialEnvironmentDepthMeshRuntimeRequest,
    accepted: SpatialEnvironmentDepthMeshRuntimeResult,
  ): Promise<void> => {
    const baseCallback = {
      kind: "media_studio.spatial_environment_depth_mesh.callback" as const,
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      materializationId: input.materializationId,
      executionId: accepted.executionId,
      requestFingerprint: input.requestFingerprint,
      executionFingerprint: input.executionFingerprint,
      dispatchAttemptId: input.dispatchAttemptId,
      sequence: input.sequence,
      attempt: input.attempt,
    };
    try {
      if (input.runtimeId !== options.runtimeId) throw new Error("runtime_id_mismatch");
      if (cancelled.has(input.dispatchAttemptId)) {
        await deliverDurably({ ...baseCallback, status: "cancelled" });
        return;
      }
      const source = await redeemSource({
        fetchImpl,
        controlApiUrl: options.controlApiUrl,
        token: options.token,
        workspaceId: input.workspaceId,
        runtimeId: input.runtimeId,
        grant: input.sourceGrant,
      });
      let depthAdapter;
      if (input.depthAdapter && input.depthGrant) {
        const depth = await redeemSource({
          fetchImpl,
          controlApiUrl: options.controlApiUrl,
          token: options.token,
          workspaceId: input.workspaceId,
          runtimeId: input.runtimeId,
          grant: input.depthGrant,
        });
        depthAdapter = {
          ...input.depthAdapter,
          samples: u16le(depth.bytes, input.depthAdapter.width * input.depthAdapter.height),
        };
      }
      if (cancelled.has(input.dispatchAttemptId)) {
        await deliverDurably({ ...baseCallback, status: "cancelled" });
        return;
      }
      const { renderDeterministicDepthMesh } =
        await import("../media-studio-spatial-depth-mesh-render/index.js");
      const rendered = await renderDeterministicDepthMesh({
        sourceImage: source.bytes,
        sourceMimeType: source.mimeType as "image/png" | "image/jpeg",
        calibration: input.calibration,
        ...(depthAdapter ? { depthAdapter } : {}),
        ...(input.scaleAnchor ? { scaleAnchor: input.scaleAnchor } : {}),
      });
      if (cancelled.has(input.dispatchAttemptId)) {
        await deliverDurably({ ...baseCallback, status: "cancelled" });
        return;
      }
      const payloads = new Map<string, { bytes: Buffer; mimeType: string }>([
        ["environment_depth_mesh", { bytes: rendered.depthMeshGlb, mimeType: "model/gltf-binary" }],
        [
          "generated_region_mask",
          { bytes: rendered.generatedRegionMaskPng, mimeType: "image/png" },
        ],
        ["collision", { bytes: rendered.collisionJson, mimeType: "application/json" }],
        [
          "quality_report",
          {
            bytes: Buffer.from(`${JSON.stringify(rendered.qualityReport, null, 2)}\n`, "utf8"),
            mimeType: "application/json",
          },
        ],
      ]);
      const receipts: Array<{
        slot: string;
        artifactId: string;
        mimeType: string;
        byteLength: number;
        sha256Hex: string;
      }> = [];
      const orderedOutputGrants = [...input.outputUploadGrants].sort((a, b) =>
        a.slot === "quality_report" ? 1 : b.slot === "quality_report" ? -1 : 0,
      );
      for (const grant of orderedOutputGrants) {
        const payload = payloads.get(grant.slot);
        if (!payload || grant.purpose !== "output_upload") {
          throw new Error(`output_grant_mismatch:${grant.slot}`);
        }
        const url = new URL(joinUrl(options.controlApiUrl, UPLOAD_PATH));
        url.searchParams.set("workspaceId", input.workspaceId);
        url.searchParams.set("runtimeId", input.runtimeId);
        const localDigest = createHash("sha256").update(payload.bytes).digest("hex");
        const predictedReceipt = {
          slot: grant.slot,
          artifactId: grant.artifactId,
          mimeType: payload.mimeType,
          byteLength: payload.bytes.length,
          sha256Hex: localDigest,
        };
        let terminalCallbackHeader: string | undefined;
        let stagedTerminalCallback: DepthMeshCallbackOutboxEntry | undefined;
        if (grant.slot === "quality_report") {
          if (receipts.length !== 3) {
            throw new Error("terminal_callback_receipts_incomplete");
          }
          const terminalCallback: DepthMeshTerminalCallbackPayload = {
            ...baseCallback,
            status: "succeeded",
            receipts: [...receipts, predictedReceipt],
          };
          terminalCallbackHeader = Buffer.from(JSON.stringify(terminalCallback), "utf8").toString(
            "base64url",
          );
          stagedTerminalCallback = await callbackOutbox.enqueue(terminalCallback);
        }
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              "content-type": payload.mimeType,
              [RUNTIME_TOKEN_HEADER]: options.token,
              [GRANT_HEADER]: grant.grantToken,
              ...(terminalCallbackHeader
                ? { [TERMINAL_CALLBACK_HEADER]: terminalCallbackHeader }
                : {}),
            },
            body: payload.bytes as unknown as BodyInit,
          });
          const uploaded = await envelope<{
            artifactId: string;
            size: number;
            sha256Hex: string;
            mimeType: string;
          }>(response);
          if (
            uploaded.artifactId !== grant.artifactId ||
            uploaded.size !== payload.bytes.length ||
            uploaded.mimeType !== payload.mimeType ||
            uploaded.sha256Hex !== localDigest
          )
            throw new Error(`upload_receipt_mismatch:${grant.slot}`);
        } catch (error) {
          if (stagedTerminalCallback) {
            await callbackOutbox.remove({
              identity: stagedTerminalCallback.identity,
              payloadDigest: stagedTerminalCallback.payloadDigest,
            });
          }
          throw error;
        }
        receipts.push(predictedReceipt);
      }
      await deliverDurably({ ...baseCallback, status: "succeeded", receipts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deliverDurably({
        ...baseCallback,
        status: cancelled.has(input.dispatchAttemptId) ? "cancelled" : "failed",
        errorCode: message.split(":", 1)[0] || "depth_mesh_render_failed",
        errorMessage: message.slice(0, 200),
      });
    }
  };

  return {
    dispatch(input) {
      const previous = acknowledgements.get(input.dispatchAttemptId);
      if (previous) return previous;
      const accepted = ack(input);
      acknowledgements.set(input.dispatchAttemptId, accepted);
      void run(input, accepted);
      return accepted;
    },
    cancel(input) {
      cancelled.add(input.dispatchAttemptId);
      return { acknowledged: true, terminal: false };
    },
    stop() {
      stopped = true;
      clearInterval(callbackRetryTimer);
    },
    flushCallbacksOnce: () => flushCallbackOutbox(true),
  };
}
