import type {
  MediaGenReferenceRole,
  MediaGenRuntimeDispatch,
  MediaGenRuntimeHttpExecutor,
  MediaGenRuntimeResult,
} from "../media-gen-runtime-http.js";
import { cancelMediaGenRuntimeJob } from "./executor-cancel.js";
import { createMediaGenRuntimeFinalizer } from "./executor-finalize.js";
import {
  reconcileMediaGenRuntimeJob,
  type MediaGenRuntimeTrackedJob,
} from "./executor-reconcile.js";
import {
  canceledRuntimeResult as canceled,
  failedRuntimeResult as failed,
} from "./executor-results.js";
import {
  resolveMediaGenRuntimeSources,
  type MediaGenRuntimeLocalReferenceResolver,
} from "./executor-source-resolution.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeFetch,
  MediaGenRuntimeLabeler,
  MediaGenRuntimeModeration,
  MediaGenRuntimeVendor,
} from "./types.js";

// CP3 §4.2.1 — a role whose subject is inherently sensitive (pose/face) needs its
// OWN authorized consent per slot. Mirrors the contracts allow-list
// (`mediaGenReferenceRoleRequiresConsent`); kept local since this gateway does not
// depend on @wisclaw/contracts.
function roleRequiresConsent(role: MediaGenReferenceRole): boolean {
  return role === "pose_face";
}

export type MediaGenRuntimeExecutorOptions = {
  bridge: MediaGenRuntimeBridge;
  vendors: MediaGenRuntimeVendor[];
  moderation?: MediaGenRuntimeModeration;
  labeler?: MediaGenRuntimeLabeler;
  fetchImpl?: MediaGenRuntimeFetch;
  mediaFetchTimeoutMs?: number;
  maxMediaBytes?: number;
  allowedMediaHosts?: string[];
  allowInsecureMediaFetch?: boolean;
  now?: () => Date;
  /** Resolve an opaque runtime-local handle without exposing its URL/bytes to Control API. */
  resolveRuntimeLocalReference?: MediaGenRuntimeLocalReferenceResolver;
  /**
   * Owner-only recovery seam for a create whose provider receipt was lost.
   * The resolver must match the exact workspace/task/preset/mode plus durable
   * executionAttempt/frozenPlanDigest and returns an opaque Adapter receipt.
   * It is consulted only by `reconcile` and can never fall through to submit.
   */
  resolveReconcileJobReceipt?: (dispatch: MediaGenRuntimeDispatch) => string | undefined;
  /**
   * Optional quality gate after download, before Artifact handoff.
   * Factory wires this from OPENCLAW_MEDIA_GEN_QUALITY_GATE; unit tests omit it.
   *
   * Cancellation uses code `"canceled"` (top-level status), never a
   * `failureReason` token — see MediaGenRuntimeResult contract.
   */
  validateMediaBytes?: (input: {
    bytes: Buffer;
    mimeType: string;
  }) => Promise<{ ok: true; verified?: boolean } | { ok: false; code: string; message: string }>;
};

const DEFAULT_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

