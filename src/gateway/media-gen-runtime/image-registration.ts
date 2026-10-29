import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertExactImageGenerationOverrides,
  resolveImageGenerationOverrides,
} from "../../image-generation/normalization.js";
import { getImageGenerationProvider } from "../../media-generation/registry.js";
import { resolveApiKeyForProvider } from "../../plugin-sdk/provider-auth-runtime.js";
import { isConstructedImageReceiptStore, parseImageLifecycleReceipt } from "./image-receipt.js";
import {
  imageCredentialBindingDigest,
  imageDigest,
  readProtectedImageCredential,
  type ImageCapabilityBinding,
  type ImageOutputSupport,
  type MediaGenRuntimeImageRoute,
  type ProtectedImageCredential,
} from "./image-route-config.js";

export type ImageExecutionReadinessReceipt = {
  schemaVersion: 1;
  executor: boolean;
  transport: boolean;
  adapter: boolean;
  capability: boolean;
  artifactIngest: boolean;
  terminalReceiptParser: boolean;
  retry: boolean;
  cancellation: boolean;
  revisions: { dispatcherRevision: number; transportRevision: number; adapterRevision: number };
  ready: boolean;
  activeExecutionAllowed: boolean;
  blockers: string[];
  digest: string;
};

export type ImageExecutionEvidence = {
  schemaVersion: 1;
  bindingDigest: string;
  runtimePairRouteId: string;
  runtimePairRouteRevision: number;
  runtimeHostInstanceId: string;
  credentialBindingRevision: number;
  credentialBindingDigest: string;
  outputSupportDigest: string;
  readinessReceipt: ImageExecutionReadinessReceipt;
};

export type ImageRegistrationSnapshot = {
  imageCapabilityBindings: readonly ImageCapabilityBinding[];
  imageExecutionEvidence: readonly ImageExecutionEvidence[];
};

type ProtectedImageExecutionOptions = {
  env: NodeJS.ProcessEnv;
  runtimeId: string;
  route: MediaGenRuntimeImageRoute;
  getConfig: () => OpenClawConfig;
  /** Source witness supplied by the constructed Image executor, not operator JSON. */
  lifecycleSource?: {
    dispatcherRevision: 2;
    terminalReceiptParser: typeof parseImageLifecycleReceipt;
    receiptStore: unknown;
    stopOnly: true;
  };
};

/** Only request-local config and the protected image slot enter provider auth. */
export async function prepareProtectedImageExecution(options: ProtectedImageExecutionOptions) {
  const configuration = options.route.configuration;
  if (!configuration) return;
  const credential = readProtectedImageCredential(options.env, options.runtimeId, configuration);
  if (!credential) return;
  const providerId = configuration.binding.route.providerId;
  // These installed transports consume models.providers.<id>.baseUrl and the
  // supplied auth store. Other plugins need the same source-backed auth proof
  // before this private Domain D path can admit them.
  if (providerId !== "openai" && providerId !== "google") return;
  const cfg: OpenClawConfig = {
    plugins: options.getConfig().plugins,
    models: {
      mode: "replace",
      providers: {
        [providerId]: {
          baseUrl: credential.baseUrl,
          apiKey: credential.apiKey,
          auth: "api-key",
          models: [],
        },
      },
    },
  };
  const authStore: AuthProfileStore = { version: 1, profiles: {} };
  // OpenAI's image transport explicitly uses env-first auth. Check both real
  // resolver policies so ambient chat credentials can never replace this slot.
  for (const credentialPrecedence of ["env-first", "profile-first"] as const) {
    const auth = await resolveApiKeyForProvider({
      provider: providerId,
      cfg,
      store: authStore,
      credentialPrecedence,
      allowAuthProfileFallback: false,
      skipSetupProviderFallback: true,
    });
    if (auth.mode !== "api-key" || auth.apiKey !== credential.apiKey) return;
  }
  const provider = getImageGenerationProvider(providerId, cfg);
  if (
    !provider ||
    provider.id !== providerId ||
    !provider.models?.includes(configuration.binding.route.modelId)
  )
    return;
  // Auth resolution yields. A withdrawn/revised slot must not escape as the
  // old prepared sample and acquire a new Provider effect after that await.
  const current = readProtectedImageCredential(options.env, options.runtimeId, configuration);
  if (
    !current ||
    current.apiKey !== credential.apiKey ||
    imageCredentialBindingDigest(current) !== imageCredentialBindingDigest(credential)
  )
    return;
  return { cfg, authStore, credential, provider, configuration };
}

