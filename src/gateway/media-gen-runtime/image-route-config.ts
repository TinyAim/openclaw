import { createHash } from "node:crypto";
import { isRecord } from "../media-gen-runtime-dispatch.js";

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
export const IMAGE_OPERATIONS = ["submit", "poll", "cancel", "retry", "reconcile"] as const;

// Wire mirrors of the existing image-only public contracts, never video modes.
export type ImageCapabilityBinding = {
  schemaVersion: 1;
  presetId: string;
  mediaClass: "image";
  generationScenario: "text_to_image";
  route: {
    schemaVersion: 1;
    providerId: string;
    modelId: string;
    routeId: string;
    endpointId: string;
    region: string;
    accountTier: string;
  };
  profile: { profileId: string; revision: number; digest: string };
  adapterRevision: string;
  supportedOperations: readonly (typeof IMAGE_OPERATIONS)[number][];
  supportedOutputFormats: readonly ("png" | "jpeg" | "webp")[];
  supportedOutputResolutions: readonly string[];
};

export type ImageOutputSupport = {
  alphaPolicies: readonly ("forbid" | "allow" | "require")[];
  qualityIntents: readonly ("draft" | "standard" | "high")[];
  transparentPixelRequirements: readonly ("none" | "require" | "forbid")[];
  backgroundSemanticRequirements: readonly ("none" | "opaque" | "transparent_strict")[];
  trustedBackgroundEvaluator: boolean;
};

export type ProtectedImageCredential = {
  schemaVersion: 1;
  capabilityDomain: "media_image";
  credentialId: string;
  revision: number;
  tenantId: string;
  workspaceId: string;
  subjectUserId: string;
  runtimeId: string;
  runtimePairRouteId: string;
  runtimePairRouteRevision: number;
  runtimeHostInstanceId: string;
  bindingDigest: string;
  baseUrl: string;
  apiKey: string;
};

export type ImageRouteConfiguration = {
  binding: ImageCapabilityBinding;
  outputSupport: ImageOutputSupport;
};

export type MediaGenRuntimeImageRoute = {
  providerId: string;
  modelId: string;
  routeId: string;
  endpointId: string;
  region: string;
  accountTier: string;
  adapterRevision: string;
  profileId: string;
  profileRevision: number;
  profileDigest: string;
  /** Required by production admission; older receipts may still be reconciled. */
  configuration?: ImageRouteConfiguration;
};

export function imageStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(imageStableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${imageStableJson(object[key])}`)
    .join(",")}}`;
}

