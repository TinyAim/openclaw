import { mediaGenRuntimeFrozenPlanDigest } from "./frozen-plan.js";
import type { KlingApiKeyPreparedSubmission } from "./kling-apikey-i2v-compiler.js";
import type { KlingSubmissionReservation } from "./kling-apikey-i2v-vendor.js";
import type {
  KlingAttemptIdentity,
  createKlingAttemptCorrelationStore,
} from "./kling-attempt-correlation-store.js";
import type { MediaGenRuntimeVendorInput } from "./types.js";

type CorrelationStore = ReturnType<typeof createKlingAttemptCorrelationStore>;

/**
 * The caller supplies the actual authorized preparation owner and account binding.
 * Reservations survive restart; existing attempts never run preparation or a second POST.
 */
export function createKlingSubmissionOwner(options: {
  store: CorrelationStore;
  resolveIdentity(input: MediaGenRuntimeVendorInput): Promise<KlingAttemptIdentity>;
  prepareFrames(
    input: MediaGenRuntimeVendorInput,
    identity: KlingAttemptIdentity,
  ): Promise<KlingApiKeyPreparedSubmission["frames"]>;
}): (input: MediaGenRuntimeVendorInput) => Promise<KlingSubmissionReservation> {
  return async (input) => {
    const identity = await options.resolveIdentity(input);
    if (
      !input.workspaceId ||
      !input.frozenPlan ||
      input.executionAttempt === undefined ||
      !input.frozenPlanDigest ||
      identity.workspaceId !== input.workspaceId ||
      identity.taskId !== input.taskId ||
      identity.runtimeId !== input.frozenPlan.runtimeRef.runtimeId ||
      identity.executionAttempt !== input.executionAttempt ||
      identity.frozenPlanDigest !== input.frozenPlanDigest ||
      mediaGenRuntimeFrozenPlanDigest(input.frozenPlan) !== input.frozenPlanDigest ||
      identity.routeId !== input.frozenPlan.providerRouteRef.routeId
    ) {
      throw new Error("Kling preparation identity does not match the frozen dispatch.");
    }
    const reservation = options.store.reserve(identity);
    if (reservation.kind === "existing") {
      const stored = options.store.resolve(identity);
      return {
        kind: "existing",
        ...(stored?.vendorJobId ? { vendorJobId: stored.vendorJobId } : {}),
        ...(stored?.providerRequestDigest
          ? { providerRequestDigest: stored.providerRequestDigest }
          : {}),
      };
    }
    const frames = await options.prepareFrames(input, identity);
    return {
      kind: "created",
      prepared: { externalTaskId: reservation.externalTaskId, frames },
      bindRequest: (requestDigest) =>
        options.store.bindRequest(identity, reservation.externalTaskId, requestDigest),
      bindVendorJob: (vendorJobId) =>
        options.store.bindVendorJob(identity, reservation.externalTaskId, vendorJobId),
    };
  };
}
