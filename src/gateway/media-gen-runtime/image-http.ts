import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateImage } from "../../image-generation/runtime.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "../http-common.js";
import { isRecord } from "../media-gen-runtime-dispatch.js";
import { authorizeMediaGenRuntimeRequest } from "../media-gen-runtime-http.js";
import type { MediaGenRuntimeHttpOptions } from "../media-gen-runtime-http.js";
import type {
  MediaGenRuntimeArtifactHandoffIdentity,
  MediaGenRuntimeArtifactRef,
  MediaGenRuntimeBridge,
  MediaGenRuntimeVendorOutput,
} from "./types.js";

export const MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH = "/v1/runtime/media-gen/image/dispatch";
const MAX_BODY_BYTES = 256 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_SCENARIO = "text_to_image";
const OPS = new Set(["submit", "poll", "cancel", "retry", "reconcile"]);

type ImageDispatch = {
  schemaVersion: 1 | 2;
  op: "submit" | "poll" | "cancel" | "retry" | "reconcile";
  taskId: string;
  workspaceId: string;
  correlationId: string;
  presetId: string;
  mediaClass: "image";
  frozenImagePlan: Record<string, unknown>;
  frozenPlanDigest: string;
  executionAttempt: number;
  runtimeJobId?: string;
};

export type MediaGenRuntimeImageRoute = {
  providerId: string;
  modelId: string;
  routeId: string;
  endpointId: string;
  region: string;
  accountTier: string;
  adapterRevision: string;
  profileId: string;
  profileRevision: number;
  profileDigest: string;
};

type ImageReceipt = {
  schemaVersion: 1;
  runtimeId: string;
  taskId: string;
  workspaceId: string;
  presetId: string;
  executionAttempt: number;
  frozenPlanDigest: string;
  runtimeJobId: string;
  state: "started" | "succeeded" | "failed" | "canceled";
  bytesBase64?: string;
  mimeType?: string;
  sha256?: string;
  artifact?: MediaGenRuntimeArtifactRef;
  failureMessage?: string;
};

export type ImageRouteExecutor = {
  dispatch(input: ImageDispatch): Promise<Record<string, unknown>>;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function token(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value.trim()) ? value : undefined;
}

function parsePlan(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const plan = value;
  if (plan.mediaClass !== "image" || (plan.schemaVersion !== 3 && plan.schemaVersion !== 4))
    return undefined;
  if (
    token(plan.previewId) === undefined ||
    token(plan.presetId) === undefined ||
    token(plan.adapterRevision) === undefined
  )
    return undefined;
  const route = isRecord(plan.providerRouteRef) ? plan.providerRouteRef : undefined;
  const profile = isRecord(plan.capabilityProfileRef) ? plan.capabilityProfileRef : undefined;
  const intent = isRecord(plan.generationIntent) ? plan.generationIntent : undefined;
  const runtime = isRecord(plan.runtimeRef) ? plan.runtimeRef : undefined;
  if (!route || route.schemaVersion !== 1 || !profile || !intent || !runtime) return undefined;
  if (
    !["routeId", "providerId", "modelId", "endpointId", "region", "accountTier"].every(
      (key) => token(route[key]) !== undefined,
    )
  )
    return undefined;
  if (
    token(profile.profileId) === undefined ||
    !Number.isSafeInteger(profile.revision) ||
    typeof profile.digest !== "string"
  )
    return undefined;
  if (
    token(runtime.runtimeId) === undefined ||
    typeof runtime.lastSeenAt !== "string" ||
    Number.isNaN(Date.parse(runtime.lastSeenAt))
  )
    return undefined;
  if (
    intent.generationScenario !== IMAGE_SCENARIO ||
    typeof intent.compiledPrompt !== "string" ||
    !intent.compiledPrompt.trim()
  )
    return undefined;
  if (
    intent.sourceImage !== undefined ||
    intent.mask !== undefined ||
    !Array.isArray(intent.references) ||
    intent.references.length !== 0 ||
    !Array.isArray(intent.operations) ||
    intent.operations.length !== 0 ||
    !Array.isArray(intent.preserveConstraints) ||
    intent.preserveConstraints.length !== 0
  )
    return undefined;
  const output = plan.schemaVersion === 4 ? intent.resolvedOutput : intent.output;
  if (!isRecord(output) || typeof output.format !== "string" || !IMAGE_FORMATS.has(output.format))
    return undefined;
  if (
    plan.schemaVersion === 4 &&
    (!Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height))
  )
    return undefined;
  return plan;
}

