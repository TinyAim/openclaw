import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";

export type ReconcileJobBinding = {
  workspaceId: string;
  taskId: string;
  presetId: string;
  mode: "text2video" | "image2video";
  executionAttempt: number;
  frozenPlanDigest: string;
  runtimeJobId: string;
};

export type ReconcileJobBindingMap = Map<string, ReconcileJobBinding>;

function bindingKey(
  input: Pick<
    ReconcileJobBinding,
    "workspaceId" | "taskId" | "presetId" | "mode" | "executionAttempt" | "frozenPlanDigest"
  >,
): string {
  return (
    `${input.workspaceId}\u0000${input.taskId}\u0000${input.presetId}\u0000${input.mode}` +
    `\u0000${input.executionAttempt}\u0000${input.frozenPlanDigest}`
  );
}

function safeToken(value: unknown, maxLength = 300): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[a-zA-Z0-9._:/-]+$/u.test(value)
  );
}

function safeRuntimeJobId(value: unknown): value is string {
  return safeToken(value, 512) && !value.includes("://");
}

export function parseReconcileJobBindings(
  raw: string | undefined,
  allowedWorkspaces: ReadonlySet<string>,
): ReconcileJobBindingMap | null {
  if (!raw?.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 256) return null;
  const result: ReconcileJobBindingMap = new Map();
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).length !== 7 ||
      ![
        "workspaceId",
        "taskId",
        "presetId",
        "mode",
        "executionAttempt",
        "frozenPlanDigest",
        "runtimeJobId",
      ].every((key) => Object.hasOwn(row, key)) ||
      !safeToken(row.workspaceId) ||
      !allowedWorkspaces.has(row.workspaceId) ||
      !safeToken(row.taskId) ||
      !safeToken(row.presetId, 100) ||
      (row.mode !== "text2video" && row.mode !== "image2video") ||
      typeof row.executionAttempt !== "number" ||
      !Number.isSafeInteger(row.executionAttempt) ||
      row.executionAttempt <= 0 ||
      typeof row.frozenPlanDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(row.frozenPlanDigest) ||
      !safeRuntimeJobId(row.runtimeJobId)
    ) {
      return null;
    }
    const binding: ReconcileJobBinding = {
      workspaceId: row.workspaceId,
      taskId: row.taskId,
      presetId: row.presetId,
      mode: row.mode,
      executionAttempt: row.executionAttempt,
      frozenPlanDigest: row.frozenPlanDigest,
      runtimeJobId: row.runtimeJobId,
    };
    const key = bindingKey(binding);
    if (result.has(key)) return null;
    result.set(key, binding);
  }
  return result;
}

export function resolveReconcileJobReceipt(
  bindings: ReconcileJobBindingMap,
  dispatch: MediaGenRuntimeDispatch,
): string | undefined {
  if (dispatch.executionAttempt === undefined || !dispatch.frozenPlanDigest) return undefined;
  return bindings.get(
    bindingKey({
      workspaceId: dispatch.workspaceId,
      taskId: dispatch.taskId,
      presetId: dispatch.presetId,
      mode: dispatch.mode,
      executionAttempt: dispatch.executionAttempt,
      frozenPlanDigest: dispatch.frozenPlanDigest,
    }),
  )?.runtimeJobId;
}
