import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { mediaGenRuntimeFrozenPlanDigest } from "./frozen-plan.js";
import type {
  KlingAttemptIdentity,
  createKlingAttemptCorrelationStore,
} from "./kling-attempt-correlation-store.js";
import { lookupKlingExternalCorrelation } from "./kling-external-correlation-lookup.js";
import type { MediaGenRuntimeFetch } from "./types.js";

/** Return a provider ID only after matching and durably binding the original attempt. */
export function createKlingRecoveryOwner(options: {
  store: ReturnType<typeof createKlingAttemptCorrelationStore>;
  resolveIdentity(dispatch: MediaGenRuntimeDispatch): Promise<KlingAttemptIdentity>;
  baseUrl: string;
  apiKey: string;
  fetchImpl: MediaGenRuntimeFetch;
}): (dispatch: MediaGenRuntimeDispatch) => Promise<string | undefined> {
  return async (dispatch) => {
    if (
      dispatch.op !== "reconcile" ||
      dispatch.presetId !== "kling" ||
      dispatch.mode !== "image2video" ||
      !dispatch.frozenPlan ||
      !dispatch.frozenPlanDigest ||
      dispatch.executionAttempt === undefined ||
      mediaGenRuntimeFrozenPlanDigest(dispatch.frozenPlan) !== dispatch.frozenPlanDigest
    )
      return undefined;
    const identity = await options.resolveIdentity(dispatch);
    if (
      identity.workspaceId !== dispatch.workspaceId ||
      identity.taskId !== dispatch.taskId ||
      identity.runtimeId !== dispatch.frozenPlan.runtimeRef.runtimeId ||
      identity.executionAttempt !== dispatch.executionAttempt ||
      identity.frozenPlanDigest !== dispatch.frozenPlanDigest ||
      identity.routeId !== dispatch.frozenPlan.providerRouteRef.routeId
    ) {
      return undefined;
    }
    const stored = options.store.resolve(identity);
    // A reservation without a bound request proves no provider create should be assumed.
    if (!stored?.providerRequestDigest) return undefined;
    if (stored.vendorJobId) return stored.vendorJobId;
    const found = await lookupKlingExternalCorrelation({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      externalTaskId: stored.externalTaskId,
      fetchImpl: options.fetchImpl,
    });
    if (found.status !== "matched") return undefined;
    options.store.bindVendorJob(identity, stored.externalTaskId, found.vendorJobId);
    return found.vendorJobId;
  };
}
