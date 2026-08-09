import {
  compileKlingT2vV2Request,
  KLING_T2V_V2_ADAPTER_REVISION,
  KLING_T2V_V2_ROUTE_ID,
} from "./kling-text2video-v2-compiler.js";
import { providerObservation } from "./provider-observation.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendorInput,
  MediaGenRuntimeVendorJob,
} from "./types.js";

type Failure = Pick<Extract<MediaGenRuntimeVendorJob, { state: "failed" }>, "reason" | "message">;

export async function submitKlingT2vV2(input: {
  request: MediaGenRuntimeVendorInput;
  baseUrl: string;
  fetchImpl: MediaGenRuntimeFetch;
  headers: Record<string, string>;
  now: () => Date;
  normalizeFailure: (status: number, message: string | undefined) => Failure;
}): Promise<MediaGenRuntimeVendorJob> {
  const compiled = compileKlingT2vV2Request(input.request);
  if (!compiled.ok) {
    return {
      state: "failed",
      reason: "vendor_rejected",
      message: compiled.message,
    };
  }
  const startedAtMs = input.now().getTime();
  const observed = (
    job: MediaGenRuntimeVendorJob,
    outcome: "processing" | "failed" | "submission_unknown",
  ): MediaGenRuntimeVendorJob => ({
    ...job,
    providerObservation: providerObservation({
      routeId: KLING_T2V_V2_ROUTE_ID,
      adapterRevision: KLING_T2V_V2_ADAPTER_REVISION,
      operation: "submit",
      outcome,
      startedAtMs,
      finishedAt: input.now(),
    }),
  });

  let response: Response;
  try {
    response = await input.fetchImpl(`${input.baseUrl}/v1/videos/text2video`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(compiled.body),
    });
  } catch {
    return observed(
      {
        state: "submission_unknown",
        message: "Kling create may have been accepted; reconciliation is required.",
        providerRequestDigest: compiled.providerRequestDigest,
      },
      "submission_unknown",
    );
  }

  const json = (await response.json().catch(() => null)) as KlingCreateResponse | null;
  if (!response.ok || !json || json.code !== 0) {
    return observed(
      {
        state: "failed",
        ...input.normalizeFailure(response.status, json?.message),
        providerRequestDigest: compiled.providerRequestDigest,
      },
      "failed",
    );
  }
  const taskId = json.data?.task_id;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    return observed(
      {
        state: "submission_unknown",
        message: "Kling create returned no durable task receipt; reconciliation is required.",
        providerRequestDigest: compiled.providerRequestDigest,
      },
      "submission_unknown",
    );
  }
  return observed(
    {
      state: "processing",
      vendorJobId: `text2video-v2:${taskId}`,
      providerRequestDigest: compiled.providerRequestDigest,
    },
    "processing",
  );
}

type KlingCreateResponse = {
  code?: number;
  message?: string;
  data?: { task_id?: string };
};
