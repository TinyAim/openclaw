import type { ImageRouteExecutor } from "./image-http.js";
import {
  imageCredentialBindingDigest,
  imageDigest,
  type ImageRouteConfiguration,
  type MediaGenRuntimeImageRoute,
  type ProtectedImageCredential,
} from "./image-route-config.js";

// Synthetic Domain D identity. No fixture reads an operator config or auth store.
export function protectedImageConfiguration(): ImageRouteConfiguration {
  return {
    binding: {
      schemaVersion: 1,
      presetId: "image-route-1",
      mediaClass: "image",
      generationScenario: "text_to_image",
      route: {
        schemaVersion: 1,
        providerId: "openai",
        modelId: "gpt-image-1.5",
        routeId: "route-1",
        endpointId: "images.generate",
        region: "global",
        accountTier: "standard",
      },
      profile: { profileId: "profile-1", revision: 1, digest: `sha256:${"a".repeat(64)}` },
      adapterRevision: "adapter-1",
      supportedOperations: ["submit", "poll", "cancel", "retry", "reconcile"],
      supportedOutputFormats: ["png"],
      supportedOutputResolutions: ["1024x1024"],
    },
    outputSupport: {
      alphaPolicies: ["forbid"],
      qualityIntents: ["high"],
      transparentPixelRequirements: ["forbid"],
      backgroundSemanticRequirements: ["opaque"],
      trustedBackgroundEvaluator: false,
    },
  };
}

export function protectedImageCredential(
  configuration = protectedImageConfiguration(),
): ProtectedImageCredential {
  return {
    schemaVersion: 1,
    capabilityDomain: "media_image",
    credentialId: "image-slot-1",
    revision: 7,
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    subjectUserId: "user-1",
    runtimeId: "runtime-1",
    runtimePairRouteId: "pair-1",
    runtimePairRouteRevision: 3,
    runtimeHostInstanceId: "host-1",
    bindingDigest: imageDigest(configuration.binding),
    baseUrl: "https://images.example.test/v1",
    apiKey: "synthetic-domain-d-image-key",
  };
}

export function protectedImageEnv(
  stateDir: string,
  configuration = protectedImageConfiguration(),
  credential = protectedImageCredential(configuration),
): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_MEDIA_GEN_RUNTIME_EXECUTOR_ENABLED: "1",
    OPENCLAW_MEDIA_GEN_CONTROL_API_URL: "https://control.example.test",
    OPENCLAW_MEDIA_GEN_RUNTIME_ID: "runtime-1",
    OPENCLAW_MEDIA_GEN_RUNTIME_TOKEN: "synthetic-registration-token",
    OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "workspace-1,workspace-2",
    OPENCLAW_MEDIA_GEN_IMAGE_EXECUTOR_ENABLED: "1",
    OPENCLAW_MEDIA_GEN_IMAGE_ROUTE_JSON: JSON.stringify(configuration),
    OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON: JSON.stringify(credential),
    OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_BINDING_DIGEST: imageCredentialBindingDigest(credential),
  };
}

export function protectedImageRoute(
  configuration = protectedImageConfiguration(),
): MediaGenRuntimeImageRoute {
  return {
    ...configuration.binding.route,
    adapterRevision: configuration.binding.adapterRevision,
    profileId: configuration.binding.profile.profileId,
    profileRevision: configuration.binding.profile.revision,
    profileDigest: configuration.binding.profile.digest,
    configuration,
  };
}

export function protectedImageDispatch(
  configuration = protectedImageConfiguration(),
  credential = protectedImageCredential(configuration),
): Parameters<ImageRouteExecutor["dispatch"]>[0] {
  const { binding, outputSupport } = configuration;
  const runtimeTarget = {
    runtimeId: credential.runtimeId,
    runtimePairRouteId: credential.runtimePairRouteId,
    runtimePairRouteRevision: credential.runtimePairRouteRevision,
    runtimeHostInstanceId: credential.runtimeHostInstanceId,
  };
  const output = {
    width: 1024,
    height: 1024,
    reducedAspectRatio: "1:1",
    format: "png",
    alphaPolicy: "forbid",
    qualityIntent: "high",
    transparentPixelRequirement: "forbid",
    backgroundSemanticRequirement: "opaque",
    capabilityProfileRevision: `${binding.profile.profileId}:${binding.profile.revision}:${binding.profile.digest}`,
    adapterRevision: binding.adapterRevision,
    compilerRevision: "media-text-to-image-v4/v1",
  };
  const plan = {
    schemaVersion: 4,
    previewId: "preview-1",
    presetId: binding.presetId,
    mediaClass: "image",
    generationScenario: "text_to_image",
    generationIntent: {
      schemaVersion: 1,
      identity: { projectId: "project-1" },
      generationScenario: "text_to_image",
      compiledPrompt: "a product still life",
      references: [],
      operations: [],
      preserveConstraints: [],
      requestedOutput: {},
      resolvedOutput: output,
      compiledSourceDigests: {
        capabilityProfileDigest: binding.profile.digest,
        routePlanDigest: imageDigest(binding.route),
        adapterRevisionDigest: imageDigest(binding.adapterRevision),
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: "image-intent-v1:test",
    providerRouteRef: binding.route,
    capabilityProfileRef: binding.profile,
    adapterRevision: binding.adapterRevision,
    runtimeRef: { ...runtimeTarget, lastSeenAt: "2026-10-16T00:00:00.000Z" },
    constraintPlan: [
      "mediaClass",
      "generationScenario",
      "compiledPrompt",
      ...[
        "width",
        "height",
        "reducedAspectRatio",
        "format",
        "alphaPolicy",
        "transparentPixelRequirement",
        "backgroundSemanticRequirement",
        "qualityIntent",
      ].map((key) => `resolvedOutput.${key}`),
    ].map((intentPath) => ({
      intentPath,
      required: true,
      support: intentPath === "compiledPrompt" ? "prompt" : "native",
    })),
    inputFingerprint: "b".repeat(64),
    intentFingerprint: "c".repeat(64),
    resolvedPreservePlanDigest: `sha256:${"d".repeat(64)}`,
    resolvedReferenceBindingDigest: `sha256:${"e".repeat(64)}`,
    resolvedOutputSpecDigest: imageDigest(output),
    adapterCompilationDigest: imageDigest({
      compiler: "media-text-to-image-v4/v1",
      scope: {
        tenantId: credential.tenantId,
        workspaceId: credential.workspaceId,
        userId: credential.subjectUserId,
      },
      binding,
      runtimeTarget,
      credentialBindingDigest: imageDigest({
        schemaVersion: 1,
        credentialBindingRevision: credential.revision,
        credentialBindingDigest: imageCredentialBindingDigest(credential),
      }),
      outputSupport,
    }),
  };
  return {
    schemaVersion: 2,
    op: "submit",
    taskId: "task-1",
    workspaceId: credential.workspaceId,
    correlationId: "corr-1",
    presetId: binding.presetId,
    mediaClass: "image",
    frozenImagePlan: plan,
    frozenPlanDigest: imageDigest(plan),
    executionAttempt: 1,
  };
}

// Synthetic auth profile discovery passed only to the actual plugin provider
// from test files; core test support never imports a private plugin module.
export const protectedImageModelAuth = {
  ensureAuthProfileStore: () => ({ version: 1 as const, profiles: {} }),
  listProfilesForProvider: () => [],
  isProviderApiKeyConfigured: () => false,
};
