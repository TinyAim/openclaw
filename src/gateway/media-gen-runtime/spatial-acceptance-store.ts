import { createHash } from "node:crypto";
import { createCorePluginStateSyncKeyedStore } from "../../plugin-state/plugin-state-store.js";
import type {
  MediaGenRuntimeDispatch,
  MediaGenRuntimeSpatialInputAcceptance,
} from "../media-gen-runtime-http.js";

const OWNER_ID = "core:media-gen-runtime-spatial-acceptance" as const;
const MAX_ENTRIES = 2_048;
const ACCEPTANCE_SCHEMA_VERSION = 1 as const;
const SAFE_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_RUNTIME_JOB_ID = /^[a-zA-Z0-9._:/-]{1,512}$/u;

type SpatialAcceptanceRecord = {
  recordType: "media_gen_spatial_acceptance";
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  runtimeId: string;
  workspaceId: string;
  taskId: string;
  presetId: string;
  mode: MediaGenRuntimeDispatch["mode"];
  executionAttempt: number;
  frozenPlanDigest: string;
  acceptance: MediaGenRuntimeSpatialInputAcceptance;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function acceptanceKey(
  input: Pick<
    MediaGenRuntimeDispatch,
    "workspaceId" | "taskId" | "presetId" | "mode" | "executionAttempt" | "frozenPlanDigest"
  >,
): string | undefined {
  if (
    !input.workspaceId ||
    !input.taskId ||
    !input.presetId ||
    input.executionAttempt === undefined ||
    !Number.isSafeInteger(input.executionAttempt) ||
    input.executionAttempt <= 0 ||
    !input.frozenPlanDigest
  ) {
    return undefined;
  }
  const identity = [
    input.workspaceId,
    input.taskId,
    input.presetId,
    input.mode,
    input.executionAttempt,
    input.frozenPlanDigest,
  ];
  return `attempt:${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

function sameIdentity(record: SpatialAcceptanceRecord, input: MediaGenRuntimeDispatch): boolean {
  return (
    record.workspaceId === input.workspaceId &&
    record.taskId === input.taskId &&
    record.presetId === input.presetId &&
    record.mode === input.mode &&
    record.executionAttempt === input.executionAttempt &&
    record.frozenPlanDigest === input.frozenPlanDigest
  );
}

function assertAcceptanceMatchesDispatch(
  dispatch: MediaGenRuntimeDispatch,
  acceptance: MediaGenRuntimeSpatialInputAcceptance,
): void {
  const envelope = dispatch.spatialInputEnvelope;
  if (
    !envelope ||
    envelope.schemaVersion !== 1 ||
    acceptance.schemaVersion !== envelope.schemaVersion ||
    acceptance.envelopeDigest !== envelope.envelopeDigest ||
    canonicalJson(acceptance.references) !== canonicalJson(envelope.references) ||
    dispatch.executionAttempt !== acceptance.executionAttempt ||
    dispatch.frozenPlanDigest !== acceptance.frozenPlanDigest ||
    !SAFE_SHA256.test(acceptance.frozenPlanDigest) ||
    !SAFE_SHA256.test(acceptance.providerRequestDigest) ||
    !SAFE_RUNTIME_JOB_ID.test(acceptance.runtimeJobId) ||
    (dispatch.runtimeJobId !== undefined && dispatch.runtimeJobId !== acceptance.runtimeJobId)
  ) {
    throw new Error("media_gen_spatial_acceptance_identity_invalid");
  }
}

function validAcceptance(value: unknown): value is MediaGenRuntimeSpatialInputAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const acceptance = value as Partial<MediaGenRuntimeSpatialInputAcceptance>;
  const allowed = new Set([
    "schemaVersion",
    "envelopeDigest",
    "references",
    "executionAttempt",
    "frozenPlanDigest",
    "runtimeJobId",
    "providerRequestDigest",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    acceptance.schemaVersion !== 1 ||
    typeof acceptance.envelopeDigest !== "string" ||
    !/^spa_env:sha256:[a-f0-9]{64}$/u.test(acceptance.envelopeDigest) ||
    !Array.isArray(acceptance.references) ||
    acceptance.references.length === 0 ||
    !Number.isSafeInteger(acceptance.executionAttempt) ||
    (acceptance.executionAttempt as number) < 1 ||
    typeof acceptance.frozenPlanDigest !== "string" ||
    !SAFE_SHA256.test(acceptance.frozenPlanDigest) ||
    typeof acceptance.runtimeJobId !== "string" ||
    !SAFE_RUNTIME_JOB_ID.test(acceptance.runtimeJobId) ||
    typeof acceptance.providerRequestDigest !== "string" ||
    !SAFE_SHA256.test(acceptance.providerRequestDigest)
  ) {
    return false;
  }
  const identities = new Set<string>();
  for (const reference of acceptance.references) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) return false;
    const raw = reference as Record<string, unknown>;
    const referenceKeys = new Set(["assetRefId", "artifactId", "checksum", "role", "ordinal"]);
    if (
      Object.keys(raw).some((key) => !referenceKeys.has(key)) ||
      (raw.assetRefId !== undefined &&
        (typeof raw.assetRefId !== "string" || !raw.assetRefId.trim())) ||
      typeof raw.artifactId !== "string" ||
      !raw.artifactId.trim() ||
      typeof raw.checksum !== "string" ||
      !SAFE_SHA256.test(raw.checksum) ||
      typeof raw.role !== "string" ||
      !raw.role.trim() ||
      !Number.isSafeInteger(raw.ordinal) ||
      (raw.ordinal as number) < 0
    ) {
      return false;
    }
    const identity = `${raw.role}\u0000${raw.ordinal}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function validRecord(value: unknown): value is SpatialAcceptanceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SpatialAcceptanceRecord>;
  return (
    record.recordType === "media_gen_spatial_acceptance" &&
    record.schemaVersion === ACCEPTANCE_SCHEMA_VERSION &&
    typeof record.runtimeId === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.taskId === "string" &&
    typeof record.presetId === "string" &&
    (record.mode === "text2video" || record.mode === "image2video") &&
    Number.isSafeInteger(record.executionAttempt) &&
    (record.executionAttempt as number) > 0 &&
    typeof record.frozenPlanDigest === "string" &&
    SAFE_SHA256.test(record.frozenPlanDigest) &&
    validAcceptance(record.acceptance)
  );
}

export type MediaGenRuntimeSpatialAcceptanceStore = {
  persist(
    dispatch: MediaGenRuntimeDispatch,
    acceptance: MediaGenRuntimeSpatialInputAcceptance,
  ): void;
  resolve(dispatch: MediaGenRuntimeDispatch): MediaGenRuntimeSpatialInputAcceptance | undefined;
  resolveRuntimeJobId(dispatch: MediaGenRuntimeDispatch): string | undefined;
};

export function createMediaGenRuntimeSpatialAcceptanceStore(options: {
  env: NodeJS.ProcessEnv;
  runtimeId: string;
}): MediaGenRuntimeSpatialAcceptanceStore {
  const namespace = `media-gen-spatial-acceptance-${createHash("sha256")
    .update(options.runtimeId)
    .digest("hex")
    .slice(0, 20)}`;
  const state = createCorePluginStateSyncKeyedStore<SpatialAcceptanceRecord>({
    ownerId: OWNER_ID,
    namespace,
    maxEntries: MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env: options.env,
  });

  function lookup(dispatch: MediaGenRuntimeDispatch): SpatialAcceptanceRecord | undefined {
    const key = acceptanceKey(dispatch);
    if (!key) return undefined;
    const value = state.lookup(key);
    return validRecord(value) &&
      value.runtimeId === options.runtimeId &&
      sameIdentity(value, dispatch)
      ? value
      : undefined;
  }

  return {
    persist(dispatch, acceptance) {
      const key = acceptanceKey(dispatch);
      if (!key) throw new Error("media_gen_spatial_acceptance_identity_invalid");
      assertAcceptanceMatchesDispatch(dispatch, acceptance);
      const record: SpatialAcceptanceRecord = {
        recordType: "media_gen_spatial_acceptance",
        schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
        runtimeId: options.runtimeId,
        workspaceId: dispatch.workspaceId,
        taskId: dispatch.taskId,
        presetId: dispatch.presetId,
        mode: dispatch.mode,
        executionAttempt: dispatch.executionAttempt!,
        frozenPlanDigest: dispatch.frozenPlanDigest!,
        acceptance,
      };
      // Surface a deterministic conflict before entering the SQLite wrapper.
      // The transactional callback below repeats this check so a concurrent
      // writer still cannot replace a different receipt for this attempt.
      const current = state.lookup(key);
      if (current !== undefined) {
        if (!validRecord(current) || canonicalJson(current) !== canonicalJson(record)) {
          throw new Error("media_gen_spatial_acceptance_conflict");
        }
      }
      const updated = state.update?.(key, (current) => {
        if (!current) return record;
        if (!validRecord(current) || canonicalJson(current) !== canonicalJson(record)) {
          throw new Error("media_gen_spatial_acceptance_conflict");
        }
        return current;
      });
      if (updated !== true) throw new Error("media_gen_spatial_acceptance_persist_failed");
      const readback = state.lookup(key);
      if (!readback || canonicalJson(readback) !== canonicalJson(record)) {
        throw new Error("media_gen_spatial_acceptance_readback_failed");
      }
    },
    resolve(dispatch) {
      const record = lookup(dispatch);
      if (!record) return undefined;
      if (
        dispatch.runtimeJobId !== undefined &&
        dispatch.runtimeJobId !== record.acceptance.runtimeJobId
      ) {
        return undefined;
      }
      return record.acceptance;
    },
    resolveRuntimeJobId(dispatch) {
      return lookup(dispatch)?.acceptance.runtimeJobId;
    },
  };
}
