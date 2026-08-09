// Untrusted-input parsing + sanitizing for the media-generation runtime dispatch
// endpoint. Split out of `media-gen-runtime-http.ts` (LOC ceiling): the public
// dispatch/result TYPES and the HTTP handler stay there and re-use these
// fail-closed parsers. Every parser returns `null` on any malformed field so the
// caller rejects the whole dispatch — never a silently-coerced value.
import type {
  MediaGenReferenceRole,
  MediaGenReferenceSlot,
  MediaGenRuntimeDispatch,
  MediaGenRuntimeReference,
} from "./media-gen-runtime-http.js";
import { parseMediaGenRuntimeFrozenPlan } from "./media-gen-runtime/frozen-plan.js";

const OPS = new Set(["submit", "poll", "cancel", "retry", "reconcile"]);
const MODES = new Set(["text2video", "image2video"]);
const FORBIDDEN_KEY =
  /(?:api.?key|secret|credential|password|private.?key|access.?key|bearer|authorization|token|referenceimagebase64|imagebase64|base64|datauri)/i;
const DATA_URI = /^data:[^;]+;base64,/i;
const PEM = /-----BEGIN [A-Z ]+PRIVATE KEY-----/;
const LONG_BASE64 = /(?:[A-Za-z0-9+/]{512,}={0,2})/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

// CP3 multi-asset reference role allow-list (Multi_Asset_Reference_Design_CP3.md
// §3.1) — LOCAL copy of the contracts list (this gateway is a vendored upstream
// and does not depend on @wisclaw/contracts). An unknown wire role is rejected.
const REFERENCE_ROLES = new Set<MediaGenReferenceRole>([
  "subject",
  "style",
  "first_frame",
  "last_frame",
  "video",
  "source_video",
  "motion",
  "voice",
  "pose_face",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseReferenceBody(value: unknown): MediaGenRuntimeReference | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  if (kind === "artifact") {
    const artifactId = asNonEmptyString(value.artifactId);
    if (
      !artifactId ||
      value.runtimeLocalRef !== undefined ||
      value.companionArtifactId !== undefined
    ) {
      return null;
    }
    return {
      kind,
      artifactId,
      sha256: asNonEmptyString(value.sha256) ?? undefined,
      mimeType: asNonEmptyString(value.mimeType) ?? undefined,
    };
  }
  if (kind === "runtime_local") {
    const runtimeLocalRef = asNonEmptyString(value.runtimeLocalRef);
    const companionArtifactId =
      value.companionArtifactId === undefined
        ? undefined
        : asNonEmptyString(value.companionArtifactId);
    if (!runtimeLocalRef || value.artifactId !== undefined) {
      return null;
    }
    if (value.companionArtifactId !== undefined && !companionArtifactId) {
      return null;
    }
    return {
      kind,
      runtimeLocalRef,
      ...(companionArtifactId ? { companionArtifactId } : {}),
      sha256: asNonEmptyString(value.sha256) ?? undefined,
      mimeType: asNonEmptyString(value.mimeType) ?? undefined,
    };
  }
  return null;
}

function parseReference(value: unknown): MediaGenRuntimeReference | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseReferenceBody(value);
}

// CP3 multi-slot reference parser (Multi_Asset_Reference_Design_CP3.md §3.3). Each
// slot reuses the by-reference body parser, then layers a validated role (default
// `subject`), a non-negative ordinal, and an optional per-slot consent. Any malformed
// field rejects the whole slot (fail-closed); the caller rejects the whole dispatch.
function parseReferenceSlot(value: unknown): MediaGenReferenceSlot | null {
  if (!isRecord(value)) {
    return null;
  }
  const body = parseReferenceBody(value);
  if (!body) {
    return null;
  }
  let role: MediaGenReferenceRole = "subject";
  if (value.role !== undefined) {
    if (
      typeof value.role !== "string" ||
      !REFERENCE_ROLES.has(value.role as MediaGenReferenceRole)
    ) {
      return null;
    }
    role = value.role as MediaGenReferenceRole;
  }
  let ordinal: number | undefined;
  if (value.ordinal !== undefined) {
    if (
      typeof value.ordinal !== "number" ||
      !Number.isInteger(value.ordinal) ||
      value.ordinal < 0
    ) {
      return null;
    }
    ordinal = value.ordinal;
  }
  const consent = parseConsent(value.consent);
  if (consent === null) {
    return null;
  }
  return {
    ...body,
    role,
    ...(ordinal !== undefined && { ordinal }),
    ...(consent !== undefined && { consent }),
  };
}

function parseReferences(value: unknown): MediaGenReferenceSlot[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const slots: MediaGenReferenceSlot[] = [];
  for (const item of value) {
    const slot = parseReferenceSlot(item);
    if (!slot) {
      return null;
    }
    slots.push(slot);
  }
  return slots;
}

function parseConsent(value: unknown): MediaGenRuntimeDispatch["consent"] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const subjectType = value.subjectType;
  if (
    subjectType !== "portrait" &&
    subjectType !== "voice" &&
    subjectType !== "pose_face" &&
    subjectType !== "other"
  ) {
    return null;
  }
  if (typeof value.authorized !== "boolean") {
    return null;
  }
  const retentionDays = value.retentionDays;
  if (retentionDays !== undefined && typeof retentionDays !== "number" && retentionDays !== null) {
    return null;
  }
  if (
    typeof retentionDays === "number" &&
    (!Number.isFinite(retentionDays) || retentionDays < 0 || retentionDays > 365)
  ) {
    return null;
  }
  return {
    subjectType,
    authorized: value.authorized,
    retentionDays: typeof retentionDays === "number" ? retentionDays : undefined,
    note: asNonEmptyString(value.note) ?? undefined,
  };
}

