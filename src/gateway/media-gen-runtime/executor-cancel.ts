import type { MediaGenRuntimeDispatch, MediaGenRuntimeResult } from "../media-gen-runtime-http.js";
import type { MediaGenRuntimeTrackedJob } from "./executor-reconcile.js";
import { canceledRuntimeResult as canceled } from "./executor-results.js";
import type { MediaGenRuntimeVendorCancelResult, MediaGenRuntimeVendorJob } from "./types.js";

type CancelInput = {
  dispatch: MediaGenRuntimeDispatch;
  tracked?: MediaGenRuntimeTrackedJob;
  forget(): void;
};

/**
 * Stop one exact provider attempt without creating, finalizing, or handing off
 * anything. Process-local tracking is deleted only after terminal confirmation.
 */
export async function cancelMediaGenRuntimeJob(input: CancelInput): Promise<MediaGenRuntimeResult> {
  const { dispatch, tracked } = input;
  const vendor = tracked?.vendor;
  const runtimeJobId = tracked?.vendorJobId;
  if (!runtimeJobId || !vendor) {
    return canceled(dispatch, "No runtime provider job required stopping.", undefined, {
      state: "not_requested",
      reasonCode: "no_runtime_dispatch",
    });
  }

  if (vendor.reconcile) {
    let reconciled: MediaGenRuntimeVendorJob;
    try {
      reconciled = await vendor.reconcile(runtimeJobId);
    } catch {
      return canceled(dispatch, "The provider stop outcome is uncertain.", runtimeJobId, {
        state: "unknown",
        reasonCode: "transport_uncertain",
      });
    }
    if (
      reconciled.state === "canceled" ||
      reconciled.state === "succeeded" ||
      (reconciled.state === "failed" && reconciled.retryDisposition === "replacement_allowed")
    ) {
      // Terminal observation proves no execution remains. This stop-only path
      // deliberately performs no Artifact handoff and creates no replacement.
      input.forget();
      return canceled(
        dispatch,
        "The provider confirmed that execution is already terminal.",
        runtimeJobId,
        { state: "confirmed", reasonCode: "runtime_confirmed" },
        reconciled.providerObservation,
      );
    }
    if (reconciled.state === "submission_unknown") {
      return canceled(
        dispatch,
        "The provider stop outcome is uncertain.",
        runtimeJobId,
        { state: "unknown", reasonCode: "transport_uncertain" },
        reconciled.providerObservation,
      );
    }
    if (reconciled.state === "failed") {
      return canceled(
        dispatch,
        "The runtime could not reconcile the provider job before stopping it.",
        runtimeJobId,
        { state: "failed", reasonCode: "adapter_rejected" },
        reconciled.providerObservation,
      );
    }
  }

  if (!vendor.cancel) {
    return canceled(
      dispatch,
      "The runtime adapter does not support provider cancellation.",
      runtimeJobId,
      { state: "not_supported", reasonCode: "adapter_not_supported" },
    );
  }
  let cancelResult: MediaGenRuntimeVendorCancelResult | void;
  try {
    cancelResult = await vendor.cancel(runtimeJobId);
  } catch {
    return canceled(dispatch, "The provider stop outcome is uncertain.", runtimeJobId, {
      state: "unknown",
      reasonCode: "transport_uncertain",
    });
  }
  const state = cancelResult?.state ?? "requested";
  if (state === "confirmed") input.forget();
  const runtimeStopOutcome =
    state === "confirmed"
      ? { state: "confirmed" as const, reasonCode: "runtime_confirmed" as const }
      : state === "failed"
        ? { state: "failed" as const, reasonCode: "adapter_rejected" as const }
        : state === "unknown"
          ? { state: "unknown" as const, reasonCode: "transport_uncertain" as const }
          : { state: "requested" as const, reasonCode: "runtime_stop_requested" as const };
  return canceled(
    dispatch,
    state === "confirmed"
      ? "The provider confirmed that the job stopped."
      : "The provider stop request is not yet confirmed.",
    runtimeJobId,
    runtimeStopOutcome,
    cancelResult?.providerObservation,
  );
}