export function createOpenClawMediaGenRuntimeExecutor(
  options: MediaGenRuntimeExecutorOptions,
): MediaGenRuntimeHttpExecutor {
  const vendorsByPreset = new Map<string, MediaGenRuntimeVendor[]>();
  for (const vendor of options.vendors) {
    const group = vendorsByPreset.get(vendor.presetId) ?? [];
    group.push(vendor);
    vendorsByPreset.set(vendor.presetId, group);
  }
  // A preset is a product family, not an execution identity. Once cloud and
  // private H3 coexist, selecting by preset alone can silently send local media
  // to the wrong topology. Frozen route + adapter are the exact dispatch key.
  const vendorFor = (dispatch: MediaGenRuntimeDispatch): MediaGenRuntimeVendor | undefined => {
    const candidates = vendorsByPreset.get(dispatch.presetId) ?? [];
    if (!dispatch.frozenPlan) return candidates.length === 1 ? candidates[0] : undefined;
    const matches = candidates.filter((candidate) =>
      candidate.capabilityRouteClaims?.some(
        (claim) =>
          claim.presetId === dispatch.presetId &&
          claim.mode === dispatch.mode &&
          claim.route.routeId === dispatch.frozenPlan!.providerRouteRef.routeId &&
          claim.adapterRevision === dispatch.frozenPlan!.adapterRevision,
      ),
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const jobs = new Map<string, MediaGenRuntimeTrackedJob>();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const mediaFetchTimeoutMs = options.mediaFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const allowedMediaHosts = options.allowedMediaHosts ?? [];
  const finalize = createMediaGenRuntimeFinalizer({
    bridge: options.bridge,
    moderation: options.moderation,
    labeler: options.labeler,
    fetchImpl,
    mediaFetchTimeoutMs,
    maxMediaBytes,
    allowedMediaHosts,
    allowInsecureMediaFetch: options.allowInsecureMediaFetch === true,
    now,
    validateMediaBytes: options.validateMediaBytes,
  });

  async function submit(dispatch: MediaGenRuntimeDispatch): Promise<MediaGenRuntimeResult> {
    const vendor = vendorFor(dispatch);
    if (!vendor)
      return failed(dispatch, "vendor_rejected", `unsupported preset ${dispatch.presetId}`);
    if (!vendor.isConfigured())
      return failed(dispatch, "auth", `vendor ${dispatch.presetId} is not configured`);
    if (vendor.requiresFrozenPlan && !dispatch.frozenPlan) {
      return failed(
        dispatch,
        "vendor_rejected",
        "the selected runtime adapter requires a frozen plan",
      );
    }
    if (dispatch.consent && !dispatch.consentRef) {
      return failed(
        dispatch,
        "internal",
        "runtime dispatch includes subject consent but no persisted consentRef",
      );
    }

    const isMulti = Boolean(dispatch.references && dispatch.references.length > 0);
    // CP3 §8 honesty gate (defence-in-depth): the control plane only builds a
    // references[] dispatch for a runtime that advertised supportsMultiReference,
    // but the executor refuses one for a vendor that does not actually map a
    // multi-slot input rather than silently dropping every slot but the first.
    if (isMulti && vendor.supportsMultiReference !== true) {
      return failed(
        dispatch,
        "vendor_rejected",
        `vendor ${dispatch.presetId} does not support multi-reference dispatch`,
      );
    }
    // CP3-c per-slot consent gate: a sensitive-role slot (pose_face) must carry its
    // OWN authorized consent. Fail closed (content_blocked), never a faked success.
    if (isMulti) {
      for (const slot of dispatch.references!) {
        const role = slot.role ?? "subject";
        if (roleRequiresConsent(role) && slot.consent?.authorized !== true) {
          return failed(
            dispatch,
            "content_blocked",
            `reference slot role "${role}" requires authorized subject consent`,
          );
        }
      }
      // CP3 per-slot receipt honesty (parity with the singular `consentRef` gate
      // above): if ANY slot carries subject consent, the control plane MUST have
      // persisted it and passed the `consentRefs` set. A missing set means the
      // runtime cannot vouch for per-subject authorization → fail closed, never faked.
      const anySlotConsent = dispatch.references!.some((slot) => slot.consent);
      if (anySlotConsent && (!dispatch.consentRefs || dispatch.consentRefs.length === 0)) {
        return failed(
          dispatch,
          "internal",
          "runtime dispatch includes per-slot subject consent but no persisted consentRefs",
        );
      }
    }

    let source;
    let sources;
    try {
      ({ source, sources } = await resolveMediaGenRuntimeSources({
        dispatch,
        bridge: options.bridge,
        resolveRuntimeLocalReference: options.resolveRuntimeLocalReference,
      }));
    } catch (error) {
      return failed(
        dispatch,
        "download_failed",
        error instanceof Error ? error.message : "runtime source resolution failed",
      );
    }

    const hasSource = Boolean(source) || Boolean(sources && sources.length > 0);
    let moderationApplied = false;
    if (options.moderation) {
      const verdict = await options.moderation.screenInput({
        mode: dispatch.mode,
        prompt: dispatch.prompt,
        hasSource,
        consentAuthorized: dispatch.consent?.authorized === true || Boolean(dispatch.consentRef),
      });
      if (!verdict.allowed) {
        return failed(
          dispatch,
          "content_blocked",
          verdict.reason ?? "runtime input moderation rejected",
        );
      }
      moderationApplied = true;
    }

    const job = await vendor.submit({
      taskId: dispatch.taskId,
      presetId: dispatch.presetId,
      mode: dispatch.mode,
      prompt: dispatch.prompt,
      durationSec: dispatch.durationSec,
      resolution: dispatch.resolution,
      params: dispatch.params,
      source,
      ...(sources && { sources }),
      ...(dispatch.frozenPlan && { frozenPlan: dispatch.frozenPlan }),
      ...(dispatch.executionAttempt !== undefined && {
        executionAttempt: dispatch.executionAttempt,
      }),
      ...(dispatch.frozenPlanDigest && { frozenPlanDigest: dispatch.frozenPlanDigest }),
      ...(dispatch.spatialInputEnvelope && { spatialInputEnvelope: dispatch.spatialInputEnvelope }),
    });
    if (job.state === "failed") {
      return failed(
        dispatch,
        job.reason,
        job.message,
        undefined,
        job.providerRequestDigest,
        job.providerObservation,
      );
    }
    if (job.state === "submission_unknown") {
      return {
        taskId: dispatch.taskId,
        workspaceId: dispatch.workspaceId,
        correlationId: dispatch.correlationId,
        status: "submission_unknown",
        failureReason: "internal",
        failureMessage: job.message,
        providerRequestDigest: job.providerRequestDigest,
        ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
      };
    }
    if (job.state === "canceled") {
      return canceled(
        dispatch,
        "The provider job was canceled.",
        job.vendorJobId,
        { state: "confirmed", reasonCode: "runtime_confirmed" },
        job.providerObservation,
      );
    }
    jobs.set(dispatch.taskId, {
      vendor,
      vendorJobId: job.vendorJobId,
      ...(dispatch.consentRef && { consentRef: dispatch.consentRef }),
      ...(dispatch.consentRefs && { consentRefs: dispatch.consentRefs }),
      ...(job.providerRequestDigest && {
        providerRequestDigest: job.providerRequestDigest,
      }),
    });
    if (job.state === "succeeded") {
      const settled = await finalize(
        dispatch,
        job,
        moderationApplied,
        dispatch.consentRef,
        dispatch.consentRefs,
      );
      return {
        ...settled,
        ...(job.spatialInputAcceptance && {
          spatialInputAcceptance: job.spatialInputAcceptance,
        }),
      };
    }
    return {
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: dispatch.correlationId,
      status: "processing",
      runtimeJobId: job.vendorJobId,
      ...(job.providerRequestDigest && {
        providerRequestDigest: job.providerRequestDigest,
      }),
      ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
      ...(job.spatialInputAcceptance && {
        spatialInputAcceptance: job.spatialInputAcceptance,
      }),
    };
  }

  return {
    async dispatch(input): Promise<MediaGenRuntimeResult> {
      if (input.op === "submit") return submit(input);
      if (input.op === "reconcile") {
        const tracked = jobs.get(input.taskId);
        const manuallyBoundReceipt =
          !input.runtimeJobId && !tracked
            ? options.resolveReconcileJobReceipt?.(input)?.trim()
            : undefined;
        return reconcileMediaGenRuntimeJob({
          dispatch: manuallyBoundReceipt ? { ...input, runtimeJobId: manuallyBoundReceipt } : input,
          tracked,
          fallbackVendor: vendorFor(input),
          finalize,
          remember: (job) => jobs.set(input.taskId, job),
          forget: () => jobs.delete(input.taskId),
        });
      }
      if (input.op === "retry") {
        const vendor = vendorFor(input);
        if (!vendor)
          return failed(input, "vendor_rejected", `unsupported preset ${input.presetId}`);
        if (input.runtimeJobId) {
          const prior = jobs.get(input.taskId);
          const job = vendor.reconcile
            ? await vendor.reconcile(input.runtimeJobId)
            : await vendor.poll(input.runtimeJobId);
          const providerRequestDigest = job.providerRequestDigest ?? prior?.providerRequestDigest;
          jobs.set(input.taskId, {
            vendor,
            vendorJobId: input.runtimeJobId,
            ...(input.consentRef && { consentRef: input.consentRef }),
            ...(input.consentRefs && { consentRefs: input.consentRefs }),
            ...(providerRequestDigest && {
              providerRequestDigest,
            }),
          });
          if (job.state === "processing") {
            return {
              taskId: input.taskId,
              workspaceId: input.workspaceId,
              correlationId: input.correlationId,
              status: "processing",
              runtimeJobId: input.runtimeJobId,
              ...(providerRequestDigest && {
                providerRequestDigest,
              }),
              ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
            };
          }
          if (job.state === "succeeded") {
            return finalize(
              input,
              job,
              false,
              input.consentRef,
              input.consentRefs,
              providerRequestDigest,
            );
          }
          if (job.state === "canceled") {
            jobs.delete(input.taskId);
            return canceled(
              input,
              "The provider job was canceled.",
              input.runtimeJobId,
              { state: "confirmed", reasonCode: "runtime_confirmed" },
              job.providerObservation,
            );
          }
          if (job.state === "submission_unknown") {
            return {
              taskId: input.taskId,
              workspaceId: input.workspaceId,
              correlationId: input.correlationId,
              status: "submission_unknown",
              failureReason: "internal",
              failureMessage: job.message,
              providerRequestDigest: job.providerRequestDigest,
              ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
            };
          }
          if (job.retryDisposition === "reconcile_only") {
            return failed(
              input,
              job.reason,
              job.message,
              undefined,
              providerRequestDigest,
              job.providerObservation,
            );
          }
          jobs.delete(input.taskId);
        }
        return submit(input);
      }
      const trackedForTask = jobs.get(input.taskId);
      if (
        trackedForTask &&
        input.runtimeJobId &&
        trackedForTask.vendorJobId !== input.runtimeJobId
      ) {
        // Never use task-local process memory to override the durable job fence.
        // A mismatched pair performs zero vendor I/O and keeps both jobs intact.
        return input.op === "cancel"
          ? canceled(
              input,
              "The runtime job binding did not match the requested task.",
              input.runtimeJobId,
              { state: "failed", reasonCode: "adapter_rejected" },
            )
          : failed(input, "internal", "The runtime job binding did not match the requested task.");
      }
      const tracked =
        trackedForTask ??
        (input.runtimeJobId
          ? {
              vendor: vendorFor(input),
              vendorJobId: input.runtimeJobId,
              ...(input.consentRef && { consentRef: input.consentRef }),
              ...(input.consentRefs && { consentRefs: input.consentRefs }),
              providerRequestDigest: undefined,
            }
          : undefined);
      if (tracked && !tracked.vendor) {
        return failed(input, "vendor_rejected", `unsupported preset ${input.presetId}`);
      }
      if (input.op === "cancel") {
        return cancelMediaGenRuntimeJob({
          dispatch: input,
          tracked: tracked as MediaGenRuntimeTrackedJob | undefined,
          forget: () => jobs.delete(input.taskId),
        });
      }
      if (!tracked || !tracked.vendor) {
        return failed(input, "internal", "runtime has no tracked vendor job");
      }
      const job = await tracked.vendor.poll(tracked.vendorJobId);
      if (job.state === "processing") {
        return {
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          correlationId: input.correlationId,
          status: "processing",
          runtimeJobId: tracked.vendorJobId,
          ...((job.providerRequestDigest ?? tracked.providerRequestDigest)
            ? {
                providerRequestDigest: job.providerRequestDigest ?? tracked.providerRequestDigest,
              }
            : {}),
          ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
        };
      }
      if (job.state === "failed") {
        return failed(
          input,
          job.reason,
          job.message,
          undefined,
          job.providerRequestDigest ?? tracked.providerRequestDigest,
          job.providerObservation,
        );
      }
      if (job.state === "canceled") {
        jobs.delete(input.taskId);
        return canceled(
          input,
          "The provider job was canceled.",
          tracked.vendorJobId,
          { state: "confirmed", reasonCode: "runtime_confirmed" },
          job.providerObservation,
        );
      }
      if (job.state === "submission_unknown") {
        return {
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          correlationId: input.correlationId,
          status: "submission_unknown",
          failureReason: "internal",
          failureMessage: job.message,
          providerRequestDigest: job.providerRequestDigest,
          ...(job.providerObservation ? { providerObservation: job.providerObservation } : {}),
        };
      }
      return finalize(
        input,
        job,
        false,
        tracked.consentRef ?? input.consentRef,
        tracked.consentRefs ?? input.consentRefs,
        tracked.providerRequestDigest,
      );
    },
  };
}
