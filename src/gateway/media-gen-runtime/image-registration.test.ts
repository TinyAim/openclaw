import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseMediaGenRuntimeImageExecutionEvidence,
  mediaGenRuntimeImageCapabilityBindingDigest,
  mediaGenRuntimeImageOutputSupportDigest,
} from "../../../../../../packages/contracts/src/dto/media-generation-runtime-executor/image-execution-evidence.js";
import {
  collectImageRegistrationSnapshot,
  imagePlanMatchesProtectedBinding,
  prepareProtectedImageExecution,
} from "./image-registration.js";
import { imageDigest, imageCredentialBindingDigest } from "./image-route-config.js";
import {
  protectedImageConfiguration,
  protectedImageCredential,
  protectedImageDispatch,
  protectedImageEnv,
  protectedImageRoute,
} from "./protected-image.test-helpers.js";

vi.mock("../../media-generation/registry.js", async () => {
  const { protectedImageModelAuth } = await import("./protected-image.test-helpers.js");
  const { buildOpenAIImageGenerationProvider } =
    await import("../../../extensions/openai/image-generation-provider.js");
  const { buildGoogleImageGenerationProvider } =
    await import("../../../extensions/google/image-generation-provider.js");
  return {
    getImageGenerationProvider: (provider: string) =>
      provider === "openai"
        ? buildOpenAIImageGenerationProvider(protectedImageModelAuth)
        : provider === "google"
          ? buildGoogleImageGenerationProvider()
          : undefined,
  };
});

