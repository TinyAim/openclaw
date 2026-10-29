export const PROVIDER_RUNTIME_OPERATIONS = ["submit", "poll", "reconcile", "cancel"] as const;
export type MediaGenProviderRuntimeOperation = (typeof PROVIDER_RUNTIME_OPERATIONS)[number];

export const PROVIDER_RUNTIME_OUTCOMES = [
  "processing",
  "succeeded",
  "failed",
  "submission_unknown",
  "canceled",
] as const;
export type MediaGenProviderRuntimeOutcome = (typeof PROVIDER_RUNTIME_OUTCOMES)[number];

export const PROVIDER_QUALITY_OUTCOMES = ["passed", "failed", "not_run"] as const;
export type MediaGenProviderQualityOutcome = (typeof PROVIDER_QUALITY_OUTCOMES)[number];

export type MediaGenProviderRuntimeObservation = {
  schemaVersion: 1;
  routeId: string;
  adapterRevision: string;
  operation: MediaGenProviderRuntimeOperation;
  outcome: MediaGenProviderRuntimeOutcome;
  latencyMs: number;
  qualityOutcome: MediaGenProviderQualityOutcome;
  observedAt: string;
};

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u;

export function providerObservation(input: {
  routeId: string;
  adapterRevision: string;
  operation: MediaGenProviderRuntimeOperation;
  outcome: MediaGenProviderRuntimeOutcome;
  startedAtMs: number;
  finishedAt: Date;
}): MediaGenProviderRuntimeObservation {
  return {
    schemaVersion: 1,
    routeId: input.routeId,
    adapterRevision: input.adapterRevision,
    operation: input.operation,
    outcome: input.outcome,
    latencyMs: Math.max(0, Math.min(86_400_000, input.finishedAt.getTime() - input.startedAtMs)),
    qualityOutcome: "not_run",
    observedAt: input.finishedAt.toISOString(),
  };
}

export function finishProviderObservation(
  observation: MediaGenProviderRuntimeObservation | undefined,
  outcome: MediaGenProviderRuntimeOutcome,
  qualityOutcome?: MediaGenProviderQualityOutcome,
): MediaGenProviderRuntimeObservation | undefined {
  return observation
    ? {
        ...observation,
        outcome,
        ...(qualityOutcome ? { qualityOutcome } : {}),
      }
    : undefined;
}

export function parseProviderObservation(raw: unknown): MediaGenProviderRuntimeObservation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "routeId",
    "adapterRevision",
    "operation",
    "outcome",
    "latencyMs",
    "qualityOutcome",
    "observedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return null;
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.routeId !== "string" ||
    !SAFE_ID.test(value.routeId) ||
    typeof value.adapterRevision !== "string" ||
    !SAFE_ID.test(value.adapterRevision) ||
    !PROVIDER_RUNTIME_OPERATIONS.includes(value.operation as MediaGenProviderRuntimeOperation) ||
    !PROVIDER_RUNTIME_OUTCOMES.includes(value.outcome as MediaGenProviderRuntimeOutcome) ||
    typeof value.latencyMs !== "number" ||
    !Number.isInteger(value.latencyMs) ||
    value.latencyMs < 0 ||
    value.latencyMs > 86_400_000 ||
    !PROVIDER_QUALITY_OUTCOMES.includes(value.qualityOutcome as MediaGenProviderQualityOutcome) ||
    typeof value.observedAt !== "string" ||
    Number.isNaN(Date.parse(value.observedAt))
  ) {
    return null;
  }
  return value as MediaGenProviderRuntimeObservation;
}
