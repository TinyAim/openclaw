/**
 * Gate 1E — assembly-render executor: encode + Control API callbacks.
 *
 * Accepts dispatch immediately, runs encode asynchronously, never claims
 * FinalMaster without posting complete to Control API.
 *
 * At-least-once HTTP fencing:
 * - job key = workspaceId + renderId
 * - identical (epoch, attemptId) → idempotent accepted (no restart)
 * - older epoch → rejected (stale)
 * - newer epoch → install replacement, then abort prior job
 * - same epoch, different attemptId → conflict (fail closed; attemptId is opaque)
 * - finally deletes only when map still holds the same job object
 * - cancel must match active fence (missing token on fenced job fails closed)
 */
import type {
  MediaStudioAssemblyRenderCancel,
  MediaStudioAssemblyRenderDispatch,
  MediaStudioAssemblyRenderHttpExecutor,
} from "../media-studio-assembly-render-http.js";
import type {
  AssemblyRenderControlApiBridge,
  AssemblyRenderEncodeFn,
} from "./types.js";

export type MediaStudioAssemblyRenderExecutorOptions = {
  bridge: AssemblyRenderControlApiBridge;
  encode: AssemblyRenderEncodeFn;
  /**
   * When handoff is unavailable, allow completing with a synthetic artifact id.
   * Default false — fail closed (requires handoff or inject).
   */
  allowSyntheticMasterId?: boolean;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
};

type JobState = {
  cancelled: boolean;
  controller: AbortController;
  dispatch: MediaStudioAssemblyRenderDispatch;
};

function jobKey(workspaceId: string, renderId: string): string {
  return `${workspaceId.trim()}\0${renderId.trim()}`;
}

function fenceTuple(d: {
  dispatchEpoch?: number;
  dispatchAttemptId?: string;
}): { epoch: number | undefined; attemptId: string | undefined } {
  return {
    epoch: typeof d.dispatchEpoch === "number" ? d.dispatchEpoch : undefined,
    attemptId: d.dispatchAttemptId?.trim() || undefined,
  };
}

/**
 * Four-state fence compare.
 * - older: incoming epoch strictly less (or missing when active is fenced)
 * - same: identical epoch+attempt (or both unfenced) — idempotent retry
 * - newer: incoming epoch strictly greater (or active unfenced and incoming fenced)
 * - conflict: same epoch with different opaque attemptId (cannot order)
 */
function compareFence(
  active: { epoch: number | undefined; attemptId: string | undefined },
  incoming: { epoch: number | undefined; attemptId: string | undefined },
): "older" | "same" | "newer" | "conflict" {
  const aEpoch = active.epoch;
  const bEpoch = incoming.epoch;
  if (aEpoch !== undefined && bEpoch !== undefined) {
    if (bEpoch < aEpoch) return "older";
    if (bEpoch > aEpoch) return "newer";
  } else if (aEpoch !== undefined && bEpoch === undefined) {
    return "older";
  } else if (aEpoch === undefined && bEpoch !== undefined) {
    return "newer";
  }
  const aAttempt = active.attemptId;
  const bAttempt = incoming.attemptId;
  if (aAttempt !== undefined && bAttempt !== undefined) {
    if (bAttempt === aAttempt) return "same";
    // Opaque attempt ids have no ordering at equal epoch — fail closed.
    return "conflict";
  }
  if (aAttempt !== undefined && bAttempt === undefined) return "older";
  if (aAttempt === undefined && bAttempt !== undefined) return "newer";
  // Both unfenced (no epoch/attempt): treat as exact retry of active.
  return "same";
}