function exactOutputSupported(
  prepared: NonNullable<Awaited<ReturnType<typeof prepareProtectedImageExecution>>>,
): boolean {
  const { configuration, provider } = prepared;
  const support = configuration.outputSupport;
  // This byte path has no trusted semantic evaluator. Configuration cannot
  // turn that missing implementation into a supported strict-background claim.
  if (
    support.trustedBackgroundEvaluator ||
    support.backgroundSemanticRequirements.includes("transparent_strict")
  )
    return false;
  try {
    for (const size of configuration.binding.supportedOutputResolutions) {
      for (const outputFormat of configuration.binding.supportedOutputFormats) {
        for (const qualityIntent of support.qualityIntents) {
          for (const alphaPolicy of support.alphaPolicies) {
            if (alphaPolicy === "require" && outputFormat === "jpeg") continue;
            const requested = {
              size,
              outputFormat,
              quality:
                qualityIntent === "draft"
                  ? ("low" as const)
                  : qualityIntent === "high"
                    ? ("high" as const)
                    : ("medium" as const),
              background:
                alphaPolicy === "require"
                  ? ("transparent" as const)
                  : alphaPolicy === "forbid"
                    ? ("opaque" as const)
                    : ("auto" as const),
            };
            assertExactImageGenerationOverrides(
              requested,
              resolveImageGenerationOverrides({
                ...requested,
                provider,
                model: configuration.binding.route.modelId,
              }),
            );
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Claims are observations; server-owned profile/route/connector gates still apply. */
export async function collectImageRegistrationSnapshot(
  options: ProtectedImageExecutionOptions,
  workspaceId: string,
): Promise<ImageRegistrationSnapshot> {
  const configuration = options.route.configuration;
  const credential = configuration
    ? readProtectedImageCredential(options.env, options.runtimeId, configuration)
    : undefined;
  if (!configuration || !credential || credential.workspaceId !== workspaceId) {
    return { imageCapabilityBindings: [], imageExecutionEvidence: [] };
  }
  const prepared = await prepareProtectedImageExecution(options).catch(() => undefined);
  const currentCredential = readProtectedImageCredential(
    options.env,
    options.runtimeId,
    configuration,
  );
  if (
    !currentCredential ||
    currentCredential.apiKey !== credential.apiKey ||
    imageCredentialBindingDigest(currentCredential) !== imageCredentialBindingDigest(credential)
  ) {
    return { imageCapabilityBindings: [], imageExecutionEvidence: [] };
  }
  const capability = !!prepared && exactOutputSupported(prepared);
  const source = options.lifecycleSource;
  const lifecycle =
    source?.dispatcherRevision === 2 &&
    source.stopOnly === true &&
    source.terminalReceiptParser === parseImageLifecycleReceipt &&
    isConstructedImageReceiptStore(source.receiptStore);
  const receipt = {
    schemaVersion: 1 as const,
    executor: lifecycle,
    // The factory cannot observe a mounted/authenticated HTTP transport or the
    // remote Artifact Owner. Keep their revisions/facts absent until an actual
    // owner receipt is supplied; bridge construction alone proves neither.
    transport: false,
    adapter: !!prepared,
    capability,
    artifactIngest: false,
    terminalReceiptParser: lifecycle,
    retry: lifecycle,
    cancellation: false,
    revisions: {
      dispatcherRevision: lifecycle ? 2 : 0,
      transportRevision: 0,
      adapterRevision: prepared ? 1 : 0,
    },
    ready: false,
    activeExecutionAllowed: false,
    blockers: [
      "IMAGE_TRANSPORT_UNVERIFIED",
      "IMAGE_ARTIFACT_INGEST_UNVERIFIED",
      "IMAGE_CANCELLATION_UNSUPPORTED",
      ...(!lifecycle ? ["IMAGE_LIFECYCLE_SOURCE_UNVERIFIED"] : []),
      ...(!prepared ? ["IMAGE_PROTECTED_ADAPTER_UNAVAILABLE"] : []),
      ...(!capability ? ["IMAGE_EXACT_OUTPUT_UNSUPPORTED"] : []),
    ],
  };
  return {
    imageCapabilityBindings: [configuration.binding],
    imageExecutionEvidence: [
      {
        schemaVersion: 1,
        bindingDigest: imageDigest(configuration.binding),
        runtimePairRouteId: credential.runtimePairRouteId,
        runtimePairRouteRevision: credential.runtimePairRouteRevision,
        runtimeHostInstanceId: credential.runtimeHostInstanceId,
        credentialBindingRevision: credential.revision,
        credentialBindingDigest: imageCredentialBindingDigest(credential),
        outputSupportDigest: imageDigest(configuration.outputSupport),
        readinessReceipt: { ...receipt, digest: imageDigest(receipt) },
      },
    ],
  };
}

/** Full exact-output/credential authority is checked only for a new paid effect. */
export function imagePlanMatchesProtectedBinding(input: {
  plan: Record<string, unknown>;
  workspaceId: string;
  runtimeId: string;
  credential: ProtectedImageCredential;
  binding: ImageCapabilityBinding;
  outputSupport: ImageOutputSupport;
}): boolean {
  const { plan, credential, binding, outputSupport } = input;
  if (
    plan.schemaVersion !== 4 ||
    input.workspaceId !== credential.workspaceId ||
    plan.presetId !== binding.presetId
  )
    return false;
  const runtimeTarget = {
    runtimeId: input.runtimeId,
    runtimePairRouteId: credential.runtimePairRouteId,
    runtimePairRouteRevision: credential.runtimePairRouteRevision,
    runtimeHostInstanceId: credential.runtimeHostInstanceId,
  };
  const runtime = plan.runtimeRef as Record<string, unknown>;
  if (Object.entries(runtimeTarget).some(([key, value]) => runtime[key] !== value)) return false;
  const intent = plan.generationIntent as Record<string, unknown>;
  const output = intent.resolvedOutput as Record<string, unknown>;
  const sources = intent.compiledSourceDigests as Record<string, unknown>;
  if (
    !output ||
    !binding.supportedOutputFormats.includes(output.format as "png") ||
    !binding.supportedOutputResolutions.includes(
      `${String(output.width)}x${String(output.height)}`,
    ) ||
    !outputSupport.alphaPolicies.includes(output.alphaPolicy as "forbid") ||
    !outputSupport.qualityIntents.includes(output.qualityIntent as "draft") ||
    !outputSupport.transparentPixelRequirements.includes(
      output.transparentPixelRequirement as "none",
    ) ||
    !outputSupport.backgroundSemanticRequirements.includes(
      output.backgroundSemanticRequirement as "none",
    ) ||
    outputSupport.trustedBackgroundEvaluator ||
    output.backgroundSemanticRequirement === "transparent_strict" ||
    output.capabilityProfileRevision !==
      `${binding.profile.profileId}:${binding.profile.revision}:${binding.profile.digest}` ||
    output.adapterRevision !== binding.adapterRevision ||
    output.compilerRevision !== "media-text-to-image-v4/v1" ||
    !sources ||
    sources.capabilityProfileDigest !== binding.profile.digest ||
    sources.routePlanDigest !== imageDigest(binding.route) ||
    sources.adapterRevisionDigest !== imageDigest(binding.adapterRevision) ||
    plan.resolvedOutputSpecDigest !== imageDigest(output)
  )
    return false;
  return (
    plan.adapterCompilationDigest ===
    imageDigest({
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
    })
  );
}
