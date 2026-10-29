import { createHash, randomUUID } from "node:crypto";
import { createCorePluginStateSyncKeyedStore } from "../../plugin-state/plugin-state-store.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;

/** Trusted, non-secret identity supplied by the runtime and control owners. */
export type KlingAttemptIdentity = {
  runtimeId: string;
  workspaceId: string;
  taskId: string;
  executionAttempt: number;
  frozenPlanDigest: string;
  accountBindingDigest: string;
  routeId: string;
};

type RecordV1 = {
  schemaVersion: 1;
  identity: KlingAttemptIdentity;
  externalTaskId: string;
  providerRequestDigest?: string;
  vendorJobId?: string;
};

function validIdentity(value: KlingAttemptIdentity): boolean {
  return (
    typeof value.runtimeId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.taskId === "string" &&
    typeof value.frozenPlanDigest === "string" &&
    typeof value.accountBindingDigest === "string" &&
    TOKEN.test(value.runtimeId) &&
    TOKEN.test(value.workspaceId) &&
    TOKEN.test(value.taskId) &&
    value.routeId === "kling-apikey-2.6-i2v-sg/v1" &&
    Number.isSafeInteger(value.executionAttempt) &&
    value.executionAttempt > 0 &&
    SHA.test(value.frozenPlanDigest) &&
    SHA.test(value.accountBindingDigest)
  );
}
function sameIdentity(a: KlingAttemptIdentity, b: KlingAttemptIdentity): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.workspaceId === b.workspaceId &&
    a.taskId === b.taskId &&
    a.executionAttempt === b.executionAttempt &&
    a.frozenPlanDigest === b.frozenPlanDigest &&
    a.accountBindingDigest === b.accountBindingDigest &&
    a.routeId === b.routeId
  );
}
function key(identity: KlingAttemptIdentity): string {
  // One attempt cannot silently acquire a second correlation when its frozen plan or account changes.
  return `attempt:${createHash("sha256")
    .update(
      JSON.stringify([
        identity.runtimeId,
        identity.workspaceId,
        identity.taskId,
        identity.executionAttempt,
      ]),
    )
    .digest("hex")}`;
}
function validRecord(value: unknown): value is RecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RecordV1>;
  if (
    record.schemaVersion !== 1 ||
    !record.identity ||
    typeof record.identity !== "object" ||
    typeof record.externalTaskId !== "string" ||
    !/^wis_[a-f0-9]{32}$/u.test(record.externalTaskId) ||
    (record.providerRequestDigest !== undefined && !SHA.test(record.providerRequestDigest)) ||
    (record.vendorJobId !== undefined &&
      (typeof record.vendorJobId !== "string" ||
        !record.vendorJobId.trim() ||
        record.vendorJobId !== record.vendorJobId.trim() ||
        record.vendorJobId.length > 512 ||
        !record.providerRequestDigest))
  )
    return false;
  const i = record.identity;
  return (
    typeof i.runtimeId === "string" &&
    typeof i.workspaceId === "string" &&
    typeof i.taskId === "string" &&
    typeof i.routeId === "string" &&
    typeof i.executionAttempt === "number" &&
    typeof i.frozenPlanDigest === "string" &&
    typeof i.accountBindingDigest === "string" &&
    validIdentity(i)
  );
}

/** Reservation is durable before POST; an existing reservation is recovery-only, never permission to resend. */
export function createKlingAttemptCorrelationStore(options: {
  env: NodeJS.ProcessEnv;
  runtimeId: string;
}) {
  if (!TOKEN.test(options.runtimeId)) throw new Error("kling_attempt_runtime_invalid");
  const state = createCorePluginStateSyncKeyedStore<RecordV1>({
    ownerId: "core:media-gen-kling-attempt",
    namespace: `kling-attempt-${createHash("sha256").update(options.runtimeId).digest("hex").slice(0, 20)}`,
    maxEntries: 2048,
    overflowPolicy: "reject-new",
    env: options.env,
  });
  const verify = (identity: KlingAttemptIdentity) => {
    if (!validIdentity(identity) || identity.runtimeId !== options.runtimeId)
      throw new Error("kling_attempt_identity_invalid");
  };
  return {
    reserve(identity: KlingAttemptIdentity): {
      kind: "created" | "existing";
      externalTaskId: string;
    } {
      verify(identity);
      const storeKey = key(identity);
      return state.transaction([storeKey], (transaction) => {
        const current = transaction.lookup(storeKey);
        if (current !== undefined) {
          if (!validRecord(current) || !sameIdentity(current.identity, identity))
            throw new Error("kling_attempt_identity_conflict");
          return { kind: "existing" as const, externalTaskId: current.externalTaskId };
        }
        const externalTaskId = `wis_${randomUUID().replaceAll("-", "")}`;
        transaction.set(storeKey, { schemaVersion: 1, identity: { ...identity }, externalTaskId });
        return { kind: "created" as const, externalTaskId };
      });
    },
    bindRequest(
      identity: KlingAttemptIdentity,
      externalTaskId: string,
      providerRequestDigest: string,
    ): void {
      verify(identity);
      if (!SHA.test(providerRequestDigest)) throw new Error("kling_attempt_request_invalid");
      const storeKey = key(identity);
      state.transaction([storeKey], (transaction) => {
        const current = transaction.lookup(storeKey);
        if (
          !validRecord(current) ||
          !sameIdentity(current.identity, identity) ||
          current.externalTaskId !== externalTaskId ||
          (current.providerRequestDigest !== undefined &&
            current.providerRequestDigest !== providerRequestDigest)
        ) {
          throw new Error("kling_attempt_request_conflict");
        }
        transaction.set(storeKey, { ...current, providerRequestDigest });
      });
    },
    bindVendorJob(
      identity: KlingAttemptIdentity,
      externalTaskId: string,
      vendorJobId: string,
    ): void {
      verify(identity);
      if (!vendorJobId.trim() || vendorJobId !== vendorJobId.trim() || vendorJobId.length > 512)
        throw new Error("kling_attempt_job_invalid");
      const storeKey = key(identity);
      state.transaction([storeKey], (transaction) => {
        const current = transaction.lookup(storeKey);
        if (
          !validRecord(current) ||
          !sameIdentity(current.identity, identity) ||
          current.externalTaskId !== externalTaskId ||
          !current.providerRequestDigest ||
          (current.vendorJobId !== undefined && current.vendorJobId !== vendorJobId)
        ) {
          throw new Error("kling_attempt_job_conflict");
        }
        transaction.set(storeKey, { ...current, vendorJobId });
      });
    },
    resolve(
      identity: KlingAttemptIdentity,
    ):
      | { externalTaskId: string; providerRequestDigest?: string; vendorJobId?: string }
      | undefined {
      verify(identity);
      const record = state.lookup(key(identity));
      if (record === undefined) return undefined;
      if (!validRecord(record) || !sameIdentity(record.identity, identity))
        throw new Error("kling_attempt_identity_conflict");
      return {
        externalTaskId: record.externalTaskId,
        ...(record.providerRequestDigest
          ? { providerRequestDigest: record.providerRequestDigest }
          : {}),
        ...(record.vendorJobId ? { vendorJobId: record.vendorJobId } : {}),
      };
    },
  };
}
