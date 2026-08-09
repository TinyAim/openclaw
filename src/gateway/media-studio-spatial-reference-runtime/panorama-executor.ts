/** Grant-based asynchronous model-free panorama executor. */
import { createHash } from "node:crypto";
import type {
  SpatialEnvironmentPanoramaRuntimeExecutor,
  SpatialEnvironmentPanoramaRuntimeRequest,
  SpatialEnvironmentPanoramaRuntimeResult,
} from "../media-studio-spatial-environment-render-http.js";
import {
  createInMemoryPanoramaCallbackOutbox,
  type PanoramaCallbackOutbox,
  type PanoramaCallbackOutboxEntry,
  type PanoramaTerminalCallbackPayload,
} from "./panorama-callback-outbox.js";

const RUNTIME_TOKEN_HEADER = "x-wisclaw-media-gen-runtime-token";
const GRANT_HEADER = "x-wisclaw-spatial-upload-grant";
const SOURCE_GRANT_HEADER = "x-wisclaw-spatial-source-grant";
const TERMINAL_CALLBACK_HEADER = "x-wisclaw-spatial-terminal-callback";
const SOURCE_PATH = "/v1/control/media-gen/runtime/spatial-reference/source";
const UPLOAD_PATH = "/v1/control/media-gen/runtime/spatial-reference/upload";
const CALLBACK_PATH = "/v1/control/media-gen/runtime/spatial-environment-panorama/callback";

