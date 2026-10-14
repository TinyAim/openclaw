/** Private scalar evidence frozen at observer exec promise settlement. */
export type SpatialReferenceV2ObserverExecDiagnostic = {
  source: "darwin_observer_exec/v1";
  code: string;
  elapsedMs: number;
  closeObserved: boolean;
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  nativeStage: string;
  renderStage: string;
  frameIndex: number | null;
  spawnReturnMs?: number | null;
  spawnObserved?: boolean;
  spawnObservedMs?: number | null;
  exitObserved?: boolean;
  exitObservedMs?: number | null;
  exitEventCode?: number | null;
  exitEventSignal?: string | null;
};

const legacyKeys =
  "closeObserved,code,elapsedMs,exitCode,frameIndex,nativeStage,renderStage,signal,source,stderrBytes,stdoutBytes";
const lifecycleKeys = [
  "spawnReturnMs",
  "spawnObserved",
  "spawnObservedMs",
  "exitObserved",
  "exitObservedMs",
  "exitEventCode",
  "exitEventSignal",
];
const extendedKeys = [...legacyKeys.split(","), ...lifecycleKeys].toSorted().join(",");
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const signal = (v: unknown) =>
  v === null ||
  (typeof v === "string" &&
    /^SIG(?:ABRT|ALRM|BUS|CHLD|CONT|FPE|HUP|ILL|INT|KILL|PIPE|QUIT|SEGV|STOP|TERM|TRAP|TSTP|TTIN|TTOU|USR1|USR2)$/u.test(
      v,
    ));
const code = (v: unknown) => v === null || integer(v, -2147483648, 2147483647);

/** Legacy rows remain readable; a lifecycle extension must be complete and exact. */
export function validateObserverExecDiagnostic(
  value: unknown,
  nativeStages: readonly string[],
  renderStages: readonly string[],
): SpatialReferenceV2ObserverExecDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as SpatialReferenceV2ObserverExecDiagnostic;
  const keys = Object.keys(row).toSorted().join(",");
  if (
    (keys !== legacyKeys && keys !== extendedKeys) ||
    row.source !== "darwin_observer_exec/v1" ||
    !integer(row.elapsedMs) ||
    typeof row.code !== "string" ||
    !/^spatial_v2_rss_observation_[a-z_]{1,64}$/u.test(row.code) ||
    typeof row.closeObserved !== "boolean" ||
    !code(row.exitCode) ||
    !signal(row.signal) ||
    (!row.closeObserved && (row.exitCode !== null || row.signal !== null)) ||
    (row.exitCode !== null && row.signal !== null) ||
    ![row.stdoutBytes, row.stderrBytes].every((v) => v === null || integer(v)) ||
    !(row.nativeStage === "unknown" || nativeStages.includes(row.nativeStage)) ||
    !(row.renderStage === "unknown" || renderStages.includes(row.renderStage)) ||
    !(row.frameIndex === null || integer(row.frameIndex, 0, 359))
  )
    return undefined;
  if (keys === extendedKeys) {
    const time = (v: unknown) => v === null || integer(v, 0, row.elapsedMs);
    if (
      !time(row.spawnReturnMs) ||
      !time(row.spawnObservedMs) ||
      !time(row.exitObservedMs) ||
      typeof row.spawnObserved !== "boolean" ||
      typeof row.exitObserved !== "boolean" ||
      row.spawnObserved !== (row.spawnObservedMs !== null) ||
      row.exitObserved !== (row.exitObservedMs !== null) ||
      !code(row.exitEventCode) ||
      !signal(row.exitEventSignal) ||
      (!row.exitObserved && (row.exitEventCode !== null || row.exitEventSignal !== null)) ||
      (row.exitEventCode !== null && row.exitEventSignal !== null) ||
      (row.spawnReturnMs !== null &&
        row.spawnObservedMs !== null &&
        row.spawnObservedMs! < row.spawnReturnMs!) ||
      (row.spawnReturnMs !== null &&
        row.exitObservedMs !== null &&
        row.exitObservedMs! < row.spawnReturnMs!)
    )
      return undefined;
  }
  return { ...row };
}
