import type {
  MediaGenRuntimeDispatch,
  MediaGenRuntimeResult,
  MediaGenRuntimeStopOutcome,
} from "../media-gen-runtime-http.js";
import type { MediaGenProviderRuntimeObservation } from "./provider-observation.js";

export function failedRuntimeResult(
  dispatch: MediaGenRuntimeDispatch,
  failureReason: NonNullable<MediaGenRuntimeResult["failureReason"]>,
  failureMessage: string,
  snapshot?: MediaGenRuntimeResult["snapshot"],
  providerRequestDigest?: string,
  providerObservation?: MediaGenProviderRuntimeObservation,
): MediaGenRuntimeResult {
  return {
    taskId: dispatch.taskId,
    workspaceId: dispatch.workspaceId,
    correlationId: dispatch.correlationId,
    status: "failed",
    failureReason,
    failureMessage,
    ...(snapshot !== undefined ? { snapshot } : {}),
    ...(providerRequestDigest ? { providerRequestDigest } : {}),
    ...(providerObservation ? { providerObservation } : {}),
  };
}

export function canceledRuntimeResult(
  dispatch: MediaGenRuntimeDispatch,
  failureMessage: string,
  runtimeJobId?: string,
  runtimeStopOutcome?: MediaGenRuntimeStopOutcome,
  providerObservation?: MediaGenProviderRuntimeObservation,
): MediaGenRuntimeResult {
  return {
    taskId: dispatch.taskId,
    workspaceId: dispatch.workspaceId,
    correlationId: dispatch.correlationId,
    status: "canceled",
    failureMessage,
    ...(runtimeJobId ? { runtimeJobId } : {}),
    ...(runtimeStopOutcome ? { runtimeStopOutcome } : {}),
    ...(providerObservation ? { providerObservation } : {}),
  };
}