describe("protected image execution registration", () => {
  beforeEach(() => {
    for (const key of ["OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"])
      vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  function options() {
    return {
      env: protectedImageEnv("/unused-synthetic-state"),
      runtimeId: "runtime-1",
      route: protectedImageRoute(),
      getConfig: () => ({
        models: {
          providers: {
            openai: {
              baseUrl: "https://chat.example.test/v1",
              apiKey: "synthetic-chat-key",
              models: [],
            },
          },
        },
      }),
    };
  }

  it("uses the actual provider auth resolver with request-local config and an empty profile store", async () => {
    const prepared = await prepareProtectedImageExecution(options());
    expect(prepared).toBeDefined();
    expect(prepared?.cfg.models).toEqual({
      mode: "replace",
      providers: {
        openai: {
          baseUrl: "https://images.example.test/v1",
          apiKey: "synthetic-domain-d-image-key",
          auth: "api-key",
          models: [],
        },
      },
    });
    expect(prepared?.authStore).toEqual({ version: 1, profiles: {} });
  });

  it("rejects ambient chat env precedence instead of silently borrowing it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-ambient-chat-key");
    expect(await prepareProtectedImageExecution(options())).toBeUndefined();
    const snapshot = await collectImageRegistrationSnapshot(options(), "workspace-1");
    expect(snapshot.imageExecutionEvidence[0]?.readinessReceipt).toMatchObject({
      adapter: false,
      ready: false,
      activeExecutionAllowed: false,
    });
  });

  it("keeps Google direct-config auth independent from both ambient Google chat key names", async () => {
    const configuration = protectedImageConfiguration();
    configuration.binding.route.providerId = "google";
    configuration.binding.route.modelId = "gemini-3.1-flash-image";
    const google = {
      ...options(),
      env: protectedImageEnv("/unused-synthetic-state", configuration),
      route: protectedImageRoute(configuration),
    };
    expect((await prepareProtectedImageExecution(google))?.credential.apiKey).toBe(
      "synthetic-domain-d-image-key",
    );
    for (const key of ["GOOGLE_API_KEY", "GEMINI_API_KEY"]) {
      vi.stubEnv(key, "synthetic-ambient-google-chat-key");
      expect(await prepareProtectedImageExecution(google)).toBeUndefined();
      vi.stubEnv(key, undefined);
    }
  });

  it("produces strict contract-parsed workspace claims with identical non-secret digests and closed missing seams", async () => {
    const snapshot = await collectImageRegistrationSnapshot(options(), "workspace-1");
    expect(snapshot.imageCapabilityBindings).toHaveLength(1);
    expect(snapshot.imageExecutionEvidence).toHaveLength(1);
    const evidence = snapshot.imageExecutionEvidence[0]!;
    expect(parseMediaGenRuntimeImageExecutionEvidence(evidence)).toEqual(evidence);
    expect(evidence.bindingDigest).toBe(
      mediaGenRuntimeImageCapabilityBindingDigest(snapshot.imageCapabilityBindings[0]),
    );
    expect(evidence.outputSupportDigest).toBe(
      mediaGenRuntimeImageOutputSupportDigest(protectedImageConfiguration().outputSupport),
    );
    expect(evidence.credentialBindingDigest).toBe(
      imageCredentialBindingDigest(protectedImageCredential()),
    );
    expect(evidence.readinessReceipt).toMatchObject({
      adapter: true,
      capability: true,
      transport: false,
      artifactIngest: false,
      cancellation: false,
      executor: false,
      terminalReceiptParser: false,
      retry: false,
      revisions: { dispatcherRevision: 0, transportRevision: 0, adapterRevision: 1 },
      ready: false,
      activeExecutionAllowed: false,
      blockers: [
        "IMAGE_TRANSPORT_UNVERIFIED",
        "IMAGE_ARTIFACT_INGEST_UNVERIFIED",
        "IMAGE_CANCELLATION_UNSUPPORTED",
        "IMAGE_LIFECYCLE_SOURCE_UNVERIFIED",
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /synthetic-domain-d-image-key|synthetic-chat-key|tenant-1|user-1|images\.example/,
    );
    expect(await collectImageRegistrationSnapshot(options(), "workspace-2")).toEqual({
      imageCapabilityBindings: [],
      imageExecutionEvidence: [],
    });
  });

  it("withdraws claims when the protected credential is removed and never grants strict semantic evaluation from config", async () => {
    const withdrawn = options();
    delete withdrawn.env.OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON;
    expect(await collectImageRegistrationSnapshot(withdrawn, "workspace-1")).toEqual({
      imageCapabilityBindings: [],
      imageExecutionEvidence: [],
    });
    const strict = options();
    strict.route.configuration!.outputSupport.trustedBackgroundEvaluator = true;
    strict.route.configuration!.outputSupport.backgroundSemanticRequirements = [
      "transparent_strict",
    ];
    const snapshot = await collectImageRegistrationSnapshot(strict, "workspace-1");
    expect(snapshot.imageExecutionEvidence[0]?.readinessReceipt).toMatchObject({
      capability: false,
      ready: false,
      activeExecutionAllowed: false,
    });
  });

  it("rejects changes to frozen scope, Pair, Host, credential revision, route, output and compilation digests", () => {
    const configuration = protectedImageConfiguration();
    const credential = protectedImageCredential(configuration);
    const dispatch = protectedImageDispatch(configuration, credential);
    const input = {
      plan: dispatch.frozenImagePlan,
      workspaceId: "workspace-1",
      runtimeId: "runtime-1",
      credential,
      ...configuration,
    };
    expect(imagePlanMatchesProtectedBinding(input)).toBe(true);
    for (const patch of [
      { tenantId: "tenant-2" },
      { workspaceId: "workspace-2" },
      { subjectUserId: "user-2" },
      { revision: 8 },
      { runtimePairRouteId: "pair-2" },
      { runtimePairRouteRevision: 4 },
      { runtimeHostInstanceId: "host-2" },
    ])
      expect(
        imagePlanMatchesProtectedBinding({ ...input, credential: { ...credential, ...patch } }),
      ).toBe(false);
    for (const field of ["resolvedOutputSpecDigest", "adapterCompilationDigest"]) {
      expect(
        imagePlanMatchesProtectedBinding({
          ...input,
          plan: { ...input.plan, [field]: imageDigest({ changed: true }) },
        }),
      ).toBe(false);
    }
    expect(
      imagePlanMatchesProtectedBinding({
        ...input,
        binding: {
          ...configuration.binding,
          route: { ...configuration.binding.route, modelId: "other-model" },
        },
      }),
    ).toBe(false);
    expect(
      imagePlanMatchesProtectedBinding({
        ...input,
        outputSupport: { ...configuration.outputSupport, qualityIntents: ["draft"] },
      }),
    ).toBe(false);
  });
});
