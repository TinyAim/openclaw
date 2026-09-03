import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenRuntimeSourceSlot, MediaGenRuntimeVendorInput } from "./types.js";
import {
  compileVeo31I2vRequest,
  VEO31_I2V_ADAPTER_REVISION,
  VEO31_I2V_ENDPOINT_ID,
  VEO31_I2V_MODEL_ID,
  VEO31_I2V_PROFILE_DIGEST,
  VEO31_I2V_PROFILE_ID,
  VEO31_I2V_ROUTE_ID,
} from "./veo3-1-i2v-compiler.js";

const IMAGE_BYTES = Buffer.from("verified-veo-first-frame");
const IMAGE_SHA256 = createHash("sha256").update(IMAGE_BYTES).digest("hex");

function constraint(
  intentPath: string,
  support: "native" | "prompt",
  target: { providerField?: string; providerSlot?: string },
): MediaGenRuntimeFrozenPlanV2["constraintPlan"][number] {
  return {
    intentPath,
    sourceRef: intentPath.startsWith("references.") ? "artifact:frame-0" : "pack:R1",
    sourceRevision: "R1",
    required: true,
    support,
    ...target,
    reasonCode: support === "prompt" ? "prompt_compiled" : "value_native",
    messageKey: support === "prompt" ? "media.prompt_compiled" : "media.value_native",
  };
}

