import type { MediaGenRuntimeVendorJob } from "./types.js";

export type ViduCreateResponse = {
  task_id?: unknown;
  state?: unknown;
  code?: unknown;
  reason?: unknown;
  message?: unknown;
};

export type ViduCreationsResponse = {
  state?: unknown;
  err_code?: unknown;
  code?: unknown;
  reason?: unknown;
  message?: unknown;
  creations?: unknown;
};

function responseText(value: ViduCreateResponse | ViduCreationsResponse | null): string {
  if (!value) {
    return "";
  }
  return [value.code, value.reason, value.message, "err_code" in value ? value.err_code : undefined]
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map(String)
    .join(" ");
}

/** Convert Vidu transport failures into the closed product failure vocabulary. */
export function normalizeViduFailure(input: {
  status: number;
  body: ViduCreateResponse | ViduCreationsResponse | null;
  phase: "submit" | "task";
  vendorJobId?: string;
}): Extract<MediaGenRuntimeVendorJob, { state: "failed" }> {
  const text = responseText(input.body);
  const common = input.vendorJobId ? { vendorJobId: input.vendorJobId } : {};
  if (input.status === 401 || input.status === 403) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "Vidu credentials were rejected.",
    };
  }
  if (input.status === 429 || /quota|credit|balance|rate.?limit|余额|配额|欠费/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "Vidu quota or rate capacity is unavailable.",
    };
  }
  if (/sensitive|moderation|policy|violat|审核|敏感|违规/iu.test(text)) {
    return {
      state: "failed",
      ...common,
      reason: "content_blocked",
      message: "Vidu content policy rejected the request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: input.phase === "submit" ? "vendor_rejected" : "vendor_failed",
    message:
      input.phase === "submit"
        ? "Vidu rejected the documented create request."
        : "The Vidu task could not be reconciled.",
  };
}
