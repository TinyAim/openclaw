import { providerObservation } from "./provider-observation.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeVendorInput,
  MediaGenRuntimeVendorJob,
} from "./types.js";
import {
  compileViduQ1T2vRequest,
  VIDU_Q1_T2V_ADAPTER_REVISION,
  VIDU_Q1_T2V_ROUTE_ID,
} from "./vidu-q1-text2video-compiler.js";

export const VIDU_Q1_T2V_JOB_PREFIX = "text2video-q1:";

export type ViduQ1T2vCreateResponse = {
  task_id?: unknown;
  code?: unknown;
  reason?: unknown;
  message?: unknown;
};

type Failure = Pick<Extract<MediaGenRuntimeVendorJob, { state: "failed" }>, "reason" | "message">;

export async function submitViduQ1T2v(input: {
  request: MediaGenRuntimeVendorInput;
  baseUrl: string;
  fetchImpl: MediaGenRuntimeFetch;
  headers: Record<string, string>;
  now: () => Date;
  normalizeFailure: (status: number, body: ViduQ1T2vCreateResponse | null) => Failure;
}): Promise<MediaGenRuntimeVendorJob> {
  const compiled = compileViduQ1T2vRequest(input.request);
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
      routeId: VIDU_Q1_T2V_ROUTE_ID,
      adapterRevision: VIDU_Q1_T2V_ADAPTER_REVISION,
      operation: "submit",
      outcome,
      startedAtMs,
      finishedAt: input.now(),
    }),
  });

  let response: Response;
  try {
    response = await input.fetchImpl(`${input.baseUrl}/text2video`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(compiled.body),
    });
  } catch {
    return observed(
      {
        state: "submission_unknown",
        message: "Vidu create may have been accepted; reconciliation is required.",
        providerRequestDigest: compiled.providerRequestDigest,
      },
      "submission_unknown",
    );
  }

  const json = (await response.json().catch(() => null)) as ViduQ1T2vCreateResponse | null;
  if (!response.ok) {
    return observed(
      {
        state: "failed",
        ...input.normalizeFailure(response.status, json),
        providerRequestDigest: compiled.providerRequestDigest,
      },
      "failed",
    );
  }
  const taskId = typeof json?.task_id === "string" ? json.task_id.trim() : "";
  if (!taskId) {
    return observed(
      {
        state: "submission_unknown",
        message: "Vidu create returned no durable task receipt; reconciliation is required.",
        providerRequestDigest: compiled.providerRequestDigest,
      },
      "submission_unknown",
    );
  }
  return observed(
    {
      state: "processing",
      vendorJobId: `${VIDU_Q1_T2V_JOB_PREFIX}${taskId}`,
      providerRequestDigest: compiled.providerRequestDigest,
    },
    "processing",
  );
}