export function createMediaStudioAssemblyRenderExecutor(
  options: MediaStudioAssemblyRenderExecutorOptions,
): MediaStudioAssemblyRenderHttpExecutor {
  const jobs = new Map<string, JobState>();
  const allowSynthetic = options.allowSyntheticMasterId === true;

  async function runJob(
    key: string,
    dispatch: MediaStudioAssemblyRenderDispatch,
    job: JobState,
  ): Promise<void> {
    const runtimeId = options.bridge.runtimeId;
    const fencing = {
      ...(typeof dispatch.dispatchEpoch === "number"
        ? { dispatchEpoch: dispatch.dispatchEpoch }
        : {}),
      ...(dispatch.dispatchAttemptId
        ? { dispatchAttemptId: dispatch.dispatchAttemptId }
        : {}),
    };

    try {
      // Drop work if this generation was already replaced before start.
      if (jobs.get(key) !== job) return;

      await options.bridge.postProgress({
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        renderId: dispatch.renderId,
        runtimeId,
        progressPercent: 10,
        progressMessage: "preparing_timeline",
        ...fencing,
      });
      if (job.cancelled || jobs.get(key) !== job) {
        if (jobs.get(key) === job) {
          await options.bridge.postFail({
            workspaceId: dispatch.workspaceId,
            projectId: dispatch.projectId,
            renderId: dispatch.renderId,
            runtimeId,
            failed: true,
            errorCode: "media_studio.render.cancelled",
            cancelAcknowledged: true,
            ...fencing,
          });
        }
        return;
      }

      await options.bridge.postProgress({
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        renderId: dispatch.renderId,
        runtimeId,
        progressPercent: 40,
        progressMessage: "encoding",
        ...fencing,
      });

      const encoded = await options.encode({
        renderId: dispatch.renderId,
        timeline: dispatch.timeline,
        signal: job.controller.signal,
      });

      if (job.cancelled || jobs.get(key) !== job) {
        if (jobs.get(key) === job) {
          await options.bridge.postFail({
            workspaceId: dispatch.workspaceId,
            projectId: dispatch.projectId,
            renderId: dispatch.renderId,
            runtimeId,
            failed: true,
            errorCode: "media_studio.render.cancelled",
            cancelAcknowledged: true,
            ...fencing,
          });
        }
        return;
      }

      await options.bridge.postProgress({
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        renderId: dispatch.renderId,
        runtimeId,
        progressPercent: 85,
        progressMessage: "handing_off_master",
        ...fencing,
      });

      let artifactId: string;
      if (options.bridge.handoffMaster) {
        const handed = await options.bridge.handoffMaster({
          workspaceId: dispatch.workspaceId,
          projectId: dispatch.projectId,
          renderId: dispatch.renderId,
          taskCenterTaskId: dispatch.taskCenterTaskId,
          bytes: encoded.bytes,
          mimeType: encoded.mimeType,
          sha256: encoded.sha256,
          durationSec: encoded.durationSec,
          resolution: encoded.resolution,
        });
        artifactId = handed.artifactId;
      } else if (allowSynthetic) {
        artifactId = `runtime-master-${dispatch.renderId}-${encoded.sha256.slice(0, 12)}`;
      } else {
        if (jobs.get(key) === job) {
          await options.bridge.postFail({
            workspaceId: dispatch.workspaceId,
            projectId: dispatch.projectId,
            renderId: dispatch.renderId,
            runtimeId,
            failed: true,
            errorCode: "media_studio.render.master_handoff_unavailable",
            ...fencing,
          });
        }
        return;
      }

      if (jobs.get(key) !== job) return;

      try {
        await options.bridge.postComplete({
          workspaceId: dispatch.workspaceId,
          projectId: dispatch.projectId,
          renderId: dispatch.renderId,
          runtimeId,
          finalMasterArtifactId: artifactId,
          qcPassed: true,
          durationSec: encoded.durationSec,
          resolution: encoded.resolution,
          codec: encoded.codec,
          checksum: encoded.sha256,
          mimeType: encoded.mimeType,
          ...fencing,
        });
      } catch (completeErr) {
        // Handoff already registered an Artifact; complete failed.
        // Detection + fail callback carries artifactId/checksum so Control API
        // can mark the render failed with an orphan pointer. Full durable
        // orphan-receipt reconcile remains a control-plane follow-up.
        options.log?.warn?.(
          `assembly-render orphan_master_handoff renderId=${dispatch.renderId} artifactId=${artifactId} err=${String(completeErr)}`,
        );
        try {
          await options.bridge.postFail({
            workspaceId: dispatch.workspaceId,
            projectId: dispatch.projectId,
            renderId: dispatch.renderId,
            runtimeId,
            failed: true,
            errorCode: "media_studio.render.complete_after_handoff_failed",
            orphanArtifactId: artifactId,
            orphanChecksum: encoded.sha256,
            ...fencing,
          });
        } catch (failErr) {
          options.log?.warn?.(
            `assembly-render orphan fail-callback also failed renderId=${dispatch.renderId} artifactId=${artifactId}: ${String(failErr)}`,
          );
        }
        return;
      }
      options.log?.info?.(
        `assembly-render complete renderId=${dispatch.renderId} artifactId=${artifactId}`,
      );
    } catch (err) {
      // Superseded generations must not post cancel/fail for a newer attempt.
      if (jobs.get(key) !== job) return;
      const message = err instanceof Error ? err.message : String(err);
      const errorCode =
        message === "cancelled" || job.cancelled
          ? "media_studio.render.cancelled"
          : message === "empty_timeline"
            ? "media_studio.render.empty_timeline"
            : "media_studio.render.encode_failed";
      try {
        await options.bridge.postFail({
          workspaceId: dispatch.workspaceId,
          projectId: dispatch.projectId,
          renderId: dispatch.renderId,
          runtimeId,
          failed: true,
          errorCode,
          ...(errorCode === "media_studio.render.cancelled"
            ? { cancelAcknowledged: true }
            : {}),
          ...fencing,
        });
      } catch (callbackErr) {
        options.log?.warn?.(
          `assembly-render fail callback error renderId=${dispatch.renderId}: ${String(callbackErr)}`,
        );
      }
    } finally {
      // Only the active generation may clear the slot.
      if (jobs.get(key) === job) {
        jobs.delete(key);
      }
    }
  }

  return {
    dispatch(input: MediaStudioAssemblyRenderDispatch) {
      if (input.timeline.length === 0) {
        return {
          accepted: false,
          messageKey: "media_studio.render.empty_timeline",
        };
      }
      const key = jobKey(input.workspaceId, input.renderId);
      const prior = jobs.get(key);
      if (prior) {
        const cmp = compareFence(fenceTuple(prior.dispatch), fenceTuple(input));
        if (cmp === "same") {
          // Exact retry of the active attempt — do not abort / restart.
          return { accepted: true };
        }
        if (cmp === "older") {
          return {
            accepted: false,
            messageKey: "media_studio.render.stale_dispatch",
          };
        }
        if (cmp === "conflict") {
          return {
            accepted: false,
            messageKey: "media_studio.render.dispatch_fence_conflict",
          };
        }
        // cmp === "newer": install replacement first, then abort prior.
      }
      const controller = new AbortController();
      const state: JobState = {
        cancelled: false,
        controller,
        dispatch: input,
      };
      // Install replacement before aborting prior so prior finally cannot
      // delete the new map entry (matches fencing contract).
      jobs.set(key, state);
      if (prior) {
        prior.cancelled = true;
        prior.controller.abort();
      }
      // Fire-and-forget encode loop; Control API owns terminal truth via callbacks.
      void runJob(key, input, state);
      return { accepted: true };
    },
    cancel(input: MediaStudioAssemblyRenderCancel) {
      const key = jobKey(input.workspaceId, input.renderId);
      const job = jobs.get(key);
      if (!job) {
        return {
          cancelled: false,
          messageKey: "media_studio.render.runtime_job_not_found",
        };
      }
      if (job.dispatch.workspaceId !== input.workspaceId) {
        return {
          cancelled: false,
          messageKey: "media_studio.render.runtime_workspace_mismatch",
        };
      }
      const active = fenceTuple(job.dispatch);
      const incoming = fenceTuple(input);
      // Fenced active job requires exact epoch+attempt match (fail closed).
      if (active.epoch !== undefined || active.attemptId !== undefined) {
        if (incoming.epoch === undefined && incoming.attemptId === undefined) {
          return {
            cancelled: false,
            messageKey: "media_studio.render.cancel_fence_required",
          };
        }
        if (compareFence(active, incoming) !== "same") {
          return {
            cancelled: false,
            messageKey: "media_studio.render.stale_cancel",
          };
        }
      }
      job.cancelled = true;
      job.controller.abort();
      return { cancelled: true };
    },
  };
}