function parseDispatch(value: unknown): ImageDispatch | undefined {
  if (!isRecord(value)) return undefined;
  const keys = new Set([
    "schemaVersion",
    "op",
    "taskId",
    "workspaceId",
    "correlationId",
    "presetId",
    "mediaClass",
    "frozenImagePlan",
    "frozenPlanDigest",
    "executionAttempt",
    "runtimeJobId",
  ]);
  if (Object.keys(value).some((key) => !keys.has(key))) return undefined;
  const schemaVersion = value.schemaVersion === 2 ? 2 : value.schemaVersion === 1 ? 1 : undefined;
  const op =
    typeof value.op === "string" && OPS.has(value.op)
      ? (value.op as ImageDispatch["op"])
      : undefined;
  const plan = parsePlan(value.frozenImagePlan);
  const taskId = token(value.taskId);
  const workspaceId = token(value.workspaceId);
  const correlationId = token(value.correlationId);
  const presetId = token(value.presetId);
  const runtimeJobId = value.runtimeJobId === undefined ? undefined : token(value.runtimeJobId);
  if (
    !schemaVersion ||
    !op ||
    !taskId ||
    !workspaceId ||
    !correlationId ||
    !presetId ||
    value.mediaClass !== "image" ||
    !plan ||
    plan.presetId !== presetId ||
    typeof value.frozenPlanDigest !== "string" ||
    !SHA256.test(value.frozenPlanDigest) ||
    digest(plan) !== value.frozenPlanDigest ||
    !Number.isSafeInteger(value.executionAttempt) ||
    value.executionAttempt < 1 ||
    (value.runtimeJobId !== undefined && !runtimeJobId)
  )
    return undefined;
  if ((op === "poll" || op === "cancel") && !runtimeJobId) return undefined;
  if ((op === "submit" || op === "retry") && runtimeJobId !== undefined) return undefined;
  return {
    schemaVersion,
    op,
    taskId,
    workspaceId,
    correlationId,
    presetId,
    mediaClass: "image",
    frozenImagePlan: plan,
    frozenPlanDigest: value.frozenPlanDigest,
    executionAttempt: value.executionAttempt,
    ...(runtimeJobId ? { runtimeJobId } : {}),
  };
}

function result(input: ImageDispatch, status: string, extra: Record<string, unknown> = {}) {
  return {
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    status,
    ...extra,
  };
}

function outputSpec(
  plan: Record<string, unknown>,
):
  | {
      aspectRatio?: string;
      resolution?: "1K" | "2K" | "4K";
      size?: string;
      quality?: "low" | "medium" | "high";
      outputFormat: "png" | "jpeg" | "webp";
      background?: "transparent" | "opaque" | "auto";
    }
  | undefined {
  const intent = plan.generationIntent as Record<string, unknown>;
  const output = (plan.schemaVersion === 4 ? intent.resolvedOutput : intent.output) as Record<
    string,
    unknown
  >;
  const quality =
    output.qualityIntent === "draft" ? "low" : output.qualityIntent === "high" ? "high" : "medium";
  const background =
    output.alphaPolicy === "require"
      ? "transparent"
      : output.alphaPolicy === "forbid"
        ? "opaque"
        : "auto";
  const format = output.format;
  if (format !== "png" && format !== "jpeg" && format !== "webp") return undefined;
  if (plan.schemaVersion === 4) {
    return {
      size: `${String(output.width)}x${String(output.height)}`,
      quality,
      outputFormat: format,
      background,
    };
  }
  const resolution =
    output.resolution === "1K" || output.resolution === "2K" || output.resolution === "4K"
      ? output.resolution
      : undefined;
  return {
    aspectRatio: typeof output.aspectRatio === "string" ? output.aspectRatio : undefined,
    ...(resolution ? { resolution } : {}),
    quality,
    outputFormat: format,
    background,
  };
}

function routeMatches(plan: Record<string, unknown>, route: MediaGenRuntimeImageRoute): boolean {
  const providerRoute = plan.providerRouteRef as Record<string, unknown>;
  const profile = plan.capabilityProfileRef as Record<string, unknown>;
  return (
    providerRoute.providerId === route.providerId &&
    providerRoute.modelId === route.modelId &&
    providerRoute.routeId === route.routeId &&
    providerRoute.endpointId === route.endpointId &&
    providerRoute.region === route.region &&
    providerRoute.accountTier === route.accountTier &&
    plan.adapterRevision === route.adapterRevision &&
    profile.profileId === route.profileId &&
    profile.revision === route.profileRevision &&
    profile.digest === route.profileDigest
  );
}