type RuntimeFetch = typeof fetch;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function executionId(input: SpatialEnvironmentPanoramaRuntimeRequest): string {
  return `spenv_${createHash("sha256")
    .update(`${input.runtimeId}:${input.dispatchAttemptId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function ack(
  input: SpatialEnvironmentPanoramaRuntimeRequest,
): SpatialEnvironmentPanoramaRuntimeResult {
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
    error?: { code?: string };
  } | null;
  if (!response.ok || !raw?.data) {
    throw new Error(raw?.error?.code ?? `http_${response.status}`);
  }
  return raw.data;
}

export function createMediaStudioSpatialEnvironmentPanoramaRuntimeExecutor(options: {
  controlApiUrl: string;
  runtimeId: string;
  token: string;
  fetchImpl?: RuntimeFetch;
  log?: { warn?: (message: string) => void };
  callbackOutbox?: PanoramaCallbackOutbox;
  callbackRetryIntervalMs?: number;
}): SpatialEnvironmentPanoramaRuntimeExecutor {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cancelled = new Set<string>();
  const acknowledgements = new Map<string, SpatialEnvironmentPanoramaRuntimeResult>();
  const callbackOutbox = options.callbackOutbox ?? createInMemoryPanoramaCallbackOutbox();
  let stopped = false;
  let flushing: Promise<void> | undefined;

  const callback = async (body: unknown): Promise<void> => {
    const response = await fetchImpl(joinUrl(options.controlApiUrl, CALLBACK_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNTIME_TOKEN_HEADER]: options.token,
      },
      body: JSON.stringify(body),
    });
    await envelope(response);
  };

  const flushCallbackOutbox = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = (async () => {
      const entries = await callbackOutbox.list();
      for (const entry of entries) {
        if (stopped) break;
        try {
          await callback(entry.payload);
          await callbackOutbox.remove({
            identity: entry.identity,
            payloadDigest: entry.payloadDigest,
          });
        } catch (error) {
          options.log?.warn?.(
            `panorama terminal callback pending durable replay task=${entry.payload.taskId}: ${String(error)}`,
          );
        }
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  const deliverDurably = async (payload: PanoramaTerminalCallbackPayload): Promise<void> => {
    let entry;
    try {
      entry = await callbackOutbox.enqueue(payload);
    } catch (error) {
      // Without a durable terminal declaration, uploaded output receipts are
      // deliberately not reinterpreted as Runtime success by Control API.
      options.log?.warn?.(
        `panorama callback outbox persist failed task=${payload.taskId}: ${String(error)}`,
      );
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await flushCallbackOutbox().catch((error) => {
        options.log?.warn?.(
          `panorama callback outbox flush failed task=${payload.taskId}: ${String(error)}`,
        );
      });
      const stillPending = (await callbackOutbox.list()).some(
        (candidate) =>
          candidate.identity === entry.identity && candidate.payloadDigest === entry.payloadDigest,
      );
      if (!stillPending) return;
    }
  };

  void flushCallbackOutbox().catch(() => {});
  const callbackRetryTimer = setInterval(
    () => {
      if (!stopped) void flushCallbackOutbox().catch(() => {});
    },
    Math.max(250, options.callbackRetryIntervalMs ?? 5_000),
  );
  callbackRetryTimer.unref?.();

  const run = async (
    input: SpatialEnvironmentPanoramaRuntimeRequest,
    accepted: SpatialEnvironmentPanoramaRuntimeResult,
  ): Promise<void> => {
    const baseCallback = {
      kind: "media_studio.spatial_environment_panorama.callback" as const,
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
      if (input.runtimeId !== options.runtimeId) {
        throw new Error("runtime_id_mismatch");
      }
      if (cancelled.has(input.dispatchAttemptId)) {
        await deliverDurably({ ...baseCallback, status: "cancelled" });
        return;
      }
      const sourceUrl = new URL(joinUrl(options.controlApiUrl, SOURCE_PATH));
      sourceUrl.searchParams.set("workspaceId", input.workspaceId);
      sourceUrl.searchParams.set("runtimeId", input.runtimeId);
      const sourceResponse = await fetchImpl(sourceUrl, {
        method: "POST",
        headers: {
          [RUNTIME_TOKEN_HEADER]: options.token,
          [SOURCE_GRANT_HEADER]: input.sourceGrant.grantToken,
        },
      });
      if (!sourceResponse.ok) {
        throw new Error(`source_redeem_http_${sourceResponse.status}`);
      }
      const source = Buffer.from(await sourceResponse.arrayBuffer());
      const sourceDigest = createHash("sha256").update(source).digest("hex");
      if (
        input.sourceGrant.expectedSha256Hex &&
        sourceDigest !== input.sourceGrant.expectedSha256Hex
      ) {
        throw new Error("source_checksum_mismatch");
      }
      const { renderModelFreePanorama } =
        await import("../media-studio-spatial-environment-render/index.js");
      const rendered = await renderModelFreePanorama({
        sourceImage: source,
        horizontalFovDegrees: input.horizontalFovDegrees,
        outputWidth: input.outputWidth,
        ...(input.centerYawDegrees !== undefined
          ? { centerYawDegrees: input.centerYawDegrees }
          : {}),
      });
      if (cancelled.has(input.dispatchAttemptId)) {
        await deliverDurably({ ...baseCallback, status: "cancelled" });
        return;
      }
      const payloads = new Map<string, { bytes: Buffer; mimeType: string }>([
        ["environment_panorama", { bytes: rendered.panoramaPng, mimeType: "image/png" }],
        [
          "generated_region_mask",
          { bytes: rendered.generatedRegionMaskPng, mimeType: "image/png" },
        ],
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
        const uploadUrl = new URL(joinUrl(options.controlApiUrl, UPLOAD_PATH));
        uploadUrl.searchParams.set("workspaceId", input.workspaceId);
        uploadUrl.searchParams.set("runtimeId", input.runtimeId);
        const predictedReceipt = {
          slot: grant.slot,
          artifactId: grant.artifactId,
          mimeType: payload.mimeType,
          byteLength: payload.bytes.length,
          sha256Hex: createHash("sha256").update(payload.bytes).digest("hex"),
        };
        let terminalCallbackHeader: string | undefined;
        let stagedTerminalCallback: PanoramaCallbackOutboxEntry | undefined;
        if (grant.slot === "quality_report") {
          if (receipts.length !== 2) {
            throw new Error("terminal_callback_receipts_incomplete");
          }
          const terminalCallback: PanoramaTerminalCallbackPayload = {
            ...baseCallback,
            status: "succeeded",
            receipts: [...receipts, predictedReceipt],
          };
          terminalCallbackHeader = Buffer.from(JSON.stringify(terminalCallback), "utf8").toString(
            "base64url",
          );
          // Persist the exact terminal declaration before the final upload.
          // The Control API will not accept it until all receipts exist, while
          // a Runtime crash after the upload can replay it from disk.
          stagedTerminalCallback = await callbackOutbox.enqueue(terminalCallback);
        }
        try {
          const uploadResponse = await fetchImpl(uploadUrl, {
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
          }>(uploadResponse);
          if (
            uploaded.artifactId !== grant.artifactId ||
            uploaded.size !== payload.bytes.length ||
            uploaded.mimeType !== payload.mimeType ||
            uploaded.sha256Hex !== predictedReceipt.sha256Hex
          ) {
            throw new Error(`upload_receipt_mismatch:${grant.slot}`);
          }
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
      const successCallback = {
        ...baseCallback,
        status: "succeeded" as const,
        receipts,
      };
      await deliverDurably(successCallback);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deliverDurably({
        ...baseCallback,
        status: cancelled.has(input.dispatchAttemptId) ? "cancelled" : "failed",
        errorCode: message.split(":", 1)[0] || "panorama_render_failed",
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
    flushCallbacksOnce: flushCallbackOutbox,
  };
}
