import type { MediaGenRuntimeFetch } from "./types.js";

/** Query-only recovery: a missing, ambiguous or malformed result never permits a new POST. */
export async function lookupKlingExternalCorrelation(input: {
  baseUrl: string;
  apiKey: string;
  externalTaskId: string;
  fetchImpl: MediaGenRuntimeFetch;
}): Promise<{ status: "matched"; vendorJobId: string } | { status: "unknown" }> {
  if (!/^wis_[a-f0-9]{32}$/u.test(input.externalTaskId) || !input.apiKey.trim())
    return { status: "unknown" };
  let response: Response;
  try {
    response = await input.fetchImpl(
      `${input.baseUrl.replace(/\/+$/u, "")}/tasks?external_task_ids=${encodeURIComponent(input.externalTaskId)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.apiKey.trim()}`,
          "content-type": "application/json",
        },
      },
    );
  } catch {
    return { status: "unknown" };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { status: "unknown" };
  }
  if (!response.ok || !value || typeof value !== "object" || Array.isArray(value))
    return { status: "unknown" };
  const envelope = value as Record<string, unknown>;
  if (envelope.code !== 0 || !Array.isArray(envelope.data)) return { status: "unknown" };
  const matches = envelope.data.filter(
    (entry: unknown) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).external_id === input.externalTaskId,
  );
  if (matches.length !== 1) return { status: "unknown" };
  const id = (matches[0] as Record<string, unknown>).id;
  if (typeof id !== "string" || !id.trim() || id !== id.trim()) return { status: "unknown" };
  return { status: "matched", vendorJobId: id };
}
