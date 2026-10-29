import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertExactImageGenerationOverrides,
  resolveImageGenerationOverrides,
} from "../../image-generation/normalization.js";
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
import {
  createImageReceiptStore,
  imageLifecycleReceipt,
  parseImageLifecycleReceipt,
  type ImageReceipt,
} from "./image-receipt.js";
import {
  collectImageRegistrationSnapshot,
  imagePlanMatchesProtectedBinding,
  prepareProtectedImageExecution,
  type ImageRegistrationSnapshot,
} from "./image-registration.js";
import {
  imageDigest as digest,
  imageCredentialBindingDigest,
  readProtectedImageCredential,
  type MediaGenRuntimeImageRoute,
} from "./image-route-config.js";
export type { MediaGenRuntimeImageRoute } from "./image-route-config.js";
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
  stopOnly?: true;
};

export type MediaGenRuntimeImageCompliance = {
  enforcesModeration: boolean;
  appliesLabeling: boolean;
  registrationDisclosureStatus: "undeclared" | "operator_self_declared";
};

export type ImageRouteExecutor = {
  dispatch(input: ImageDispatch): Promise<Record<string, unknown>>;
  registrationSnapshot?(workspaceId: string): Promise<ImageRegistrationSnapshot>;
};

function token(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

function parsePlan(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const plan = value;
  const planKeys = new Set([
    "schemaVersion",
    "previewId",
    "presetId",
    "mediaClass",
    "generationIntent",
    "generationIntentDigest",
    "generationScenario",
    "providerRouteRef",
    "capabilityProfileRef",
    "adapterRevision",
    "executionTopology",
    "servingProtocol",
    "licensePolicyRef",
    "dataEgress",
    "checkpointDigest",
    "runtimeRef",
    "constraintPlan",
    "inputFingerprint",
    "intentFingerprint",
    "resolvedPreservePlanDigest",
    "resolvedReferenceBindingDigest",
    "resolvedOutputSpecDigest",
    "adapterCompilationDigest",
  ]);
  if (Object.keys(plan).some((key) => !planKeys.has(key))) return undefined;
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
    typeof plan.generationIntentDigest !== "string" ||
    plan.generationIntentDigest.length === 0 ||
    plan.generationScenario !== IMAGE_SCENARIO ||
    typeof plan.inputFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(plan.inputFingerprint) ||
    typeof plan.intentFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(plan.intentFingerprint) ||
    typeof plan.resolvedPreservePlanDigest !== "string" ||
    !SHA256.test(plan.resolvedPreservePlanDigest) ||
    typeof plan.resolvedReferenceBindingDigest !== "string" ||
    !SHA256.test(plan.resolvedReferenceBindingDigest) ||
    typeof plan.resolvedOutputSpecDigest !== "string" ||
    !SHA256.test(plan.resolvedOutputSpecDigest) ||
    typeof plan.adapterCompilationDigest !== "string" ||
    !SHA256.test(plan.adapterCompilationDigest) ||
    !Array.isArray(plan.constraintPlan) ||
    plan.constraintPlan.length === 0
  )
    return undefined;
  const constraintPlan = plan.constraintPlan;
  const intentKeys =
    plan.schemaVersion === 4
      ? new Set([
          "schemaVersion",
          "identity",
          "generationScenario",
          "compiledPrompt",
          "sourceImage",
          "mask",
          "references",
          "operations",
          "preserveConstraints",
          "compiledSourceDigests",
          "requestedOutput",
          "resolvedOutput",
          "policy",
        ])
      : new Set([
          "schemaVersion",
          "identity",
          "generationScenario",
          "compiledPrompt",
          "sourceImage",
          "mask",
          "references",
          "operations",
          "preserveConstraints",
          "compiledSourceDigests",
          "output",
          "policy",
        ]);
  if (Object.keys(intent).some((key) => !intentKeys.has(key))) return undefined;
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
  const requiredMappingPaths =
    plan.schemaVersion === 4
      ? [
          "mediaClass",
          "generationScenario",
          "compiledPrompt",
          "resolvedOutput.width",
          "resolvedOutput.height",
          "resolvedOutput.reducedAspectRatio",
          "resolvedOutput.format",
          "resolvedOutput.alphaPolicy",
          "resolvedOutput.transparentPixelRequirement",
          "resolvedOutput.backgroundSemanticRequirement",
          "resolvedOutput.qualityIntent",
        ]
      : [
          "mediaClass",
          "generationScenario",
          "compiledPrompt",
          "output.aspectRatio",
          "output.resolution",
          "output.format",
          "output.alphaPolicy",
          "output.qualityIntent",
        ];
  if (
    !constraintPlan.every((raw) => isRecord(raw) && typeof raw.intentPath === "string") ||
    !requiredMappingPaths.every((path) =>
      constraintPlan.some(
        (raw) =>
          isRecord(raw) &&
          raw.intentPath === path &&
          raw.required === true &&
          raw.support !== "unsupported",
      ),
    )
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
    "stopOnly",
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
    typeof value.executionAttempt !== "number" ||
    !Number.isSafeInteger(value.executionAttempt) ||
    value.executionAttempt < 1 ||
    (value.runtimeJobId !== undefined && !runtimeJobId)
  )
    return undefined;
  if (value.stopOnly !== undefined && (value.stopOnly !== true || op !== "reconcile"))
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
    ...(value.stopOnly === true ? { stopOnly: true } : {}),
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

const RESULT_STATUSES = new Set([
  "processing",
  "succeeded",
  "failed",
  "canceled",
  "submission_unknown",
]);
const FAILURE_REASONS = new Set([
  "auth",
  "quota",
  "vendor_rejected",
  "vendor_failed",
  "content_blocked",
  "download_failed",
  "internal",
]);

const STOP_OUTCOMES = new Set([
  "not_requested:no_runtime_dispatch",
  "requested:runtime_stop_requested",
  "confirmed:runtime_confirmed",
  "not_supported:adapter_not_supported",
  "failed:adapter_rejected",
  "unknown:transport_uncertain",
]);

function normalizeImageResult(
  input: ImageDispatch,
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const allowed = new Set([
    "taskId",
    "workspaceId",
    "correlationId",
    "status",
    "runtimeJobId",
    "providerRequestDigest",
    "artifact",
    "failureReason",
    "failureMessage",
    "runtimeStopOutcome",
    "imageLifecycleReceipt",
    "snapshot",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return undefined;
  if (
    raw.taskId !== input.taskId ||
    raw.workspaceId !== input.workspaceId ||
    raw.correlationId !== input.correlationId ||
    typeof raw.status !== "string" ||
    !RESULT_STATUSES.has(raw.status)
  )
    return undefined;
  const lifecycle =
    raw.imageLifecycleReceipt === undefined
      ? undefined
      : parseImageLifecycleReceipt(raw.imageLifecycleReceipt);
  if (
    raw.imageLifecycleReceipt !== undefined &&
    (!lifecycle ||
      lifecycle.executionAttempt !== input.executionAttempt ||
      lifecycle.frozenPlanDigest !== input.frozenPlanDigest ||
      (raw.status === "processing" &&
        !["processing", "succeeded"].includes(lifecycle.providerOutcome)) ||
      (raw.status === "succeeded" && lifecycle.providerOutcome !== "succeeded") ||
      (raw.status === "failed" &&
        !["failed", "not_submitted"].includes(lifecycle.providerOutcome)) ||
      (raw.status === "submission_unknown" && lifecycle.providerOutcome !== "unknown"))
  )
    return undefined;
  const runtimeJobId = raw.runtimeJobId === undefined ? undefined : token(raw.runtimeJobId);
  if (raw.runtimeJobId !== undefined && !runtimeJobId) return undefined;
  const providerRequestDigest =
    raw.providerRequestDigest === undefined
      ? undefined
      : typeof raw.providerRequestDigest === "string" && SHA256.test(raw.providerRequestDigest)
        ? raw.providerRequestDigest
        : undefined;
  if (raw.providerRequestDigest !== undefined && !providerRequestDigest) return undefined;
  const failureReason = raw.failureReason === undefined ? undefined : raw.failureReason;
  if (
    failureReason !== undefined &&
    (typeof failureReason !== "string" || !FAILURE_REASONS.has(failureReason))
  )
    return undefined;
  const failureMessage = raw.failureMessage === undefined ? undefined : raw.failureMessage;
  if (failureMessage !== undefined || raw.failureMessage !== undefined) {
    if (
      typeof failureMessage !== "string" ||
      failureMessage.length === 0 ||
      failureMessage.length > 2000
    )
      return undefined;
  }
  let artifact: Record<string, unknown> | undefined;
  if (raw.artifact !== undefined) {
    if (!isRecord(raw.artifact)) return undefined;
    const artifactKeys = new Set(["artifactId", "sha256", "durationSec", "resolution", "mimeType"]);
    if (Object.keys(raw.artifact).some((key) => !artifactKeys.has(key))) return undefined;
    if (
      token(raw.artifact.artifactId) === undefined ||
      typeof raw.artifact.mimeType !== "string" ||
      !/^(?:image|video|audio)\/[A-Za-z0-9.+-]+$/u.test(raw.artifact.mimeType) ||
      typeof raw.artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.artifact.sha256)
    )
      return undefined;
    artifact = {
      artifactId: raw.artifact.artifactId,
      mimeType: raw.artifact.mimeType,
      sha256: raw.artifact.sha256,
      ...(typeof raw.artifact.durationSec === "number"
        ? { durationSec: raw.artifact.durationSec }
        : {}),
      ...(typeof raw.artifact.resolution === "string"
        ? { resolution: raw.artifact.resolution }
        : {}),
    };
  }
  let snapshot: Record<string, unknown> | undefined;
  if (raw.snapshot !== undefined) {
    if (!isRecord(raw.snapshot)) return undefined;
    const snapshotKeys = new Set([
      "executionOwner",
      "moderationStatus",
      "labelingStatus",
      "registrationDisclosureStatus",
      "capturedAt",
      "consentRef",
      "consentRefs",
      "auditRef",
    ]);
    if (Object.keys(raw.snapshot).some((key) => !snapshotKeys.has(key))) return undefined;
    if (
      raw.snapshot.executionOwner !== "user_runtime" ||
      (raw.snapshot.moderationStatus !== "not_enforced" &&
        raw.snapshot.moderationStatus !== "runtime_enforced") ||
      (raw.snapshot.labelingStatus !== "absent" &&
        raw.snapshot.labelingStatus !== "runtime_applied") ||
      (raw.snapshot.registrationDisclosureStatus !== "undeclared" &&
        raw.snapshot.registrationDisclosureStatus !== "operator_self_declared") ||
      typeof raw.snapshot.capturedAt !== "string" ||
      Number.isNaN(Date.parse(raw.snapshot.capturedAt))
    )
      return undefined;
    if (raw.snapshot.consentRef !== undefined && token(raw.snapshot.consentRef) === undefined)
      return undefined;
    if (raw.snapshot.auditRef !== undefined && token(raw.snapshot.auditRef) === undefined)
      return undefined;
    if (
      raw.snapshot.consentRefs !== undefined &&
      (!Array.isArray(raw.snapshot.consentRefs) ||
        raw.snapshot.consentRefs.some((ref) => token(ref) === undefined))
    )
      return undefined;
    snapshot = { ...raw.snapshot };
  }
  if (raw.runtimeStopOutcome !== undefined) {
    if (!isRecord(raw.runtimeStopOutcome) || Object.keys(raw.runtimeStopOutcome).length !== 2)
      return undefined;
    const state = raw.runtimeStopOutcome.state;
    const reasonCode = raw.runtimeStopOutcome.reasonCode;
    if (
      typeof state !== "string" ||
      typeof reasonCode !== "string" ||
      !STOP_OUTCOMES.has(`${state}:${reasonCode}`) ||
      raw.status !== "canceled" ||
      (state !== "not_requested" && !runtimeJobId) ||
      (state === "confirmed" &&
        lifecycle &&
        !["succeeded", "failed", "canceled", "not_submitted"].includes(lifecycle.providerOutcome))
    )
      return undefined;
  }
  if (raw.status === "processing" && !runtimeJobId) return undefined;
  if (raw.status === "submission_unknown" && !providerRequestDigest) return undefined;
  if (raw.status === "failed" && !failureReason) return undefined;
  if (raw.status === "succeeded" && (!runtimeJobId || !artifact || !snapshot)) return undefined;
  if (raw.status !== "succeeded" && artifact) return undefined;
  return {
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    status: raw.status,
    ...(runtimeJobId ? { runtimeJobId } : {}),
    ...(providerRequestDigest ? { providerRequestDigest } : {}),
    ...(artifact ? { artifact } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    ...(raw.runtimeStopOutcome !== undefined ? { runtimeStopOutcome: raw.runtimeStopOutcome } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(lifecycle ? { imageLifecycleReceipt: lifecycle } : {}),
  };
}

function outputSpec(plan: Record<string, unknown>):
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
  if (
    plan.schemaVersion === 4 &&
    ((output.transparentPixelRequirement === "require" && output.alphaPolicy === "forbid") ||
      (output.transparentPixelRequirement === "require" &&
        output.backgroundSemanticRequirement === "opaque"))
  )
    return undefined;
  const background =
    output.transparentPixelRequirement === "require"
      ? "transparent"
      : output.transparentPixelRequirement === "forbid" ||
          output.backgroundSemanticRequirement === "opaque"
        ? "opaque"
        : output.alphaPolicy === "require"
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
    ...(resolution
      ? { resolution }
      : typeof output.resolution === "string" && /^\d+x\d+$/u.test(output.resolution)
        ? { size: output.resolution }
        : {}),
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

export function createMediaGenRuntimeImageExecutor(options: {
  env?: NodeJS.ProcessEnv;
  runtimeId: string;
  route: MediaGenRuntimeImageRoute;
  bridge: MediaGenRuntimeBridge;
  getConfig: () => OpenClawConfig;
  compliance: MediaGenRuntimeImageCompliance;
  /** Test seam; production always uses the OpenClaw image provider runtime. */
  generateImageFn?: typeof generateImage;
}): ImageRouteExecutor {
  const env = options.env ?? process.env;
  const store = createImageReceiptStore({ env, runtimeId: options.runtimeId });
  const providerRequestDigest = (input: ImageDispatch) =>
    digest({
      input: input.frozenPlanDigest,
      attempt: input.executionAttempt,
    });
  function unknown(input: ImageDispatch, record?: ImageReceipt) {
    const lifecycle = record && imageLifecycleReceipt(record);
    return result(input, "submission_unknown", {
      ...(record ? { runtimeJobId: record.runtimeJobId } : {}),
      providerRequestDigest: providerRequestDigest(input),
      ...(lifecycle?.providerOutcome === "unknown" ? { imageLifecycleReceipt: lifecycle } : {}),
    });
  }
  function stopped(input: ImageDispatch, record?: ImageReceipt) {
    if (!record) return unknown(input);
    const lifecycle = record && imageLifecycleReceipt(record);
    const fenced = record?.stopRequested === true;
    const terminal =
      fenced &&
      lifecycle &&
      ["succeeded", "failed", "canceled", "not_submitted"].includes(lifecycle.providerOutcome);
    return result(input, "canceled", {
      ...(record ? { runtimeJobId: record.runtimeJobId } : {}),
      runtimeStopOutcome: terminal
        ? { state: "confirmed", reasonCode: "runtime_confirmed" }
        : fenced && lifecycle && record?.providerDispatchStarted
          ? { state: "not_supported", reasonCode: "adapter_not_supported" }
          : { state: "unknown", reasonCode: "transport_uncertain" },
      ...(lifecycle ? { imageLifecycleReceipt: lifecycle } : {}),
    });
  }
  function observe(
    input: ImageDispatch,
    record?: ImageReceipt,
    consumeArtifact = false,
  ): Record<string, unknown> {
    if (record?.stopRequested || record?.state === "canceled") return stopped(input, record);
    const lifecycle = record && imageLifecycleReceipt(record);
    // Old rows cannot invent the immutable submit correlation or no-effect proof.
    if (!record || !lifecycle) return unknown(input, record);
    const identity = { runtimeJobId: record.runtimeJobId, imageLifecycleReceipt: lifecycle };
    if (record.state === "succeeded") {
      return consumeArtifact && record.artifact
        ? result(input, "succeeded", {
            ...identity,
            artifact: record.artifact,
            snapshot: record.snapshot,
          })
        : result(input, "processing", identity);
    }
    if (record.state === "failed")
      return result(input, "failed", {
        ...identity,
        failureReason:
          record.providerOutcome === "not_submitted" ? "vendor_rejected" : "vendor_failed",
        failureMessage: record.failureMessage ?? "image generation failed",
      });
    return unknown(input, record);
  }
  async function noEffect(input: ImageDispatch, message: string) {
    const record = await store.update(input, (current) =>
      current.state !== "started"
        ? current
        : {
            ...current,
            state: "failed",
            providerOutcome: "not_submitted",
            retryDisposition: current.stopRequested ? "reconcile_only" : "replacement_allowed",
            failureMessage: message,
          },
    );
    return observe(input, record);
  }
  async function handoff(input: ImageDispatch): Promise<Record<string, unknown>> {
    // Claim the original handoff durably, then release the journal lock before
    // network I/O so stop can persist while the remote owner is unresponsive.
    const claim = await store.transact(input, async (record, commit) => {
      if (
        !record ||
        record.stopRequested ||
        !imageLifecycleReceipt(record) ||
        record.state !== "succeeded" ||
        record.artifact
      )
        return { record, post: false };
      return {
        record: record.handoffStarted ? record : await commit({ ...record, handoffStarted: true }),
        post: !record.handoffStarted,
      };
    });
    // Re-read after the claim's awaited release. A stop that already persisted
    // must prevent new handoff I/O, including a readback from a stale sample.
    const pending = await store.read(input);
    if (
      !pending ||
      pending.stopRequested ||
      !imageLifecycleReceipt(pending) ||
      pending.state !== "succeeded" ||
      pending.artifact ||
      !claim.record ||
      !pending.handoffStarted
    )
      return observe(input, pending, true);
    try {
      const identity: MediaGenRuntimeArtifactHandoffIdentity & {
        executionAttempt: number;
        frozenPlanDigest: string;
      } = {
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        presetId: input.presetId,
        executionAttempt: input.executionAttempt,
        frozenPlanDigest: input.frozenPlanDigest,
      };
      const output: MediaGenRuntimeVendorOutput = {
        mediaRef: `runtime-local://${pending.runtimeJobId}`,
        mimeType: pending.mimeType!,
      };
      let artifact: MediaGenRuntimeArtifactRef;
      if (!claim.post) {
        if (!options.bridge.readImageArtifactHandoff)
          return observe(input, await store.read(input), true);
        const readback = await options.bridge.readImageArtifactHandoff({
          dispatch: identity,
          runtimeJobId: pending.runtimeJobId,
          output,
          sha256: pending.sha256!,
          submissionCorrelationId: pending.submissionCorrelationId!,
        });
        if (readback.state !== "committed") return observe(input, await store.read(input), true);
        artifact = readback.artifact;
      } else {
        artifact = await options.bridge.handoffArtifact({
          dispatch: identity,
          runtimeJobId: pending.runtimeJobId,
          output,
          bytes: Buffer.from(pending.bytesBase64!, "base64"),
          sha256: pending.sha256!,
        });
      }
      if (
        artifact.sha256 !== pending.sha256 ||
        artifact.mimeType !== pending.mimeType ||
        !token(artifact.artifactId)
      ) {
        throw new Error("image artifact handoff returned an invalid identity");
      }
      // Merge into the current journal, never the pre-I/O sample. A durable
      // stop wins over either a late POST ACK or a committed GET readback.
      const settled = await store.update(input, (current) =>
        current.stopRequested || current.artifact ? current : { ...current, artifact },
      );
      return observe(input, settled, true);
    } catch {
      // Provider success is durable; Artifact commit remains unproven. No new
      // provider job, fabricated Artifact or blind handoff replay is allowed.
      return observe(input, await store.read(input), true);
    }
  }
  const executor: ImageRouteExecutor = {
    registrationSnapshot: (workspaceId) =>
      collectImageRegistrationSnapshot(
        {
          env,
          runtimeId: options.runtimeId,
          route: options.route,
          getConfig: options.getConfig,
          lifecycleSource: {
            dispatcherRevision: 2,
            terminalReceiptParser: parseImageLifecycleReceipt,
            receiptStore: store,
            stopOnly: true,
          },
        },
        workspaceId,
      ),
    async dispatch(input) {
      // Keep direct native callers under the same stop-only grammar as HTTP.
      if (
        (input.stopOnly !== undefined && (input.stopOnly !== true || input.op !== "reconcile")) ||
        ((input.op === "poll" || input.op === "cancel") && !input.runtimeJobId)
      ) {
        return result(input, "failed", {
          failureReason: "vendor_rejected",
          failureMessage: "exact image observation or stop grammar is invalid",
        });
      }
      const isStop = input.op === "cancel" || input.stopOnly === true;
      let observedRecord: ImageReceipt | undefined;
      try {
        let existing = await store.read(input);
        observedRecord = existing;
        if (
          existing &&
          input.runtimeJobId !== undefined &&
          existing.runtimeJobId !== input.runtimeJobId
        ) {
          return result(input, "failed", {
            failureReason: "vendor_rejected",
            failureMessage: "exact image runtime receipt not found",
          });
        }
        if (isStop) {
          if (!existing) return stopped(input);
          existing = await store.update(input, (current) =>
            current.stopRequested ? current : { ...current, stopRequested: true },
          );
          return stopped(input, existing);
        }
        if (input.op !== "submit" && input.op !== "retry") {
          if (!existing) return unknown(input);
          if (existing.state === "succeeded" && !existing.stopRequested)
            return await handoff(input);
          return observe(input, existing);
        }
        if (existing) return observe(input, existing);
        const reservation = await store.reserve({
          schemaVersion: 1,
          runtimeId: options.runtimeId,
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          presetId: input.presetId,
          executionAttempt: input.executionAttempt,
          frozenPlanDigest: input.frozenPlanDigest,
          runtimeJobId: `image:${randomUUID()}`,
          state: "started",
          submissionCorrelationId: input.correlationId,
          observedAt: new Date().toISOString(),
          sequence: 1,
          providerOutcome: "unknown",
        });
        observedRecord = reservation.record;
        if (!reservation.created) return observe(input, reservation.record);
        const prepared = await prepareProtectedImageExecution({
          env,
          runtimeId: options.runtimeId,
          route: options.route,
          getConfig: options.getConfig,
        }).catch(() => undefined);
        if (
          !prepared ||
          !routeMatches(input.frozenImagePlan, options.route) ||
          !imagePlanMatchesProtectedBinding({
            plan: input.frozenImagePlan,
            workspaceId: input.workspaceId,
            runtimeId: options.runtimeId,
            credential: prepared.credential,
            binding: prepared.configuration.binding,
            outputSupport: prepared.configuration.outputSupport,
          })
        )
          return await noEffect(
            input,
            "exact protected image route, credential, or output binding is unavailable",
          );
        const spec = outputSpec(input.frozenImagePlan);
        if (!spec) return await noEffect(input, "Image output mapping is unavailable.");
        try {
          assertExactImageGenerationOverrides(
            spec,
            resolveImageGenerationOverrides({
              ...spec,
              provider: prepared.provider,
              model: options.route.modelId,
            }),
          );
        } catch {
          return await noEffect(
            input,
            "Frozen image output is unsupported before Provider dispatch.",
          );
        }
        const current = await prepareProtectedImageExecution({
          env,
          runtimeId: options.runtimeId,
          route: options.route,
          getConfig: options.getConfig,
        }).catch(() => undefined);
        if (
          !current ||
          current.credential.apiKey !== prepared.credential.apiKey ||
          imageCredentialBindingDigest(current.credential) !==
            imageCredentialBindingDigest(prepared.credential)
        ) {
          return await noEffect(input, "Protected image binding changed before Provider dispatch.");
        }
        // This CAS is the cancellation/create linearization point. A stop that
        // won the journal cannot dispatch. A crash after this mark stays unknown.
        const claimed = await store.update(input, (record) =>
          record.stopRequested || record.providerDispatchStarted
            ? record
            : { ...record, providerDispatchStarted: true },
        );
        observedRecord = claimed;
        if (!claimed || claimed.stopRequested || !claimed.providerDispatchStarted) {
          return await noEffect(input, "Image dispatch was stopped before Provider invocation.");
        }
        // CAS persistence yielded after auth preparation. Recheck the protected
        // slot synchronously so there is no further await before the paid call.
        const credential = readProtectedImageCredential(
          env,
          options.runtimeId,
          current.configuration,
        );
        if (
          !credential ||
          credential.apiKey !== current.credential.apiKey ||
          imageCredentialBindingDigest(credential) !==
            imageCredentialBindingDigest(current.credential) ||
          !imagePlanMatchesProtectedBinding({
            plan: input.frozenImagePlan,
            workspaceId: input.workspaceId,
            runtimeId: options.runtimeId,
            credential,
            binding: current.configuration.binding,
            outputSupport: current.configuration.outputSupport,
          })
        ) {
          return await noEffect(
            input,
            "Protected image binding changed before Provider invocation.",
          );
        }
        try {
          const generated = await (options.generateImageFn ?? generateImage)({
            cfg: current.cfg,
            authStore: current.authStore,
            prompt: (input.frozenImagePlan.generationIntent as Record<string, unknown>)
              .compiledPrompt as string,
            modelOverride: `${options.route.providerId}/${options.route.modelId}`,
            autoProviderFallback: false,
            requireExactOutput: true,
            count: 1,
            ...spec,
          });
          const image = generated.images[0];
          if (!image) throw new Error("Image generation returned no image output.");
          const completed = await store.update(input, (record) =>
            record.state !== "started"
              ? record
              : {
                  ...record,
                  state: "succeeded",
                  providerOutcome: "succeeded",
                  bytesBase64: image.buffer.toString("base64"),
                  mimeType: image.mimeType,
                  sha256: createHash("sha256").update(image.buffer).digest("hex"),
                  snapshot: {
                    executionOwner: "user_runtime",
                    moderationStatus: "not_enforced",
                    labelingStatus: "absent",
                    registrationDisclosureStatus: options.compliance.registrationDisclosureStatus,
                    capturedAt: new Date().toISOString(),
                  },
                },
          );
          // Submit never performs Artifact I/O, even when bytes are already ready.
          return observe(input, completed);
        } catch {
          // Even ExactOutputError may originate after Provider I/O. Only the
          // explicit code paths above prove no invocation; preserve this attempt.
          return observe(input, await store.read(input));
        }
      } catch {
        // Corrupt journals, lock ambiguity and durability failures cannot prove
        // no effect or authorize a replacement. Never create from these paths.
        if (isStop) return stopped(input, observedRecord);
        return observe(input, observedRecord);
      }
    },
  };
  return executor;
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
  const rawReceipt = await options.executor.dispatch(dispatch);
  const receipt = normalizeImageResult(dispatch, rawReceipt);
  if (!receipt) {
    sendJson(
      res,
      502,
      result(dispatch, "failed", {
        failureReason: "internal",
        failureMessage: "image runtime returned an invalid public receipt",
      }),
    );
    return true;
  }
  sendJson(res, 200, receipt);
  return true;
}
