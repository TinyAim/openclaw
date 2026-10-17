import { describe, expect, it } from "vitest";
import {
  imageCredentialBindingDigest,
  imageDigest,
  parseImageRoute,
  parseImageRouteConfiguration,
  readProtectedImageCredential,
} from "./image-route-config.js";
import {
  protectedImageConfiguration,
  protectedImageCredential,
  protectedImageEnv,
} from "./protected-image.test-helpers.js";

describe("independent protected image slot", () => {
  it("requires explicit image enablement and a closed image-only route", () => {
    const configuration = protectedImageConfiguration();
    const env = protectedImageEnv("/unused-synthetic-state");
    expect(parseImageRoute(env)?.configuration).toEqual(configuration);
    expect(
      parseImageRoute({ ...env, OPENCLAW_MEDIA_GEN_IMAGE_EXECUTOR_ENABLED: "0" }),
    ).toBeUndefined();
    for (const raw of [
      { ...configuration, apiKey: "forged-chat-key" },
      { ...configuration, binding: { ...configuration.binding, mediaClass: "video" } },
      { ...configuration, binding: { ...configuration.binding, supportedOperations: ["submit"] } },
      {
        ...configuration,
        binding: { ...configuration.binding, supportedOutputResolutions: ["01024x1024"] },
      },
      {
        ...configuration,
        outputSupport: {
          ...configuration.outputSupport,
          trustedBackgroundEvaluator: false,
          backgroundSemanticRequirements: ["transparent_strict"],
        },
      },
    ])
      expect(parseImageRouteConfiguration(raw)).toBeUndefined();
  });

  it("digests metadata and real revision while excluding only secret bytes", () => {
    const credential = protectedImageCredential();
    const expected = imageCredentialBindingDigest(credential);
    // Independent canonical JSON/SHA256 golden shared with the Host tests.
    expect(credential.bindingDigest).toBe(
      "sha256:d35fe8ac8ddebd90fff8c1293c6a3e4824b2a5ab16813d174a969fe440ee0e20",
    );
    expect(expected).toBe(
      "sha256:132398e89027f627babea354dd181a345d0474a41b0d5f9f5ab6d45b20c227ba",
    );
    expect(imageCredentialBindingDigest({ ...credential, apiKey: "another-synthetic-key" })).toBe(
      expected,
    );
    for (const patch of [
      { credentialId: "other-slot" },
      { revision: 8 },
      { tenantId: "tenant-2" },
      { workspaceId: "workspace-2" },
      { subjectUserId: "user-2" },
      { runtimeId: "runtime-2" },
      { runtimePairRouteId: "pair-2" },
      { runtimePairRouteRevision: 4 },
      { runtimeHostInstanceId: "host-2" },
      { baseUrl: "https://other-images.example.test/v1" },
      { bindingDigest: `sha256:${"f".repeat(64)}` },
    ])
      expect(imageCredentialBindingDigest({ ...credential, ...patch })).not.toBe(expected);
  });

  it("rejects a missing, forged, cross-runtime or cross-workspace protected slot even with chat keys", () => {
    const configuration = protectedImageConfiguration();
    const credential = protectedImageCredential(configuration);
    const env = protectedImageEnv("/unused-synthetic-state", configuration, credential);
    expect(readProtectedImageCredential(env, "runtime-1", configuration)).toEqual(credential);
    for (const patch of [
      { OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON: undefined },
      { OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_BINDING_DIGEST: imageDigest({ forged: true }) },
      { OPENCLAW_MEDIA_GEN_WORKSPACE_IDS: "workspace-2" },
      { OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON: JSON.stringify({ ...credential, revision: 8 }) },
      {
        OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON: JSON.stringify({
          ...credential,
          capabilityDomain: "chat",
        }),
      },
      { OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON: JSON.stringify({ ...credential, apiKey: "" }) },
      {
        OPENCLAW_MEDIA_GEN_IMAGE_CREDENTIAL_JSON: JSON.stringify({
          ...credential,
          baseUrl: "https://images.example.test/?apiKey=x",
        }),
      },
    ]) {
      expect(
        readProtectedImageCredential(
          { ...env, OPENAI_API_KEY: "synthetic-chat-key", ...patch },
          "runtime-1",
          configuration,
        ),
      ).toBeUndefined();
    }
    expect(readProtectedImageCredential(env, "runtime-2", configuration)).toBeUndefined();
    expect(
      readProtectedImageCredential(env, "runtime-1", {
        ...configuration,
        binding: {
          ...configuration.binding,
          route: { ...configuration.binding.route, routeId: "changed-route" },
        },
      }),
    ).toBeUndefined();
  });
});
