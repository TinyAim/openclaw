import type {
  MediaGenReferenceRole,
  MediaGenRuntimeDispatch,
  MediaGenRuntimeHttpExecutor,
  MediaGenRuntimeResult,
} from "../media-gen-runtime-http.js";
import { downloadMedia } from "./executor-media-download.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeFetch,
  MediaGenRuntimeLabeler,
  MediaGenRuntimeModeration,
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorJob,
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
};

type TrackedJob = {
  vendor: MediaGenRuntimeVendor;
  vendorJobId: string;
  consentRef?: string;
  // CP3 per-slot consent receipts tracked at submit so poll/retry stamp the SAME
  // set onto the succeeded snapshot (the runtime never invents a local placeholder).
  consentRefs?: string[];
};

const DEFAULT_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

function failed(
  dispatch: MediaGenRuntimeDispatch,
  failureReason: NonNullable<MediaGenRuntimeResult["failureReason"]>,
  failureMessage: string,
  snapshot?: MediaGenRuntimeResult["snapshot"],
): MediaGenRuntimeResult {
  return {
    taskId: dispatch.taskId,
    workspaceId: dispatch.workspaceId,
    correlationId: dispatch.correlationId,
    status: "failed",
    failureReason,
    failureMessage,
    ...(snapshot !== undefined ? { snapshot } : {}),
  };
}

function snapshot(
  dispatch: MediaGenRuntimeDispatch,
  input: {
    moderationApplied: boolean;
    labelingApplied: boolean;
    consentRef?: string;
    consentRefs?: string[];
    auditRef: string;
    now: Date;
  },
): NonNullable<MediaGenRuntimeResult["snapshot"]> {
  return {
    executionOwner: "user_runtime",
    moderationStatus: input.moderationApplied ? "runtime_enforced" : "not_enforced",
    labelingStatus: input.labelingApplied ? "runtime_applied" : "absent",
    registrationDisclosureStatus: "operator_self_declared",
    capturedAt: input.now.toISOString(),
    ...(input.consentRef && { consentRef: input.consentRef }),
    // CP3 per-slot consent — stamp the FULL set the control plane persisted, so
    // each subject's authorization is independently auditable on the artifact.
    ...(input.consentRefs && input.consentRefs.length > 0 && {
      consentRefs: input.consentRefs,
    }),
    auditRef: input.auditRef,
  };
}