function frozenPlan(
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    fps?: number;
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A paper boat glides through a rain-filled street at dusk.";
  return {
    schemaVersion: 2,
    previewId: "preview-veo-i2v",
    presetId: "veo",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-veo-i2v",
        shotId: "shot-veo-i2v",
        shotVersion: "R1",
        promptPackId: "pack-veo-i2v",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${IMAGE_SHA256}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Low tracking shot beside the boat." },
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "artifact", artifactId: "artifact-frame-0" },
          assetRefId: "asset-frame-0",
          authorityRef: "artifact:frame-0",
          authorityVerified: true,
          mimeType: "image/png",
          sourceDigest: `sha256:${IMAGE_SHA256}`,
        },
      ],
      output: {
        durationSec: overrides.durationSec ?? 6,
        aspectRatio: overrides.aspectRatio ?? "9:16",
        resolution: overrides.resolution ?? "1080p",
        fps: overrides.fps ?? 24,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: VEO31_I2V_ROUTE_ID,
      providerId: "google_vertex_ai",
      modelId: VEO31_I2V_MODEL_ID,
      endpointId: VEO31_I2V_ENDPOINT_ID,
      region: "us-central1",
      accountTier: "adc",
    },
    capabilityProfileRef: {
      profileId: VEO31_I2V_PROFILE_ID,
      revision: 1,
      digest: VEO31_I2V_PROFILE_DIGEST,
    },
    adapterRevision: VEO31_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-veo-i2v", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    constraintPlan: [
      constraint("generationScenario", "native", { providerField: "scenario" }),
      constraint("outputAudioPolicy", "native", { providerField: "output.audio" }),
      constraint("compiledPrompt", "prompt", { providerField: "prompt" }),
      constraint("camera.cameraPrompt", "prompt", { providerField: "prompt" }),
      constraint("references.first_frame.0", "native", {
        providerSlot: "references.first_frame",
      }),
      constraint("output.durationSec", "native", { providerField: "output.durationSec" }),
      constraint("output.aspectRatio", "native", { providerField: "output.aspectRatio" }),
      constraint("output.resolution", "native", { providerField: "output.resolution" }),
      constraint("output.fps", "native", { providerField: "output.fps" }),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlot(
  overrides: { bytes?: Buffer; mimeType?: string; sha256?: string } = {},
): MediaGenRuntimeSourceSlot {
  return {
    role: "first_frame",
    ordinal: 0,
    source: {
      bytes: overrides.bytes ?? IMAGE_BYTES,
      mimeType: overrides.mimeType ?? "image/png",
      sha256: overrides.sha256 ?? IMAGE_SHA256,
    },
  };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-veo-i2v",
    presetId: "veo",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    sources: [sourceSlot()],
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Veo 3.1 exact first-frame Image-to-Video compiler", () => {
  it("compiles the exact Vertex request body and deterministic digest", () => {
    const result = compileVeo31I2vRequest(vendorInput());
    expect(result).toEqual({
      ok: true,
      body: {
        instances: [
          {
            prompt: "A paper boat glides through a rain-filled street at dusk.",
            image: {
              bytesBase64Encoded: IMAGE_BYTES.toString("base64"),
              mimeType: "image/png",
            },
          },
        ],
        parameters: {
          task: "imageToVideo",
          aspectRatio: "9:16",
          durationSeconds: 6,
          enhancePrompt: true,
          generateAudio: false,
          personGeneration: "allow_adult",
          resolution: "1080p",
          sampleCount: 1,
          resizeMode: "pad",
        },
      },
      providerRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.providerRequestDigest).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(result.body)).digest("hex")}`,
    );

    const sourceWithoutDeclaredHash = sourceSlot();
    delete sourceWithoutDeclaredHash.source.sha256;
    expect(
      compileVeo31I2vRequest(vendorInput(frozenPlan(), { sources: [sourceWithoutDeclaredHash] })),
    ).toMatchObject({ ok: true });

    const promptMapped = frozenPlan();
    promptMapped.generationIntent.performance.actorDirection =
      "Keep the subject motion restrained.";
    promptMapped.constraintPlan.push(
      constraint("performance.actorDirection", "prompt", { providerField: "prompt" }),
    );
    expect(compileVeo31I2vRequest(vendorInput(promptMapped))).toMatchObject({ ok: true });
  });

  it("rejects route/profile identity and exact mapping drift", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileVeo31I2vRequest(vendorInput(stale))).toMatchObject({ ok: false });

    const routeDrift = frozenPlan();
    routeDrift.providerRouteRef.endpointId = "aiplatform.v1.unverified";
    expect(compileVeo31I2vRequest(vendorInput(routeDrift))).toMatchObject({ ok: false });

    const slotDrift = frozenPlan();
    slotDrift.constraintPlan.find(
      (row) => row.intentPath === "references.first_frame.0",
    )!.providerSlot = "references.subject";
    expect(compileVeo31I2vRequest(vendorInput(slotDrift))).toMatchObject({ ok: false });

    const cameraDrift = frozenPlan();
    cameraDrift.constraintPlan.find((row) => row.intentPath === "camera.cameraPrompt")!.support =
      "native";
    expect(compileVeo31I2vRequest(vendorInput(cameraDrift))).toMatchObject({ ok: false });

    const unknownMapping = frozenPlan();
    unknownMapping.constraintPlan.push(
      constraint("look.stylePrompt", "prompt", { providerField: "provider.privateField" }),
    );
    expect(compileVeo31I2vRequest(vendorInput(unknownMapping))).toMatchObject({ ok: false });

    const requiredUnsupported = frozenPlan();
    requiredUnsupported.constraintPlan.push({
      ...constraint("look.continuityPrompt", "prompt", {}),
      support: "unsupported",
    });
    expect(compileVeo31I2vRequest(vendorInput(requiredUnsupported))).toMatchObject({ ok: false });

    const missingDuration = frozenPlan();
    missingDuration.constraintPlan = missingDuration.constraintPlan.filter(
      (row) => row.intentPath !== "output.durationSec",
    );
    expect(compileVeo31I2vRequest(vendorInput(missingDuration))).toMatchObject({ ok: false });

    for (const params of [{}, { sampleCount: 2 }]) {
      expect(compileVeo31I2vRequest(vendorInput(frozenPlan(), { params }))).toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects authority, artifact, MIME, byte size, and hash drift", () => {
    const notRequired = frozenPlan();
    notRequired.generationIntent.references[0].required = false;
    expect(compileVeo31I2vRequest(vendorInput(notRequired))).toMatchObject({ ok: false });

    const unauthorized = frozenPlan();
    unauthorized.generationIntent.references[0].authorityVerified = false;
    expect(compileVeo31I2vRequest(vendorInput(unauthorized))).toMatchObject({ ok: false });

    for (const field of ["assetRefId", "authorityRef"] as const) {
      const missingAuthority = frozenPlan();
      delete missingAuthority.generationIntent.references[0][field];
      expect(compileVeo31I2vRequest(vendorInput(missingAuthority))).toMatchObject({ ok: false });
    }

    const runtimeLocal = frozenPlan();
    runtimeLocal.generationIntent.references[0].source = {
      kind: "runtime_local",
      runtimeLocalRef: "runtime-frame-0",
    };
    expect(compileVeo31I2vRequest(vendorInput(runtimeLocal))).toMatchObject({ ok: false });

    for (const mimeType of ["image/webp", "IMAGE/PNG", "image/jpeg"] as const) {
      expect(
        compileVeo31I2vRequest(vendorInput(frozenPlan(), { sources: [sourceSlot({ mimeType })] })),
      ).toMatchObject({ ok: false });
    }
    expect(
      compileVeo31I2vRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot({ bytes: Buffer.alloc(0) })] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileVeo31I2vRequest(
        vendorInput(frozenPlan(), {
          sources: [sourceSlot({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1) })],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileVeo31I2vRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot({ bytes: Buffer.from("tampered") })] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileVeo31I2vRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot({ sha256: "a".repeat(64) })] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileVeo31I2vRequest(
        vendorInput(frozenPlan(), {
          sources: [
            {
              role: "first_frame",
              ordinal: 0,
              source: { providerRef: "artifact://frame-0", mimeType: "image/png" },
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects slot and unsupported output-control drift", () => {
    expect(compileVeo31I2vRequest(vendorInput(frozenPlan(), { sources: undefined }))).toMatchObject(
      {
        ok: false,
      },
    );
    expect(
      compileVeo31I2vRequest(
        vendorInput(frozenPlan(), { sources: [{ ...sourceSlot(), ordinal: 1 }] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileVeo31I2vRequest(
        vendorInput(frozenPlan(), { sources: [{ ...sourceSlot(), role: "subject" }] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileVeo31I2vRequest(vendorInput(frozenPlan(), { sources: [sourceSlot(), sourceSlot()] })),
    ).toMatchObject({ ok: false });
    expect(
      compileVeo31I2vRequest(vendorInput(frozenPlan(), { source: sourceSlot().source })),
    ).toMatchObject({ ok: false });

    for (const plan of [
      frozenPlan({ durationSec: 5 }),
      frozenPlan({ aspectRatio: "1:1" }),
      frozenPlan({ resolution: "4k" }),
      frozenPlan({ fps: 30 }),
      frozenPlan({ prompt: "  " }),
    ]) {
      expect(compileVeo31I2vRequest(vendorInput(plan))).toMatchObject({ ok: false });
    }
    const extraControls = frozenPlan();
    extraControls.generationIntent.output.shotCount = 2;
    expect(compileVeo31I2vRequest(vendorInput(extraControls))).toMatchObject({ ok: false });
    extraControls.generationIntent.output.shotCount = 1;
    extraControls.generationIntent.output.qualityIntent = "cinematic";
    expect(compileVeo31I2vRequest(vendorInput(extraControls))).toMatchObject({ ok: false });
    delete extraControls.generationIntent.output.qualityIntent;
    extraControls.generationIntent.narrative.negativePrompt = "no rain";
    expect(compileVeo31I2vRequest(vendorInput(extraControls))).toMatchObject({ ok: false });

    const fixedFpsOmitted = frozenPlan();
    delete fixedFpsOmitted.generationIntent.output.fps;
    fixedFpsOmitted.constraintPlan = fixedFpsOmitted.constraintPlan.filter(
      (row) => row.intentPath !== "output.fps",
    );
    expect(compileVeo31I2vRequest(vendorInput(fixedFpsOmitted))).toMatchObject({ ok: true });
  });
});