export function parseDispatch(value: unknown): MediaGenRuntimeDispatch | null {
  if (!isRecord(value)) {
    return null;
  }
  const op = asNonEmptyString(value.op);
  const mode = asNonEmptyString(value.mode);
  const reference = parseReference(value.reference);
  const references = parseReferences(value.references);
  const consent = parseConsent(value.consent);
  if (
    !op ||
    !OPS.has(op) ||
    !mode ||
    !MODES.has(mode) ||
    reference === null ||
    references === null ||
    consent === null
  ) {
    return null;
  }
  // CP3 §3.3 fail-closed mutual exclusion: a dispatch carries EITHER a singular
  // `reference` OR a multi-slot `references[]`, never both.
  if (reference && references) {
    return null;
  }
  const taskId = asNonEmptyString(value.taskId);
  const workspaceId = asNonEmptyString(value.workspaceId);
  const correlationId = asNonEmptyString(value.correlationId);
  const presetId = asNonEmptyString(value.presetId);
  if (!taskId || !workspaceId || !correlationId || !presetId) {
    return null;
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    return null;
  }
  const durationSec = value.durationSec;
  if (durationSec !== undefined && typeof durationSec !== "number" && durationSec !== null) {
    return null;
  }
  if (typeof durationSec === "number" && (!Number.isFinite(durationSec) || durationSec <= 0)) {
    return null;
  }
  const consentRef =
    value.consentRef === undefined ? undefined : (asNonEmptyString(value.consentRef) ?? undefined);
  if (value.consentRef !== undefined && !consentRef) {
    return null;
  }
  // CP3 per-slot consent receipts — an array of non-empty strings. A present-but-
  // malformed set (non-array / non-string / empty element) rejects the WHOLE
  // dispatch (mirrors the contract parser), so the control plane cannot smuggle a
  // half-shaped consent set past the gateway.
  let consentRefs: string[] | undefined;
  if (value.consentRefs !== undefined) {
    if (!Array.isArray(value.consentRefs)) {
      return null;
    }
    const refs: string[] = [];
    for (const ref of value.consentRefs) {
      const parsed = asNonEmptyString(ref);
      if (!parsed) {
        return null;
      }
      refs.push(parsed);
    }
    if (refs.length > 0) {
      consentRefs = refs;
    }
  }
  const frozenPlan =
    value.frozenPlan === undefined ? undefined : parseMediaGenRuntimeFrozenPlan(value.frozenPlan);
  if (
    (value.frozenPlan !== undefined && !frozenPlan) ||
    (value.frozenPlan !== undefined && op !== "submit" && op !== "retry" && op !== "reconcile")
  ) {
    return null;
  }
  const runtimeJobId = asNonEmptyString(value.runtimeJobId) ?? undefined;
  // Control-plane poll/cancel intents must bind one exact persisted job. A
  // reconcile may omit it only so the executor can look up the same task's
  // already-tracked receipt; absence never falls through to a create.
  if ((op === "poll" || op === "cancel") && !runtimeJobId) {
    return null;
  }
  const hasExecutionAttempt = value.executionAttempt !== undefined;
  const hasFrozenPlanDigest = value.frozenPlanDigest !== undefined;
  if (hasExecutionAttempt !== hasFrozenPlanDigest) {
    return null;
  }
  let executionAttempt: number | undefined;
  let frozenPlanDigest: string | undefined;
  if (hasExecutionAttempt) {
    if (
      op !== "reconcile" ||
      typeof value.executionAttempt !== "number" ||
      !Number.isSafeInteger(value.executionAttempt) ||
      value.executionAttempt <= 0 ||
      typeof value.frozenPlanDigest !== "string" ||
      !SHA256_DIGEST.test(value.frozenPlanDigest)
    ) {
      return null;
    }
    executionAttempt = value.executionAttempt;
    frozenPlanDigest = value.frozenPlanDigest;
  }
  return {
    op: op as MediaGenRuntimeDispatch["op"],
    taskId,
    workspaceId,
    correlationId,
    presetId,
    mode: mode as MediaGenRuntimeDispatch["mode"],
    prompt: asNonEmptyString(value.prompt) ?? undefined,
    reference,
    ...(references && { references }),
    durationSec: typeof durationSec === "number" ? durationSec : undefined,
    resolution: asNonEmptyString(value.resolution) ?? undefined,
    params: isRecord(value.params) ? value.params : undefined,
    consent,
    consentRef,
    ...(consentRefs && { consentRefs }),
    runtimeJobId,
    ...(executionAttempt !== undefined && frozenPlanDigest
      ? { executionAttempt, frozenPlanDigest }
      : {}),
    ...(frozenPlan && { frozenPlan }),
  };
}

export function rejectSmuggledSensitiveMaterial(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const rejected = rejectSmuggledSensitiveMaterial(value[i], `${path}[${i}]`);
      if (rejected) return rejected;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_KEY.test(key)) {
        return childPath;
      }
      const rejected = rejectSmuggledSensitiveMaterial(child, childPath);
      if (rejected) return rejected;
    }
    return null;
  }
  if (typeof value === "string") {
    if (DATA_URI.test(value) || PEM.test(value) || LONG_BASE64.test(value)) {
      return path;
    }
  }
  return null;
}
