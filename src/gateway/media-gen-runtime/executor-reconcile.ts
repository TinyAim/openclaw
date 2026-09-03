import type { MediaGenRuntimeDispatch, MediaGenRuntimeResult } from "../media-gen-runtime-http.js";
import type { createMediaGenRuntimeFinalizer } from "./executor-finalize.js";
import {
  canceledRuntimeResult as canceled,
  failedRuntimeResult as failed,
} from "./executor-results.js";
import type { MediaGenRuntimeVendor, MediaGenRuntimeVendorJob } from "./types.js";

export type MediaGenRuntimeTrackedJob = {
  vendor: MediaGenRuntimeVendor;
  vendorJobId: string;
  consentRef?: string;
  consentRefs?: string[];
  providerRequestDigest?: string;
};

type ReconcileInput = {
  dispatch: MediaGenRuntimeDispatch;
  tracked?: MediaGenRuntimeTrackedJob;
  fallbackVendor?: MediaGenRuntimeVendor;
  finalize: ReturnType<typeof createMediaGenRuntimeFinalizer>;
  remember(job: MediaGenRuntimeTrackedJob): void;
  forget(): void;
};

function submissionUnknown(
  dispatch: MediaGenRuntimeDispatch,
  message: string,
  runtimeJobId?: string,
  providerRequestDigest?: string,
): MediaGenRuntimeResult {
  return {
    taskId: dispatch.taskId,
    workspaceId: dispatch.workspaceId,
    correlationId: dispatch.correlationId,
    status: "submission_unknown",
    failureReason: "internal",
    failureMessage: message,
    ...(runtimeJobId ? { runtimeJobId } : {}),
    ...(providerRequestDigest ? { providerRequestDigest } : {}),
  };
}

/**
 * Reconcile one already-created provider attempt. This path is intentionally
 * create-free: absent or mismatched durable evidence fails closed and never
 * falls through to vendor.submit.
 */
export async function reconcileMediaGenRuntimeJob(
  input: ReconcileInput,
): Promise<MediaGenRuntimeResult> {
  const { dispatch, tracked } = input;
  if (
    tracked &&
    ((dispatch.runtimeJobId && dispatch.runtimeJobId !== tracked.vendorJobId) ||
      tracked.vendor.presetId !== dispatch.presetId)
  ) {
    return failed(
      dispatch,
      "internal",
      "The runtime job binding did not match the requested task.",
    );
  }

  const runtimeJobId = dispatch.runtimeJobId ?? tracked?.vendorJobId;
  if (!runtimeJobId) {
    return submissionUnknown(
      dispatch,
      "The runtime has no durable provider receipt to reconcile; create resend is prohibited.",
    );
  }
  const vendor = tracked?.vendor ?? input.fallbackVendor;
  if (!vendor) {
    return failed(dispatch, "vendor_rejected", `unsupported preset ${dispatch.presetId}`);
  }

  let job: MediaGenRuntimeVendorJob;
  try {
    job = vendor.reconcile ? await vendor.reconcile(runtimeJobId) : await vendor.poll(runtimeJobId);
  } catch {
    return submissionUnknown(
      dispatch,
      "The existing provider attempt could not be reconciled.",
      runtimeJobId,
      tracked?.providerRequestDigest,
    );
  }
  const providerRequestDigest = job.providerRequestDigest ?? tracked?.providerRequestDigest;
  input.remember({
    vendor,
    vendorJobId: runtimeJobId,
    ...(dispatch.consentRef || tracked?.consentRef
      ? { consentRef: dispatch.consentRef ?? tracked?.consentRef }
      : {}),
    ...(dispatch.consentRefs || tracked?.consentRefs
      ? { consentRefs: dispatch.consentRefs ?? tracked?.consentRefs }
      : {}),
    ...(providerRequestDigest ? { providerRequestDigest } : {}),
  });

  if (job.state === "processing") {
    return {
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: dispatch.correlationId,
      status: "processing",
      runtimeJobId,
      ...(providerRequestDigest ? { providerRequestDigest } : {}),
      ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
    };
  }
  if (job.state === "succeeded") {
    return input.finalize(
      dispatch,
      job,
      false,
      dispatch.consentRef ?? tracked?.consentRef,
      dispatch.consentRefs ?? tracked?.consentRefs,
      providerRequestDigest,
    );
  }
  if (job.state === "canceled") {
    input.forget();
    return canceled(
      dispatch,
      "The provider job was canceled.",
      runtimeJobId,
      { state: "confirmed", reasonCode: "runtime_confirmed" },
      job.providerObservation,
    );
  }
  if (job.state === "submission_unknown") {
    return {
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: dispatch.correlationId,
      status: "submission_unknown",
      runtimeJobId,
      failureReason: "internal",
      failureMessage: job.message,
      providerRequestDigest: job.providerRequestDigest,
      ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
    };
  }
  if (job.retryDisposition === "replacement_allowed") {
    input.forget();
  }
  return {
    ...failed(
      dispatch,
      job.reason,
      job.message,
      undefined,
      providerRequestDigest,
      job.providerObservation,
    ),
    runtimeJobId,
  };
}
