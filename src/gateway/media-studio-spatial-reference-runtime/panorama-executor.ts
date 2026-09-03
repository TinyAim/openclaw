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
const CALLBACK_PATH = "/v1/control/media-gen/runtime/spatial-environment-panorama/callback";

type RuntimeFetch = typeof fetch;

const TRANSIENT_IO_ATTEMPTS = 3;

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchWithTransientRetry(input: {
  fetchImpl: RuntimeFetch;
  url: URL;
  init: RequestInit;
  retryDelayMs: number;
}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_IO_ATTEMPTS; attempt += 1) {
    try {
      const response = await input.fetchImpl(input.url, input.init);
      if (!isTransientHttpStatus(response.status) || attempt === TRANSIENT_IO_ATTEMPTS) {
        return response;
      }
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === TRANSIENT_IO_ATTEMPTS) throw error;
    }
    if (input.retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, input.retryDelayMs * attempt);
      });
    }
  }
  throw lastError ?? new Error("transient_fetch_failed");
}

function stageFailure(input: { stage: string; error: unknown }): {
  code: string;
  message: string;
  diagnostic: string;
} {
  const error = input.error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawCode = rawMessage.split(":", 1)[0]?.trim();
  const cause = error instanceof Error ? error.cause : undefined;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  const genericFetchFailure =
    rawMessage === "fetch failed" || rawMessage === "transient_fetch_failed";
  const code = genericFetchFailure
    ? `panorama_${input.stage}_failed`
    : rawCode || `panorama_${input.stage}_failed`;
  const causeSuffix = causeCode ? ` (${causeCode})` : "";
  return {
    code,
    message: `${input.stage}: ${rawMessage}${causeSuffix}`.slice(0, 200),
    diagnostic: `${rawMessage}${causeSuffix}`,
  };
}

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
    code?: string;
    error?: { code?: string };
  } | null;
  if (!response.ok || !raw?.data) {
    throw new Error(raw?.code ?? raw?.error?.code ?? `http_${response.status}`);
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
  ioRetryDelayMs?: number;
}): SpatialEnvironmentPanoramaRuntimeExecutor {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cancelled = new Set<string>();
  const acknowledgements = new Map<string, SpatialEnvironmentPanoramaRuntimeResult>();
  const callbackOutbox = options.callbackOutbox ?? createInMemoryPanoramaCallbackOutbox();
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
              `panorama terminal callback discarded task=${entry.payload.taskId} code=${result.code}`,
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
    try {
      await callbackOutbox.enqueue(payload);
    } catch (error) {
      // Without a durable terminal declaration, uploaded output receipts are
      // deliberately not reinterpreted as Runtime success by Control API.
      options.log?.warn?.(
        `panorama callback outbox persist failed task=${payload.taskId}: ${String(error)}`,
      );
      return;
    }
    await flushCallbackOutbox(true).catch((error) => {
      options.log?.warn?.(
        `panorama callback outbox flush failed task=${payload.taskId}: ${String(error)}`,
      );
    });
  };

  void flushCallbackOutbox(true).catch(() => {});
  const callbackRetryTimer = setInterval(() => {
    if (!stopped) void flushCallbackOutbox().catch(() => {});
  }, callbackRetryIntervalMs);
  callbackRetryTimer.unref?.();

  const run = async (
    input: SpatialEnvironmentPanoramaRuntimeRequest,
    accepted: SpatialEnvironmentPanoramaRuntimeResult,
  ): Promise<void> => {
    let stage = "preflight";
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
      stage = "source_fetch";
      const sourceResponse = await fetchWithTransientRetry({
        fetchImpl,
        url: sourceUrl,
        retryDelayMs: Math.max(0, options.ioRetryDelayMs ?? 100),
        init: {
          method: "POST",
          headers: {
            [RUNTIME_TOKEN_HEADER]: options.token,
            [SOURCE_GRANT_HEADER]: input.sourceGrant.grantToken,
          },
        },
      });
      if (!sourceResponse.ok) {
        throw new Error(`source_redeem_http_${sourceResponse.status}`);
      }
      stage = "source_read";
      const source = Buffer.from(await sourceResponse.arrayBuffer());
      stage = "source_validate";
      const sourceMimeType = (sourceResponse.headers.get("content-type") ?? "")
        .toLowerCase()
        .split(";", 1)[0]!
        .trim();
      const sourceDigest = createHash("sha256").update(source).digest("hex");
      if (
        !input.sourceGrant.allowedMimeTypes.includes(sourceMimeType) ||
        source.length < 1 ||
        source.length > input.sourceGrant.maxBytes ||
        (input.sourceGrant.expectedSha256Hex &&
          sourceDigest !== input.sourceGrant.expectedSha256Hex)
      ) {
        throw new Error("source_receipt_mismatch");
      }
      const { renderModelFreePanorama } =
        await import("../media-studio-spatial-environment-render/index.js");
      stage = "render";
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
        stage = `upload_${grant.slot}`;
        const payload = payloads.get(grant.slot);
        if (!payload || grant.purpose !== "output_upload") {
          throw new Error(`output_grant_mismatch:${grant.slot}`);
        }
        if (
          !grant.allowedMimeTypes.includes(payload.mimeType) ||
          payload.bytes.length < 1 ||
          payload.bytes.length > grant.maxBytes
        ) {
          throw new Error(`output_contract_mismatch:${grant.slot}`);
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
          const uploadResponse = await fetchWithTransientRetry({
            fetchImpl,
            url: uploadUrl,
            retryDelayMs: Math.max(0, options.ioRetryDelayMs ?? 100),
            init: {
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
            },
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
      const failure = stageFailure({ stage, error });
      options.log?.warn?.(
        `panorama execution failed task=${input.taskId} stage=${stage}: ${failure.diagnostic}`,
      );
      await deliverDurably({
        ...baseCallback,
        status: cancelled.has(input.dispatchAttemptId) ? "cancelled" : "failed",
        errorCode: failure.code,
        errorMessage: failure.message,
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
