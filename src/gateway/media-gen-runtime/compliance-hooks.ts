import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeLabeler,
  MediaGenRuntimeModeration,
  MediaGenRuntimeVendorOutput,
} from "./types.js";

export type ComplianceHookOptions = {
  moderationUrl?: string;
  labelingUrl?: string;
  token?: string;
  fetchImpl?: MediaGenRuntimeFetch;
};

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function postJson(
  fetchImpl: MediaGenRuntimeFetch,
  url: string,
  body: unknown,
  token?: string,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`compliance hook returned ${res.status}`);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function createWebhookModeration(
  options: ComplianceHookOptions,
): MediaGenRuntimeModeration | undefined {
  if (!options.moderationUrl) return undefined;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async screenInput(input) {
      const json = await postJson(
        fetchImpl,
        options.moderationUrl!,
        { phase: "input", ...input },
        options.token,
      );
      return {
        allowed: json.allowed === true,
        reason: typeof json.reason === "string" ? json.reason : undefined,
      };
    },
    async screenOutput(input) {
      const json = await postJson(
        fetchImpl,
        options.moderationUrl!,
        { phase: "output", ...input },
        options.token,
      );
      return {
        allowed: json.allowed === true,
        reason: typeof json.reason === "string" ? json.reason : undefined,
      };
    },
  };
}

export function createWebhookLabeler(
  options: ComplianceHookOptions,
): MediaGenRuntimeLabeler | undefined {
  if (!options.labelingUrl) return undefined;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async applyLabel(input: MediaGenRuntimeVendorOutput) {
      const json = await postJson(
        fetchImpl,
        options.labelingUrl!,
        {
          mediaRef: input.mediaRef,
          mimeType: input.mimeType,
          durationSec: input.durationSec,
          resolution: input.resolution,
        },
        options.token,
      );
      return {
        ...input,
        mediaRef: typeof json.mediaRef === "string" ? json.mediaRef : input.mediaRef,
        mimeType: typeof json.mimeType === "string" ? json.mimeType : input.mimeType,
        applied: json.applied === true,
      };
    },
  };
}