export function imageDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(imageStableJson(value)).digest("hex")}`;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function token(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value);
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function list<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    new Set(value).size === value.length &&
    value.every((item) => allowed.includes(item))
  );
}

export function parseImageRouteConfiguration(raw: unknown): ImageRouteConfiguration | undefined {
  if (!isRecord(raw) || !exact(raw, ["binding", "outputSupport"])) return;
  const binding = raw.binding;
  const support = raw.outputSupport;
  if (
    !isRecord(binding) ||
    !isRecord(support) ||
    !exact(binding, [
      "schemaVersion",
      "presetId",
      "mediaClass",
      "generationScenario",
      "route",
      "profile",
      "adapterRevision",
      "supportedOperations",
      "supportedOutputFormats",
      "supportedOutputResolutions",
    ]) ||
    binding.schemaVersion !== 1 ||
    !token(binding.presetId) ||
    binding.mediaClass !== "image" ||
    binding.generationScenario !== "text_to_image" ||
    !token(binding.adapterRevision)
  )
    return;
  const route = binding.route;
  const profile = binding.profile;
  const routeKeys = ["providerId", "modelId", "routeId", "endpointId", "region", "accountTier"];
  if (
    !isRecord(route) ||
    !exact(route, ["schemaVersion", ...routeKeys]) ||
    route.schemaVersion !== 1 ||
    routeKeys.some((key) => !token(route[key])) ||
    !isRecord(profile) ||
    !exact(profile, ["profileId", "revision", "digest"]) ||
    !token(profile.profileId) ||
    !revision(profile.revision) ||
    typeof profile.digest !== "string" ||
    !SHA256.test(profile.digest) ||
    !list(binding.supportedOperations, IMAGE_OPERATIONS) ||
    binding.supportedOperations.length !== 5 ||
    !list(binding.supportedOutputFormats, ["png", "jpeg", "webp"]) ||
    !Array.isArray(binding.supportedOutputResolutions) ||
    binding.supportedOutputResolutions.length === 0 ||
    binding.supportedOutputResolutions.length > 64 ||
    new Set(binding.supportedOutputResolutions).size !==
      binding.supportedOutputResolutions.length ||
    binding.supportedOutputResolutions.some((value) => {
      if (typeof value !== "string") return true;
      const match = /^(\d{1,5})x(\d{1,5})$/u.exec(value);
      if (!match) return true;
      const width = Number(match[1]);
      const height = Number(match[2]);
      return (
        width < 1 ||
        height < 1 ||
        width > 32768 ||
        height > 32768 ||
        width * height > 100000000 ||
        value !== `${width}x${height}`
      );
    })
  )
    return;
  if (
    !exact(support, [
      "alphaPolicies",
      "qualityIntents",
      "transparentPixelRequirements",
      "backgroundSemanticRequirements",
      "trustedBackgroundEvaluator",
    ]) ||
    !list(support.alphaPolicies, ["forbid", "allow", "require"]) ||
    !list(support.qualityIntents, ["draft", "standard", "high"]) ||
    !list(support.transparentPixelRequirements, ["none", "require", "forbid"]) ||
    !list(support.backgroundSemanticRequirements, ["none", "opaque", "transparent_strict"]) ||
    typeof support.trustedBackgroundEvaluator !== "boolean" ||
    (support.backgroundSemanticRequirements.includes("transparent_strict") &&
      !support.trustedBackgroundEvaluator)
  )
    return;
  return raw as unknown as ImageRouteConfiguration;
}

export function parseImageRoute(
  env: NodeJS.ProcessEnv,
): MediaGenRuntimeImageRoute | null | undefined {
  if (!/^(1|true|yes|on)$/iu.test(env.OPENCLAW_MEDIA_GEN_IMAGE_EXECUTOR_ENABLED?.trim() ?? ""))
    return;
  try {
    if (Buffer.byteLength(env.OPENCLAW_MEDIA_GEN_IMAGE_ROUTE_JSON ?? "", "utf8") > 131072)
      return null;
    const configuration = parseImageRouteConfiguration(
      JSON.parse(env.OPENCLAW_MEDIA_GEN_IMAGE_ROUTE_JSON ?? ""),
    );
    if (!configuration) return null;
    const { binding } = configuration;
    return {
      ...binding.route,
      adapterRevision: binding.adapterRevision,
      profileId: binding.profile.profileId,
      profileRevision: binding.profile.revision,
      profileDigest: binding.profile.digest,
      configuration,
    };
  } catch {
    return null;
  }
}

/** Digest the actual protected slot identity/revision, never its secret bytes. */
export function imageCredentialBindingDigest(credential: ProtectedImageCredential): string {
  const { apiKey: _apiKey, ...metadata } = credential;
  return imageDigest(metadata);
}

export function readProtectedImageCredential(
  env: NodeJS.ProcessEnv,
  runtimeId: string,
  configuration: ImageRouteConfiguration,
): ProtectedImageCredential | undefined {
  try {
    if (Buffer.byteLength(env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON ?? "", "utf8") > 32768)
      return;
    const value: unknown = JSON.parse(env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON ?? "");
    const tokenKeys = [
      "credentialId",
      "tenantId",
      "workspaceId",
      "subjectUserId",
      "runtimeId",
      "runtimePairRouteId",
      "runtimeHostInstanceId",
    ];
    if (
      !isRecord(value) ||
      !exact(value, [
        "schemaVersion",
        "capabilityDomain",
        ...tokenKeys,
        "revision",
        "runtimePairRouteRevision",
        "bindingDigest",
        "baseUrl",
        "apiKey",
      ]) ||
      value.schemaVersion !== 1 ||
      value.capabilityDomain !== "media_image" ||
      tokenKeys.some((key) => !token(value[key])) ||
      !revision(value.revision) ||
      !revision(value.runtimePairRouteRevision) ||
      value.runtimeId !== runtimeId ||
      value.bindingDigest !== imageDigest(configuration.binding) ||
      !(env.OPENCLAW_MEDIA_GEN_WORKSPACE_IDS ?? "")
        .split(/[,\s;]+/u)
        .includes(String(value.workspaceId)) ||
      typeof value.apiKey !== "string" ||
      value.apiKey.trim() !== value.apiKey ||
      value.apiKey.length === 0 ||
      value.apiKey.length > 16384 ||
      /[\r\n]/u.test(value.apiKey) ||
      typeof value.baseUrl !== "string"
    )
      return;
    const url = new URL(value.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.baseUrl.trim() !== value.baseUrl ||
      /[\r\n]/u.test(value.baseUrl)
    )
      return;
    const credential = value as ProtectedImageCredential;
    if (
      env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_BINDING_DIGEST !==
      imageCredentialBindingDigest(credential)
    )
      return;
    return credential;
  } catch {
    return;
  }
}