function receiptKey(
  input: Pick<ImageDispatch, "workspaceId" | "taskId" | "executionAttempt" | "frozenPlanDigest">,
): string {
  return createHash("sha256")
    .update(
      `${input.workspaceId}\u0000${input.taskId}\u0000${input.executionAttempt}\u0000${input.frozenPlanDigest}`,
    )
    .digest("hex");
}

function createReceiptStore(options: { env: NodeJS.ProcessEnv; runtimeId: string }) {
  const dir = path.join(resolveStateDir(options.env), "media-gen-image-receipts-v1");
  const fileFor = (
    input: Pick<ImageDispatch, "workspaceId" | "taskId" | "executionAttempt" | "frozenPlanDigest">,
  ) => path.join(dir, `${receiptKey(input)}.json`);
  async function read(
    input: Pick<ImageDispatch, "workspaceId" | "taskId" | "executionAttempt" | "frozenPlanDigest">,
  ): Promise<ImageReceipt | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileFor(input), "utf8")) as ImageReceipt;
      return parsed.runtimeId === options.runtimeId &&
        parsed.workspaceId === input.workspaceId &&
        parsed.taskId === input.taskId &&
        parsed.executionAttempt === input.executionAttempt &&
        parsed.frozenPlanDigest === input.frozenPlanDigest
        ? parsed
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("media_image_runtime_receipt_corrupt");
    }
  }
  async function write(record: ImageReceipt, exclusive = false): Promise<boolean> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = fileFor(record);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    if (exclusive) {
      try {
        const handle = await fs.open(target, "wx", 0o600);
        await handle.writeFile(JSON.stringify(record));
        await handle.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    }
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temp, target);
    return true;
  }
  return { read, write };
}

