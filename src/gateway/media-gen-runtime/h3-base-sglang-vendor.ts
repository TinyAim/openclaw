import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileH3BaseSglangRequest,
  H3_BASE_ACCOUNT_TIER,
  H3_BASE_ENDPOINT_ID,
  H3_BASE_PROVIDER_ID,
  H3_BASE_REGION,
  H3_BASE_ROUTE_MODEL_ID,
  type H3BaseSglangProfilePin,
  type H3BaseSglangVariant,
} from "./h3-base-sglang-compiler.js";
import {
  providerObservation,
  type MediaGenProviderRuntimeOperation,
  type MediaGenProviderRuntimeOutcome,
} from "./provider-observation.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeModelServingClaim,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorJob,
} from "./types.js";

export const H3_BASE_FL2VA_ROUTE_ID = "hailuo.h3_base.fl2va.selfhosted.sglang_v1";
export const H3_BASE_REF2VA_ROUTE_ID = "hailuo.h3_base.ref2va.selfhosted.sglang_v1";
export const H3_BASE_FL2VA_ADAPTER_REVISION = "openclaw-hailuo-h3-base-fl2va-runtime/v1";
export const H3_BASE_REF2VA_ADAPTER_REVISION = "openclaw-hailuo-h3-base-ref2va-runtime/v1";
export const H3_BASE_SGLANG_SCHEMA_REVISION = "14ffd447a4bc431c67e33e1743e076e0f53780c8";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._~-]{0,199}$/u;
const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u;
const SERVING_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,299}$/u;
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type H3BaseSglangRuntimeVendorOptions = {
  variant: H3BaseSglangVariant;
  baseUrl: string;
  authToken?: string;
  servingEngineVersion: string;
  checkpointRevision: string;
  checkpointDigest: string;
  precision?: string;
  status: MediaGenRuntimeModelServingClaim["status"];
  maxConcurrentJobs?: number;
  profilesByScenario: Readonly<Partial<Record<string, H3BaseSglangProfilePin>>>;
  stagingDir: string;
  fetchImpl?: MediaGenRuntimeFetch;
  now?: () => Date;
};

function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
}

function loopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  return host.split(".").map(Number)[0] === 127;
}

/**
 * Closed endpoint policy for the file-backed v1 adapter: loopback only.
 * Reference conditions are materialized as server-local file:// URIs, so a
 * split-host endpoint would be structurally unable to read them without a new
 * authenticated material transport and therefore needs a new exact route.
 */
export function normalizeH3BaseSglangBaseUrl(raw: string, _authToken?: string): string | null {
  try {
    const url = new URL(raw);
    const host = bareHostname(url);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
      return null;
    if (loopback(host) && (url.protocol === "http:" || url.protocol === "https:")) {
      return url.origin;
    }
    return null;
  } catch {
    return null;
  }
}

/** Absolute dedicated leaf only; parent traversal and filesystem roots fail closed. */
export function normalizeH3BaseStagingDir(raw: string): string | null {
  if (!raw || raw !== raw.trim() || raw.includes("\0") || !path.isAbsolute(raw)) {
    return null;
  }
  if (raw.split(/[\\/]/u).includes("..")) return null;
  const normalized = path.normalize(raw);
  return normalized === path.parse(normalized).root ? null : normalized;
}

function authHeaders(token?: string): Record<string, string> {
  return token?.trim() ? { authorization: `Bearer ${token.trim()}` } : {};
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...authHeaders(token),
  };
}

function errorMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  if (typeof record.detail === "string") return record.detail;
  const error = record.error;
  return error &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>).message === "string"
    ? String((error as Record<string, unknown>).message)
    : "";
}

function failure(status: number, body: unknown, vendorJobId?: string): MediaGenRuntimeVendorJob {
  const message = errorMessage(body);
  const common = vendorJobId ? { vendorJobId } : {};
  if (status === 401 || status === 403) {
    return {
      state: "failed",
      ...common,
      reason: "auth",
      message: "Local SGLang authorization failed.",
    };
  }
  if (status === 409 || status === 429 || /concurr|capacity|busy/iu.test(message)) {
    return {
      state: "failed",
      ...common,
      reason: "quota",
      message: "Local SGLang GPU capacity is unavailable.",
    };
  }
  if (status === 400 || status === 413 || status === 422) {
    return {
      state: "failed",
      ...common,
      reason: "vendor_rejected",
      message: "Local SGLang rejected the frozen H3 request.",
    };
  }
  return {
    state: "failed",
    ...common,
    reason: "vendor_failed",
    message: "Local SGLang H3 execution failed.",
  };
}

