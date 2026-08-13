import type { MediaGenRuntimeDispatch, MediaGenRuntimeResult } from "../media-gen-runtime-http.js";
import { downloadMedia } from "./executor-media-download.js";
import {
  finishProviderObservation,
  type MediaGenProviderQualityOutcome,
  type MediaGenProviderRuntimeObservation,
} from "./provider-observation.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeFetch,
  MediaGenRuntimeLabeler,
  MediaGenRuntimeModeration,
  MediaGenRuntimeVendorJob,
} from "./types.js";

type FinalizeOptions = {
  bridge: MediaGenRuntimeBridge;
  moderation?: MediaGenRuntimeModeration;
  labeler?: MediaGenRuntimeLabeler;
  fetchImpl: MediaGenRuntimeFetch;
  mediaFetchTimeoutMs: number;
  maxMediaBytes: number;
  allowedMediaHosts: string[];
  allowInsecureMediaFetch: boolean;
  now: () => Date;
  validateMediaBytes?: (input: {
    bytes: Buffer;
    mimeType: string;
  }) => Promise<{ ok: true; verified?: boolean } | { ok: false; code: string; message: string }>;
};

function failed(
  dispatch: MediaGenRuntimeDispatch,
  reason: NonNullable<MediaGenRuntimeResult["failureReason"]>,
  message: string,
  providerRequestDigest?: string,
  providerObservation?: MediaGenProviderRuntimeObservation,
  qualityOutcome: MediaGenProviderQualityOutcome = "not_run",
): MediaGenRuntimeResult {
  const finishedObservation = finishProviderObservation(
    providerObservation,
    "failed",
    qualityOutcome,
  );
  return {
    taskId: dispatch.taskId,
    workspaceId: dispatch.workspaceId,
    correlationId: dispatch.correlationId,
    status: "failed",
    failureReason: reason,
    failureMessage: message,
    ...(providerRequestDigest ? { providerRequestDigest } : {}),
    ...(finishedObservation ? { providerObservation: finishedObservation } : {}),
  };
}

function complianceSnapshot(
  dispatch: MediaGenRuntimeDispatch,
  options: FinalizeOptions,
  input: {
    moderationApplied: boolean;
    labelingApplied: boolean;
    consentRef?: string;
    consentRefs?: string[];
  },
): NonNullable<MediaGenRuntimeResult["snapshot"]> {
  return {
    executionOwner: "user_runtime",
    moderationStatus: input.moderationApplied ? "runtime_enforced" : "not_enforced",
    labelingStatus: input.labelingApplied ? "runtime_applied" : "absent",
    registrationDisclosureStatus: "operator_self_declared",
    capturedAt: options.now().toISOString(),
    ...(input.consentRef && { consentRef: input.consentRef }),
    ...(input.consentRefs?.length ? { consentRefs: input.consentRefs } : {}),
    auditRef: `openclaw-runtime:${options.bridge.runtimeId}:${dispatch.taskId}`,
  };
}

export function createMediaGenRuntimeFinalizer(options: FinalizeOptions) {
  return async function finalize(
    dispatch: MediaGenRuntimeDispatch,
    job: Extract<MediaGenRuntimeVendorJob, { state: "succeeded" }>,
    moderationApplied: boolean,
    consentRef?: string,
    consentRefs?: string[],
    trackedProviderRequestDigest?: string,
  ): Promise<MediaGenRuntimeResult> {
    const providerRequestDigest = job.providerRequestDigest ?? trackedProviderRequestDigest;
    let qualityOutcome: MediaGenProviderQualityOutcome = "not_run";
    if (options.moderation) {
      const verdict = await options.moderation.screenOutput({
        mediaRef: job.output.mediaRef,
        mimeType: job.output.mimeType,
      });
      if (!verdict.allowed) {
        return failed(
          dispatch,
          "content_blocked",
          "Runtime output moderation rejected the result.",
          providerRequestDigest,
          job.providerObservation,
        );
      }
      moderationApplied = true;
    }

    let output = job.output;
    let labelingApplied = false;
    if (options.labeler) {
      const labeled = await options.labeler.applyLabel(output);
      if (!labeled.applied) {
        return failed(
          dispatch,
          "internal",
          "Runtime labeling was not confirmed.",
          providerRequestDigest,
          job.providerObservation,
        );
      }
      labelingApplied = true;
      output = labeled;
    }

    let downloaded: { bytes: Buffer; sha256: string; mimeType: string };
    try {
      downloaded = await downloadMedia(output, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.mediaFetchTimeoutMs,
        maxBytes: options.maxMediaBytes,
        allowedHosts: options.allowedMediaHosts,
        allowInsecure: options.allowInsecureMediaFetch,
      });
    } catch {
      return failed(
        dispatch,
        "download_failed",
        "The runtime could not retrieve the generated media.",
        providerRequestDigest,
        job.providerObservation,
      );
    }

    if (options.validateMediaBytes) {
      try {
        const quality = await options.validateMediaBytes({
          bytes: downloaded.bytes,
          mimeType: downloaded.mimeType,
        });
        if (!quality.ok) {
          qualityOutcome = "failed";
          if (quality.code === "canceled" || quality.code === "cancelled") {
            const providerObservation = finishProviderObservation(
              job.providerObservation,
              "canceled",
              qualityOutcome,
            );
            return {
              taskId: dispatch.taskId,
              workspaceId: dispatch.workspaceId,
              correlationId: dispatch.correlationId,
              status: "canceled",
              failureMessage: quality.message,
              ...(providerRequestDigest ? { providerRequestDigest } : {}),
              ...(providerObservation ? { providerObservation } : {}),
            };
          }
          const infrastructure = ["tool_missing", "probe_failed", "timeout"].includes(quality.code);
          return failed(
            dispatch,
            infrastructure ? "internal" : "vendor_rejected",
            quality.message,
            providerRequestDigest,
            job.providerObservation,
            qualityOutcome,
          );
        }
        qualityOutcome = quality.verified === false ? "not_run" : "passed";
      } catch {
        return failed(
          dispatch,
          "internal",
          "Media quality validation failed.",
          providerRequestDigest,
          job.providerObservation,
          "failed",
        );
      }
    }

    let artifact;
    try {
      // Serving authorization is runtime-private and must never cross the
      // Artifact/Control API boundary with otherwise stable output metadata.
      const {
        contentHeaders: _contentHeaders,
        allowInsecureLoopback: _allowInsecureLoopback,
        ...handoffOutput
      } = output;
      artifact = await options.bridge.handoffArtifact({
        dispatch,
        runtimeJobId: job.vendorJobId,
        output: { ...handoffOutput, mimeType: downloaded.mimeType },
        bytes: downloaded.bytes,
        sha256: downloaded.sha256,
      });
    } catch {
      return failed(
        dispatch,
        "download_failed",
        "The generated media could not be handed off to Artifact Center.",
        providerRequestDigest,
        job.providerObservation,
        qualityOutcome,
      );
    }
    const providerObservation = finishProviderObservation(
      job.providerObservation,
      "succeeded",
      qualityOutcome,
    );
    return {
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: dispatch.correlationId,
      status: "succeeded",
      runtimeJobId: job.vendorJobId,
      ...(providerRequestDigest ? { providerRequestDigest } : {}),
      ...(providerObservation ? { providerObservation } : {}),
      artifact,
      snapshot: complianceSnapshot(dispatch, options, {
        moderationApplied,
        labelingApplied,
        consentRef,
        consentRefs,
      }),
    };
  };
}