export function createMediaGenRuntimeImageExecutor(options: {
  env?: NodeJS.ProcessEnv;
  runtimeId: string;
  route: MediaGenRuntimeImageRoute;
  bridge: MediaGenRuntimeBridge;
  getConfig: () => OpenClawConfig;
}): ImageRouteExecutor {
  const store = createReceiptStore({
    env: options.env ?? process.env,
    runtimeId: options.runtimeId,
  });
  const handoff = async (
    input: ImageDispatch,
    record: ImageReceipt,
  ): Promise<MediaGenRuntimeArtifactRef> => {
    if (!record.bytesBase64 || !record.mimeType || !record.sha256)
      throw new Error("image receipt has no output bytes");
    if (record.artifact) return record.artifact;
    const identity: MediaGenRuntimeArtifactHandoffIdentity = {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      presetId: input.presetId,
    };
    const output: MediaGenRuntimeVendorOutput = {
      mediaRef: `runtime-local://${record.runtimeJobId}`,
      mimeType: record.mimeType,
    };
    const artifact = await options.bridge.handoffArtifact({
      dispatch: identity,
      runtimeJobId: record.runtimeJobId,
      output,
      bytes: Buffer.from(record.bytesBase64, "base64"),
      sha256: record.sha256,
    });
    await store.write({ ...record, artifact });
    return artifact;
  };
  return {
    async dispatch(input) {
      if (!routeMatches(input.frozenImagePlan, options.route))
        return result(input, "failed", {
          failureReason: "vendor_rejected",
          failureMessage: "frozen image route is not registered on this runtime",
        });
      const existing = await store.read(input);
      if (input.op === "submit" || input.op === "retry") {
        if (existing) {
          if (existing.state === "succeeded")
            return result(input, "processing", { runtimeJobId: existing.runtimeJobId });
          if (existing.state === "failed")
            return result(input, "failed", {
              runtimeJobId: existing.runtimeJobId,
              failureReason: "vendor_failed",
              failureMessage: existing.failureMessage ?? "image generation failed",
            });
          return result(input, "submission_unknown", {
            providerRequestDigest: digest({
              input: input.frozenPlanDigest,
              attempt: input.executionAttempt,
            }),
          });
        }
        const started: ImageReceipt = {
          schemaVersion: 1,
          runtimeId: options.runtimeId,
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          presetId: input.presetId,
          executionAttempt: input.executionAttempt,
          frozenPlanDigest: input.frozenPlanDigest,
          runtimeJobId: `image:${randomUUID()}`,
          state: "started",
        };
        if (!(await store.write(started, true)))
          return result(input, "submission_unknown", {
            providerRequestDigest: digest({
              input: input.frozenPlanDigest,
              attempt: input.executionAttempt,
            }),
          });
        try {
          const spec = outputSpec(input.frozenImagePlan);
          if (!spec) throw new Error("image output mapping is unavailable");
          const generated = await generateImage({
            cfg: options.getConfig(),
            prompt: (input.frozenImagePlan.generationIntent as Record<string, unknown>)
              .compiledPrompt as string,
            modelOverride: `${options.route.providerId}/${options.route.modelId}`,
            autoProviderFallback: false,
            ...spec,
          });
          const image = generated.images[0];
          const completed: ImageReceipt = {
            ...started,
            state: "succeeded",
            bytesBase64: image.buffer.toString("base64"),
            mimeType: image.mimeType,
            sha256: createHash("sha256").update(image.buffer).digest("hex"),
          };
          await store.write(completed);
          return result(input, "processing", { runtimeJobId: started.runtimeJobId });
        } catch (error) {
          const failed: ImageReceipt = {
            ...started,
            state: "failed",
            failureMessage: error instanceof Error ? error.message : "image generation failed",
          };
          await store.write(failed);
          return result(input, "failed", {
            runtimeJobId: started.runtimeJobId,
            failureReason: "vendor_failed",
            failureMessage: failed.failureMessage,
          });
        }
      }
      if (!existing || existing.runtimeJobId !== input.runtimeJobId)
        return result(input, "failed", {
          failureReason: "vendor_rejected",
          failureMessage: "exact image runtime receipt not found",
        });
      if (input.op === "cancel") {
        if (existing.state === "succeeded") {
          const artifact = await handoff(input, existing);
          return result(input, "succeeded", {
            runtimeJobId: existing.runtimeJobId,
            artifact,
            snapshot: { executionOwner: "user_runtime", runtimeId: options.runtimeId },
          });
        }
        const canceled = { ...existing, state: "canceled" as const };
        await store.write(canceled);
        return result(input, "canceled", {
          runtimeJobId: existing.runtimeJobId,
          runtimeStopOutcome: { state: "confirmed", reasonCode: "runtime_confirmed" },
        });
      }
      if (existing.state === "succeeded") {
        const artifact = await handoff(input, existing);
        return result(input, "succeeded", {
          runtimeJobId: existing.runtimeJobId,
          artifact,
          snapshot: { executionOwner: "user_runtime", runtimeId: options.runtimeId },
        });
      }
      if (existing.state === "failed")
        return result(input, "failed", {
          runtimeJobId: existing.runtimeJobId,
          failureReason: "vendor_failed",
          failureMessage: existing.failureMessage ?? "image generation failed",
        });
      if (existing.state === "canceled")
        return result(input, "canceled", {
          runtimeJobId: existing.runtimeJobId,
          runtimeStopOutcome: { state: "confirmed", reasonCode: "runtime_confirmed" },
        });
      return result(input, "submission_unknown", {
        providerRequestDigest: digest({
          input: input.frozenPlanDigest,
          attempt: input.executionAttempt,
        }),
      });
    },
  };
}

export type MediaGenRuntimeImageHttpOptions = Omit<MediaGenRuntimeHttpOptions, "executor"> & {
  executor?: ImageRouteExecutor;
};

export async function handleMediaGenRuntimeImageHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaGenRuntimeImageHttpOptions,
): Promise<boolean> {
  const pathName = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathName !== MEDIA_GEN_RUNTIME_IMAGE_DISPATCH_PATH) return false;
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  if (!(await authorizeMediaGenRuntimeRequest(req, res, options))) return true;
  const body = await readJsonBodyOrError(req, res, options.maxBodyBytes ?? MAX_BODY_BYTES);
  if (body === undefined) return true;
  const dispatch = parseDispatch(body);
  if (!dispatch) {
    sendInvalidRequest(res, "Invalid closed image runtime dispatch");
    return true;
  }
  if (!options.executor) {
    sendJson(
      res,
      200,
      result(dispatch, "failed", {
        failureReason: "internal",
        failureMessage: "image runtime executor is not configured",
      }),
    );
    return true;
  }
  sendJson(res, 200, await options.executor.dispatch(dispatch));
  return true;
}
