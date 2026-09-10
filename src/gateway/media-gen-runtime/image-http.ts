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

export type MediaGenRuntimeImageCompliance = {
  enforcesModeration: boolean;
  appliesLabeling: boolean;
  registrationDisclosureStatus: "undeclared" | "operator_self_declared";
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
  snapshot?: {
    executionOwner: "user_runtime";
    moderationStatus: "not_enforced" | "runtime_enforced";
    labelingStatus: "absent" | "runtime_applied";
    registrationDisclosureStatus: "undeclared" | "operator_self_declared";
    capturedAt: string;
  };
  failureMessage?: string;
};

function parseImageReceipt(raw: unknown): ImageReceipt | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = new Set([
    "schemaVersion",
    "runtimeId",
    "taskId",
    "workspaceId",
    "presetId",
    "executionAttempt",
    "frozenPlanDigest",
    "runtimeJobId",
    "state",
    "bytesBase64",
    "mimeType",
    "sha256",
    "artifact",
    "snapshot",
    "failureMessage",
  ]);
  if (Object.keys(raw).some((key) => !keys.has(key))) return undefined;
  if (
    raw.schemaVersion !== 1 ||
    token(raw.runtimeId) === undefined ||
    token(raw.taskId) === undefined ||
    token(raw.workspaceId) === undefined ||
    token(raw.presetId) === undefined ||
    !Number.isSafeInteger(raw.executionAttempt) ||
    raw.executionAttempt < 1 ||
    !SHA256.test(String(raw.frozenPlanDigest)) ||
    token(raw.runtimeJobId) === undefined ||
    !["started", "succeeded", "failed", "canceled"].includes(String(raw.state))
  )
    return undefined;
  if (
    raw.bytesBase64 !== undefined &&
    (typeof raw.bytesBase64 !== "string" ||
      raw.bytesBase64.length === 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(raw.bytesBase64))
  )
    return undefined;
  if (
    raw.mimeType !== undefined &&
    (typeof raw.mimeType !== "string" || !/^image\/(?:png|jpeg|webp)$/u.test(raw.mimeType))
  )
    return undefined;
  if (
    raw.sha256 !== undefined &&
    (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256))
  )
    return undefined;
  if (raw.artifact !== undefined) {
    if (!isRecord(raw.artifact)) return undefined;
    const artifactKeys = new Set(["artifactId", "sha256", "durationSec", "resolution", "mimeType"]);
    if (
      Object.keys(raw.artifact).some((key) => !artifactKeys.has(key)) ||
      token(raw.artifact.artifactId) === undefined ||
      typeof raw.artifact.mimeType !== "string" ||
      !/^image\/(?:png|jpeg|webp)$/u.test(raw.artifact.mimeType) ||
      typeof raw.artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.artifact.sha256) ||
      raw.artifact.sha256 !== raw.sha256
    )
      return undefined;
  }
  if (raw.snapshot !== undefined) {
    if (
      !isRecord(raw.snapshot) ||
      Object.keys(raw.snapshot).some(
        (key) =>
          !new Set([
            "executionOwner",
            "moderationStatus",
            "labelingStatus",
            "registrationDisclosureStatus",
            "capturedAt",
          ]).has(key),
      ) ||
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
  }
  if (
    raw.state === "succeeded" &&
    (typeof raw.bytesBase64 !== "string" ||
      typeof raw.mimeType !== "string" ||
      typeof raw.sha256 !== "string" ||
      !raw.snapshot ||
      createHash("sha256").update(Buffer.from(raw.bytesBase64, "base64")).digest("hex") !==
        raw.sha256)
  )
    return undefined;
  if (
    raw.failureMessage !== undefined &&
    (typeof raw.failureMessage !== "string" ||
      raw.failureMessage.length === 0 ||
      raw.failureMessage.length > 2000)
  )
    return undefined;
  return raw as unknown as ImageReceipt;
}

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
    !plan.constraintPlan.every((raw) => isRecord(raw) && typeof raw.intentPath === "string") ||
    !requiredMappingPaths.every((path) =>
      plan.constraintPlan.some(
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
      raw.status !== "canceled"
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
      const parsed = parseImageReceipt(JSON.parse(await fs.readFile(fileFor(input), "utf8")));
      return parsed &&
        parsed.runtimeId === options.runtimeId &&
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
        try {
          await handle.writeFile(JSON.stringify(record));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    }
    try {
      const handle = await fs.open(temp, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, target);
      const dirHandle = await fs.open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
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
  compliance: MediaGenRuntimeImageCompliance;
  /** Test seam; production always uses the OpenClaw image provider runtime. */
  generateImageFn?: typeof generateImage;
}): ImageRouteExecutor {
  const store = createReceiptStore({
    env: options.env ?? process.env,
    runtimeId: options.runtimeId,
  });
  const complianceSnapshot = () => ({
    executionOwner: "user_runtime" as const,
    moderationStatus: options.compliance.enforcesModeration
      ? ("runtime_enforced" as const)
      : ("not_enforced" as const),
    labelingStatus: options.compliance.appliesLabeling
      ? ("runtime_applied" as const)
      : ("absent" as const),
    registrationDisclosureStatus: options.compliance.registrationDisclosureStatus,
    capturedAt: new Date().toISOString(),
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
      executionAttempt: input.executionAttempt,
      frozenPlanDigest: input.frozenPlanDigest,
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
    if (
      artifact.sha256 !== record.sha256 ||
      artifact.mimeType !== record.mimeType ||
      !token(artifact.artifactId)
    ) {
      throw new Error("image artifact handoff returned an invalid identity");
    }
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
          const generated = await (options.generateImageFn ?? generateImage)({
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
            snapshot: complianceSnapshot(),
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
      if (!existing || (input.op !== "reconcile" && existing.runtimeJobId !== input.runtimeJobId))
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
            snapshot: existing.snapshot,
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
          snapshot: existing.snapshot,
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