export function createOpenClawMediaGenRuntimeExecutor(
  options: MediaGenRuntimeExecutorOptions,
): MediaGenRuntimeHttpExecutor {
  const vendors = new Map(options.vendors.map((vendor) => [vendor.presetId, vendor]));
  const jobs = new Map<string, TrackedJob>();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const mediaFetchTimeoutMs = options.mediaFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const allowedMediaHosts = options.allowedMediaHosts ?? [];

  async function resolveSource(dispatch: MediaGenRuntimeDispatch): Promise<MediaGenRuntimeSource | undefined> {
    if (!dispatch.reference) return undefined;
    if (dispatch.reference.kind === "runtime_local") {
      throw new Error("runtime_local media references require a local resolver and are not enabled");
    }
    const artifactId = dispatch.reference.artifactId;
    if (!artifactId) throw new Error("artifact reference is missing artifactId");
    return options.bridge.resolveArtifactReference({
      dispatch,
      artifactId,
    });
  }

  // CP3 §3.3 multi-slot source resolution — each reference slot mints its OWN
  // role-scoped grant (so the control plane authoritatively re-checks role↔mime per
  // slot) and is redeemed to bytes independently. Never a shared naked URL/bytes.
  async function resolveSources(
    dispatch: MediaGenRuntimeDispatch,
  ): Promise<MediaGenRuntimeSourceSlot[]> {
    const slots = dispatch.references ?? [];
    const resolved: MediaGenRuntimeSourceSlot[] = [];
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]!;
      const role = slot.role ?? "subject";
      if (slot.kind === "runtime_local") {
        throw new Error("runtime_local media references require a local resolver and are not enabled");
      }
      const artifactId = slot.artifactId;
      if (!artifactId) throw new Error("artifact reference is missing artifactId");
      const source = await options.bridge.resolveArtifactReference({
        dispatch,
        artifactId,
        role,
      });
      resolved.push({ role, ordinal: slot.ordinal ?? index, source });
    }
    return resolved;
  }

  async function finalize(
    dispatch: MediaGenRuntimeDispatch,
    job: Extract<MediaGenRuntimeVendorJob, { state: "succeeded" }>,
    moderationApplied: boolean,
    consentRef?: string,
    consentRefs?: string[],
  ): Promise<MediaGenRuntimeResult> {
    if (options.moderation) {
      const verdict = await options.moderation.screenOutput({
        mediaRef: job.output.mediaRef,
        mimeType: job.output.mimeType,
      });
      if (!verdict.allowed) {
        return failed(dispatch, "content_blocked", verdict.reason ?? "runtime output moderation rejected");
      }
      moderationApplied = true;
    }

    let output = job.output;
    let labelingApplied = false;
    if (options.labeler) {
      const labeled = await options.labeler.applyLabel(output);
      if (!labeled.applied) {
        return failed(dispatch, "internal", "runtime labeler did not confirm label application");
      }
      labelingApplied = true;
      output = labeled;
    }

    let downloaded: { bytes: Buffer; sha256: string; mimeType: string };
    try {
      downloaded = await downloadMedia(output, {
        fetchImpl,
        timeoutMs: mediaFetchTimeoutMs,
        maxBytes: maxMediaBytes,
        allowedHosts: allowedMediaHosts,
        allowInsecure: options.allowInsecureMediaFetch === true,
      });
    } catch (error) {
      return failed(
        dispatch,
        "download_failed",
        error instanceof Error ? error.message : "runtime failed to fetch vendor output",
      );
    }

    const handoffOutput = { ...output, mimeType: downloaded.mimeType };
    const artifact = await options.bridge.handoffArtifact({
      dispatch,
      output: handoffOutput,
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
    });
    return {
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: dispatch.correlationId,
      status: "succeeded",
      runtimeJobId: job.vendorJobId,
      artifact,
      snapshot: snapshot(dispatch, {
        moderationApplied,
        labelingApplied,
        consentRef,
        consentRefs,
        auditRef: `openclaw-runtime:${options.bridge.runtimeId}:${dispatch.taskId}`,
        now: now(),
      }),
    };
  }

  async function submit(dispatch: MediaGenRuntimeDispatch): Promise<MediaGenRuntimeResult> {
    const vendor = vendors.get(dispatch.presetId);
    if (!vendor) return failed(dispatch, "vendor_rejected", `unsupported preset ${dispatch.presetId}`);
    if (!vendor.isConfigured()) return failed(dispatch, "auth", `vendor ${dispatch.presetId} is not configured`);
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
      if (
        anySlotConsent &&
        (!dispatch.consentRefs || dispatch.consentRefs.length === 0)
      ) {
        return failed(
          dispatch,
          "internal",
          "runtime dispatch includes per-slot subject consent but no persisted consentRefs",
        );
      }
    }

    let source: MediaGenRuntimeSource | undefined;
    let sources: MediaGenRuntimeSourceSlot[] | undefined;
    try {
      if (isMulti) {
        sources = await resolveSources(dispatch);
      } else {
        source = await resolveSource(dispatch);
      }
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
        return failed(dispatch, "content_blocked", verdict.reason ?? "runtime input moderation rejected");
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
    });
    if (job.state === "failed") {
      return failed(dispatch, job.reason, job.message);
    }
    jobs.set(dispatch.taskId, {
      vendor,
      vendorJobId: job.vendorJobId,
      ...(dispatch.consentRef && { consentRef: dispatch.consentRef }),
      ...(dispatch.consentRefs && { consentRefs: dispatch.consentRefs }),
    });
    if (job.state === "succeeded") {
      return finalize(
        dispatch,
        job,
        moderationApplied,
        dispatch.consentRef,
        dispatch.consentRefs,
      );
    }
    return {
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: dispatch.correlationId,
      status: "processing",
      runtimeJobId: job.vendorJobId,
    };
  }

  return {
    async dispatch(input): Promise<MediaGenRuntimeResult> {
      if (input.op === "submit") return submit(input);
      if (input.op === "retry") {
        const vendor = vendors.get(input.presetId);
        if (!vendor) return failed(input, "vendor_rejected", `unsupported preset ${input.presetId}`);
        if (input.runtimeJobId) {
          const job = await vendor.poll(input.runtimeJobId);
          jobs.set(input.taskId, {
            vendor,
            vendorJobId: input.runtimeJobId,
            ...(input.consentRef && { consentRef: input.consentRef }),
            ...(input.consentRefs && { consentRefs: input.consentRefs }),
          });
          if (job.state === "processing") {
            return {
              taskId: input.taskId,
              workspaceId: input.workspaceId,
              correlationId: input.correlationId,
              status: "processing",
              runtimeJobId: input.runtimeJobId,
            };
          }
          if (job.state === "succeeded") {
            return finalize(input, job, false, input.consentRef, input.consentRefs);
          }
          jobs.delete(input.taskId);
        }
        return submit(input);
      }
      const tracked =
        jobs.get(input.taskId) ??
        (input.runtimeJobId
          ? Array.from(jobs.values()).find((job) => job.vendorJobId === input.runtimeJobId)
          : undefined) ??
        (input.runtimeJobId
          ? {
              vendor: vendors.get(input.presetId),
              vendorJobId: input.runtimeJobId,
              ...(input.consentRef && { consentRef: input.consentRef }),
              ...(input.consentRefs && { consentRefs: input.consentRefs }),
            }
          : undefined);
      if (tracked && !tracked.vendor) {
        return failed(input, "vendor_rejected", `unsupported preset ${input.presetId}`);
      }
      if (input.op === "cancel") {
        const cancelVendor = tracked?.vendor;
        const cancelVendorJobId = tracked?.vendorJobId;
        if (cancelVendor?.cancel && cancelVendorJobId) {
          await cancelVendor.cancel(cancelVendorJobId).catch(() => undefined);
        }
        jobs.delete(input.taskId);
        return {
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          correlationId: input.correlationId,
          status: "canceled",
        };
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
        };
      }
      if (job.state === "failed") return failed(input, job.reason, job.message);
      return finalize(
        input,
        job,
        false,
        tracked.consentRef ?? input.consentRef,
        tracked.consentRefs ?? input.consentRefs,
      );
    },
  };
}
