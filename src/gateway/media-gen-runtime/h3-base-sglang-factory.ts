import { tmpdir } from "node:os";
import path from "node:path";
import type { H3BaseSglangProfilePin, H3BaseSglangVariant } from "./h3-base-sglang-compiler.js";
import {
  createH3BaseSglangRuntimeVendor,
  H3_BASE_SGLANG_SCHEMA_REVISION,
  normalizeH3BaseSglangBaseUrl,
  normalizeH3BaseStagingDir,
} from "./h3-base-sglang-vendor.js";
import type {
  MediaGenRuntimeFetch,
  MediaGenRuntimeModelServingClaim,
  MediaGenRuntimeVendor,
} from "./types.js";

type RuntimeEnv = Record<string, string | undefined>;

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_SERVING_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,299}$/u;
const PROFILE_PIN_KEYS = new Set(["profileId", "revision", "digest"]);
const VARIANT_CONFIG = {
  fl2va: {
    profileIds: {
      text_to_video: "hailuo.openclaw-runtime.h3_base_fl2va.text2video.v1",
      first_frame_to_video: "hailuo.openclaw-runtime.h3_base_fl2va.image2video.v1",
      last_frame_to_video: "hailuo.openclaw-runtime.h3_base_fl2va.image2video.v1",
      first_last_frame_to_video: "hailuo.openclaw-runtime.h3_base_fl2va.image2video.v1",
    },
  },
  ref2va: {
    profileIds: {
      multimodal_reference_to_video:
        "hailuo.openclaw-runtime.h3_base_ref2va.multimodal_reference.v1",
    },
  },
} as const;

function envString(env: RuntimeEnv, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function servingStatus(raw: string): MediaGenRuntimeModelServingClaim["status"] | null {
  return (
    (["ready", "loading", "error", "unknown"] as const).find(
      (item) => item === (raw || "unknown"),
    ) ?? null
  );
}

function optionalPositiveInteger(raw: string): number | undefined | null {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseProfilePins(
  raw: string,
  expected: Readonly<Record<string, string>>,
): Readonly<Partial<Record<string, H3BaseSglangProfilePin>>> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const expectedKeys = Object.keys(expected).sort();
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) return null;

    const result: Partial<Record<string, H3BaseSglangProfilePin>> = {};
    for (const scenario of expectedKeys) {
      const value = record[scenario];
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const pin = value as Record<string, unknown>;
      if (Object.keys(pin).some((key) => !PROFILE_PIN_KEYS.has(key))) return null;
      if (
        pin.profileId !== expected[scenario] ||
        !Number.isSafeInteger(pin.revision) ||
        Number(pin.revision) <= 0 ||
        typeof pin.digest !== "string" ||
        !SHA256_DIGEST.test(pin.digest)
      ) {
        return null;
      }
      result[scenario] = {
        profileId: pin.profileId,
        revision: Number(pin.revision),
        digest: pin.digest,
      };
    }
    return result;
  } catch {
    return null;
  }
}

function variantDeclared(env: RuntimeEnv, variant: H3BaseSglangVariant): boolean {
  const marker = `OPENCLAW_H3_BASE_${variant.toUpperCase()}_`;
  return Object.entries(env).some(
    ([key, value]) => key.startsWith(marker) && Boolean(value?.trim()),
  );
}

export function createH3BaseSglangVendors(
  env: RuntimeEnv,
  fetchImpl?: MediaGenRuntimeFetch,
): { vendors: MediaGenRuntimeVendor[]; error?: string } {
  const declared = (["fl2va", "ref2va"] as const).filter((variant) =>
    variantDeclared(env, variant),
  );
  const globalDeclared = Object.entries(env).some(
    ([key, value]) => key.startsWith("OPENCLAW_H3_BASE_") && Boolean(value?.trim()),
  );
  if (!globalDeclared) return { vendors: [] };
  if (declared.length === 0) {
    return {
      vendors: [],
      error: "H3 Base configuration declares no FL2VA or Ref2VA model pack",
    };
  }

  const vendors: MediaGenRuntimeVendor[] = [];
  for (const variant of declared) {
    const prefix = `OPENCLAW_H3_BASE_${variant.toUpperCase()}`;
    const baseUrl =
      envString(env, `${prefix}_SGLANG_URL`, "OPENCLAW_H3_BASE_SGLANG_URL") ||
      "http://127.0.0.1:30000";
    const authToken =
      envString(env, `${prefix}_SGLANG_TOKEN`, "OPENCLAW_H3_BASE_SGLANG_TOKEN") || undefined;
    const servingEngineVersion = envString(
      env,
      `${prefix}_SGLANG_VERSION`,
      "OPENCLAW_H3_BASE_SGLANG_VERSION",
    );
    const checkpointRevision = envString(env, `${prefix}_CHECKPOINT_REVISION`);
    const checkpointDigest = envString(env, `${prefix}_CHECKPOINT_DIGEST`);
    const profilePins = parseProfilePins(
      envString(env, `${prefix}_PROFILE_REFS_JSON`),
      VARIANT_CONFIG[variant].profileIds,
    );
    const status = servingStatus(envString(env, `${prefix}_STATUS`) || "unknown");
    const maxConcurrentJobs = optionalPositiveInteger(
      envString(env, `${prefix}_MAX_CONCURRENT_JOBS`),
    );
    const precision = envString(env, `${prefix}_PRECISION`) || undefined;
    const stagingDir = normalizeH3BaseStagingDir(
      envString(env, `${prefix}_STAGING_DIR`, "OPENCLAW_H3_BASE_STAGING_DIR") ||
        path.join(tmpdir(), "wisclaw-media-gen-h3", variant),
    );
    if (
      !normalizeH3BaseSglangBaseUrl(baseUrl, authToken) ||
      servingEngineVersion !== H3_BASE_SGLANG_SCHEMA_REVISION ||
      !SAFE_SERVING_TOKEN.test(checkpointRevision) ||
      !SHA256_DIGEST.test(checkpointDigest) ||
      !profilePins ||
      !status ||
      maxConcurrentJobs === null ||
      (precision != null && !SAFE_SERVING_TOKEN.test(precision)) ||
      !stagingDir
    ) {
      return {
        vendors: [],
        error: `private H3 Base ${variant} identity, endpoint, checkpoint, profile pins, or status is invalid`,
      };
    }

    vendors.push(
      createH3BaseSglangRuntimeVendor({
        variant,
        baseUrl,
        authToken,
        servingEngineVersion,
        checkpointRevision,
        checkpointDigest,
        precision,
        status,
        maxConcurrentJobs,
        profilesByScenario: profilePins,
        stagingDir,
        fetchImpl,
      }),
    );
  }
  return { vendors };
}