function extension(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "video/quicktime") return ".mov";
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return ".wav";
  return ".jpg";
}

function exactProfilePins(pins: H3BaseSglangRuntimeVendorOptions["profilesByScenario"]): boolean {
  const values = Object.values(pins);
  return (
    values.length > 0 &&
    values.every((pin) =>
      Boolean(
        pin &&
        PROFILE_ID.test(pin.profileId) &&
        Number.isSafeInteger(pin.revision) &&
        pin.revision > 0 &&
        SHA.test(pin.digest),
      ),
    )
  );
}

export function createH3BaseSglangRuntimeVendor(
  options: H3BaseSglangRuntimeVendorOptions,
): MediaGenRuntimeVendor {
  const baseUrl = normalizeH3BaseSglangBaseUrl(options.baseUrl, options.authToken);
  const stagingDir = normalizeH3BaseStagingDir(options.stagingDir);
  const routeId = options.variant === "fl2va" ? H3_BASE_FL2VA_ROUTE_ID : H3_BASE_REF2VA_ROUTE_ID;
  const adapterRevision =
    options.variant === "fl2va" ? H3_BASE_FL2VA_ADAPTER_REVISION : H3_BASE_REF2VA_ADAPTER_REVISION;
  const identityConfigured = Boolean(
    baseUrl &&
    options.servingEngineVersion === H3_BASE_SGLANG_SCHEMA_REVISION &&
    SERVING_TOKEN.test(options.checkpointRevision.trim()) &&
    SHA.test(options.checkpointDigest) &&
    (!options.precision || SERVING_TOKEN.test(options.precision.trim())) &&
    stagingDir &&
    exactProfilePins(options.profilesByScenario),
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const stagedByJob = new Map<string, string[]>();
  const stagedByTask = new Map<string, string[]>();

  const observation = (
    job: MediaGenRuntimeVendorJob,
    operation: MediaGenProviderRuntimeOperation,
    outcome: MediaGenProviderRuntimeOutcome,
    startedAtMs: number,
  ): MediaGenRuntimeVendorJob => ({
    ...job,
    providerObservation: providerObservation({
      routeId,
      adapterRevision,
      operation,
      outcome,
      startedAtMs,
      finishedAt: now(),
    }),
  });

  async function cleanup(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((item) => rm(item, { force: true }).catch(() => undefined)));
  }

  async function ensureStagingDir(): Promise<void> {
    if (!stagingDir) throw new Error("private H3 staging path is invalid");
    const created = await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    if (created) await chmod(stagingDir, 0o700);
    const info = await lstat(stagingDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("private H3 staging path is not an owner directory");
    }
    if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) {
      throw new Error("private H3 staging directory has the wrong owner");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("private H3 staging directory is not owner-only");
    }
  }

  async function pruneStale(): Promise<void> {
    await ensureStagingDir();
    const names = await readdir(stagingDir!).catch(() => [] as string[]);
    await Promise.all(
      names.map(async (name) => {
        if (!/^h3-[a-f0-9]{32}-\d+\.[a-z0-9]+$/u.test(name)) return;
        const target = path.join(stagingDir!, name);
        const info = await stat(target).catch(() => null);
        if (info && now().getTime() - info.mtimeMs > STAGING_MAX_AGE_MS) {
          await rm(target, { force: true }).catch(() => undefined);
        }
      }),
    );
  }

  async function query(
    vendorJobId: string,
    operation: "poll" | "reconcile",
  ): Promise<MediaGenRuntimeVendorJob> {
    const startedAtMs = now().getTime();
    const observed = (job: MediaGenRuntimeVendorJob, outcome: MediaGenProviderRuntimeOutcome) =>
      observation(job, operation, outcome, startedAtMs);
    if (!baseUrl || !JOB_ID.test(vendorJobId)) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "Local SGLang job id is invalid.",
        },
        "failed",
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/videos/${encodeURIComponent(vendorJobId)}`, {
        method: "GET",
        headers: { accept: "application/json", ...authHeaders(options.authToken) },
      });
    } catch {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) return observed(failure(response.status, body, vendorJobId), "failed");
    if (!body || body.id !== vendorJobId || body.model !== "MiniMaxAI/MiniMax-H3") {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "Local SGLang returned a mismatched H3 receipt.",
        },
        "failed",
      );
    }
    if (["queued", "in_progress", "processing", "running"].includes(String(body.status))) {
      return observed({ state: "processing", vendorJobId }, "processing");
    }
    if (body.status === "failed") {
      await cleanup(stagedByJob.get(vendorJobId) ?? []);
      stagedByJob.delete(vendorJobId);
      return observed(failure(500, body, vendorJobId), "failed");
    }
    if (body.status !== "completed" || body.url != null) {
      return observed(
        {
          state: "failed",
          vendorJobId,
          reason: "vendor_failed",
          message: "Local SGLang returned an unknown or egressing H3 result.",
        },
        "failed",
      );
    }
    await cleanup(stagedByJob.get(vendorJobId) ?? []);
    stagedByJob.delete(vendorJobId);
    const seconds = Number(body.seconds);
    return observed(
      {
        state: "succeeded",
        vendorJobId,
        output: {
          mediaRef: `${baseUrl}/v1/videos/${encodeURIComponent(vendorJobId)}/content`,
          mimeType: "video/mp4",
          ...(Number.isInteger(seconds) && seconds > 0 ? { durationSec: seconds } : {}),
          resolution: "768-short-edge",
          contentHeaders: authHeaders(options.authToken),
          ...(baseUrl.startsWith("http://") ? { allowInsecureLoopback: true } : {}),
        },
      },
      "succeeded",
    );
  }

  const claim: MediaGenRuntimeModelServingClaim = {
    modelId: H3_BASE_ROUTE_MODEL_ID,
    variant: options.variant,
    servingEngine: "sglang",
    servingEngineVersion: options.servingEngineVersion,
    servingProtocol: "sglang_video_v1",
    checkpointRevision: options.checkpointRevision,
    checkpointDigest: options.checkpointDigest,
    ...(options.precision?.trim() ? { precision: options.precision.trim() } : {}),
    status: identityConfigured ? options.status : "error",
    ...(options.maxConcurrentJobs ? { maxConcurrentJobs: options.maxConcurrentJobs } : {}),
  };
  const routeClaims = (
    options.variant === "fl2va" ? ["text2video", "image2video"] : ["image2video"]
  ).map((mode) => ({
    presetId: "hailuo",
    mode: mode as "text2video" | "image2video",
    route: {
      schemaVersion: 1 as const,
      routeId,
      providerId: H3_BASE_PROVIDER_ID,
      modelId: H3_BASE_ROUTE_MODEL_ID,
      endpointId: H3_BASE_ENDPOINT_ID,
      region: H3_BASE_REGION,
      accountTier: H3_BASE_ACCOUNT_TIER,
    },
    adapterRevision,
  }));

  async function liveRegistrationSnapshot() {
    let ready = false;
    if (baseUrl && identityConfigured && options.status === "ready") {
      try {
        const healthResponse = await fetchImpl(`${baseUrl}/health`, {
          method: "GET",
          headers: { accept: "application/json", ...authHeaders(options.authToken) },
          signal: AbortSignal.timeout(5_000),
        });
        // Treat the pinned SGLang health contract as HTTP success only. Its
        // body is not model identity evidence and can vary by entrypoint;
        // exact served-model identity is checked below.
        if (healthResponse.ok) {
          const modelsResponse = await fetchImpl(`${baseUrl}/v1/models`, {
            method: "GET",
            headers: { accept: "application/json", ...authHeaders(options.authToken) },
            signal: AbortSignal.timeout(5_000),
          });
          const modelsBody = (await modelsResponse.json().catch(() => null)) as Record<
            string,
            unknown
          > | null;
          const models = Array.isArray(modelsBody?.data) ? modelsBody.data : [];
          ready =
            modelsResponse.ok &&
            models.some(
              (item) =>
                item !== null &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                (item as Record<string, unknown>).id === "MiniMaxAI/MiniMax-H3",
            );
        }
      } catch {
        ready = false;
      }
    }
    return {
      ...(ready ? { capabilityRouteClaims: routeClaims } : {}),
      modelServingClaims: [
        {
          ...claim,
          status: ready
            ? ("ready" as const)
            : options.status === "loading"
              ? ("loading" as const)
              : options.status === "unknown"
                ? ("unknown" as const)
                : ("error" as const),
        },
      ],
    };
  }

  return {
    presetId: "hailuo",
    trustedOutputHosts: baseUrl ? [new URL(baseUrl).hostname] : [],
    // Dynamic private-model routes are advertised only by the live heartbeat
    // snapshot above. A process-start config value is not route readiness.
    capabilityRouteClaims: undefined,
    modelServingClaims: [claim],
    registrationSnapshot: liveRegistrationSnapshot,
    supportsMultiReference: options.variant === "ref2va" || options.variant === "fl2va",
    requiresFrozenPlan: true,
    isConfigured: () => identityConfigured && options.status === "ready",
    async submit(input): Promise<MediaGenRuntimeVendorJob> {
      if (!baseUrl || !identityConfigured || options.status !== "ready") {
        return {
          state: "failed",
          reason: "vendor_rejected",
          message: "Private H3 Base serving is not exactly configured.",
        };
      }
      try {
        await pruneStale();
      } catch {
        return {
          state: "failed",
          reason: "vendor_rejected",
          message: "Private H3 staging directory is unavailable or not owner-only.",
        };
      }
      const taskHash = createHash("sha256").update(input.taskId).digest("hex").slice(0, 32);
      const staged: string[] = [];
      stagedByTask.set(input.taskId, staged);
      const compiled = await compileH3BaseSglangRequest(input, {
        variant: options.variant,
        routeId,
        adapterRevision,
        profilesByScenario: options.profilesByScenario,
        checkpointDigest: options.checkpointDigest,
        materialize: async ({ source, index }) => {
          if (!source.bytes) throw new Error("bytes required");
          const target = path.join(
            stagingDir!,
            `h3-${taskHash}-${index}${extension(source.mimeType.toLowerCase())}`,
          );
          await writeFile(target, source.bytes, { mode: 0o600, flag: "wx" });
          staged.push(target);
          return pathToFileURL(target).toString();
        },
      });
      if (!compiled.ok) {
        await cleanup(staged);
        stagedByTask.delete(input.taskId);
        return { state: "failed", reason: "vendor_rejected", message: compiled.message };
      }
      const startedAtMs = now().getTime();
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/videos`, {
          method: "POST",
          headers: jsonHeaders(options.authToken),
          body: JSON.stringify(compiled.body),
        });
      } catch {
        return observation(
          {
            state: "submission_unknown",
            message: "Local SGLang create may have been accepted; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          "submit",
          "submission_unknown",
          startedAtMs,
        );
      }
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        await cleanup(staged);
        stagedByTask.delete(input.taskId);
        return observation(
          {
            ...failure(response.status, body),
            providerRequestDigest: compiled.providerRequestDigest,
          },
          "submit",
          "failed",
          startedAtMs,
        );
      }
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!JOB_ID.test(id) || body?.model !== "MiniMaxAI/MiniMax-H3") {
        return observation(
          {
            state: "submission_unknown",
            message:
              "Local SGLang returned no exact durable H3 receipt; reconciliation is required.",
            providerRequestDigest: compiled.providerRequestDigest,
          },
          "submit",
          "submission_unknown",
          startedAtMs,
        );
      }
      stagedByTask.delete(input.taskId);
      stagedByJob.set(id, staged);
      return observation(
        {
          state: "processing",
          vendorJobId: id,
          providerRequestDigest: compiled.providerRequestDigest,
        },
        "submit",
        "processing",
        startedAtMs,
      );
    },
    poll: (vendorJobId) => query(vendorJobId, "poll"),
    reconcile: (vendorJobId) => query(vendorJobId, "reconcile"),
    // SGLang DELETE at the pinned revision removes only the registry record and
    // does not abort GPU work, so cancel is intentionally not advertised.
  };
}
