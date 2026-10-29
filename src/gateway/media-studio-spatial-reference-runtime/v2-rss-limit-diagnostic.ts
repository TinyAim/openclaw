/** Private scalar evidence only. This snapshot never grants admission or extinction. */
export type SpatialReferenceV2RssLimitDiagnostic = {
  source: "spatial_rss_limit/v1";
  metric: "darwin_libproc_tree_rss_span_v1" | "linux_proc_status_tree_rss_sum_v1";
  rootPid: number;
  observerPid: number | null;
  nodeCount: number | null;
  verifiedSpanMs: number | null;
  capBytes: number;
  observedBytes: number;
  peakBytes: number;
  observedAtMs: number;
  phase:
    | "periodic"
    | "post_browser_launch"
    | "post_host_load"
    | "post_first_webgl_frame"
    | "before_ffmpeg"
    | "after_ffmpeg";
  renderStage: string;
  frameIndex: number | null;
};

const keys =
  "capBytes,frameIndex,metric,nodeCount,observedAtMs,observedBytes,observerPid,peakBytes,phase,renderStage,rootPid,source,verifiedSpanMs";
const stages = [
  "unknown",
  "observer",
  "worker",
  "request_accounting",
  "browser_launch",
  "toolchain_probe",
  "page_create",
  "reference_host_load",
  "frame_render",
  "motion_encode",
  "motion_verify",
  "render_host_dispose",
  "manifest_write",
];
const phases = [
  "periodic",
  "post_browser_launch",
  "post_host_load",
  "post_first_webgl_frame",
  "before_ffmpeg",
  "after_ffmpeg",
];
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

/** Reject unknown/raw fields and impossible sums rather than silently stripping them. */
export function validateSpatialReferenceV2RssLimitDiagnostic(
  value: unknown,
): SpatialReferenceV2RssLimitDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).toSorted().join(",") !== keys ||
    row.source !== "spatial_rss_limit/v1" ||
    !integer(row.rootPid, 1, 2147483647) ||
    !integer(row.capBytes, 1) ||
    !integer(row.observedBytes, 1) ||
    !integer(row.peakBytes, 1) ||
    !integer(row.observedAtMs) ||
    row.observedBytes <= row.capBytes ||
    row.peakBytes < row.observedBytes ||
    typeof row.phase !== "string" ||
    !phases.includes(row.phase) ||
    typeof row.renderStage !== "string" ||
    !stages.includes(row.renderStage) ||
    !(row.frameIndex === null || integer(row.frameIndex, 0, 359))
  )
    return undefined;
  if (row.metric === "darwin_libproc_tree_rss_span_v1") {
    if (
      !integer(row.observerPid, 1, 2147483647) ||
      row.observerPid === row.rootPid ||
      !integer(row.nodeCount, 2, Math.floor(4194304 / 24)) ||
      !integer(row.verifiedSpanMs, 0, 2999)
    )
      return undefined;
  } else if (
    row.metric !== "linux_proc_status_tree_rss_sum_v1" ||
    row.observerPid !== null ||
    row.nodeCount !== null ||
    row.verifiedSpanMs !== null
  )
    return undefined;
  return Object.freeze({ ...row }) as SpatialReferenceV2RssLimitDiagnostic;
}
