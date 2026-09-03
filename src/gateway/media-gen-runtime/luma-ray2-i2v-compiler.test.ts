import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileLumaRay2I2vRequest,
  LUMA_RAY2_I2V_ADAPTER_REVISION,
  LUMA_RAY2_I2V_ENDPOINT_ID,
  LUMA_RAY2_I2V_MODEL_ID,
  LUMA_RAY2_I2V_PROFILE_DIGEST,
  LUMA_RAY2_I2V_PROFILE_ID,
  LUMA_RAY2_I2V_ROUTE_ID,
} from "./luma-ray2-i2v-compiler.js";
import type { MediaGenRuntimeSourceSlot, MediaGenRuntimeVendorInput } from "./types.js";

const IMAGE_SHA = "a".repeat(64);
const IMAGE_URL = "https://runtime.example/assets/frame-0.png";

function constraint(
  intentPath: string,
  support: "native" | "prompt",
  target: { providerField?: string; providerSlot?: string },
): MediaGenRuntimeFrozenPlanV2["constraintPlan"][number] {
  return {
    intentPath,
    sourceRef: intentPath.startsWith("references.") ? "runtime-local:frame-0" : "pack:R1",
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
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A lighthouse beam sweeps across a stormy sea.";
  return {
    schemaVersion: 2,
    previewId: "preview-luma-i2v",
    presetId: "luma",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-luma",
        shotId: "shot-luma",
        shotVersion: "R1",
        promptPackId: "pack-luma",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [`sha256:${IMAGE_SHA}`],
      },
      generationScenario: "first_frame_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: { cameraPrompt: "Slow dolly forward." },
      performance: {},
      look: {},
      references: [
        {
          role: "first_frame",
          ordinal: 0,
          required: true,
          mediaClass: "image",
          source: { kind: "runtime_local", runtimeLocalRef: "runtime-frame-0" },
          authorityRef: "runtime-local:frame-0",
          authorityVerified: true,
          mimeType: "image/png",
          sourceDigest: `sha256:${IMAGE_SHA}`,
        },
      ],
      output: {
        durationSec: overrides.durationSec ?? 5,
        aspectRatio: overrides.aspectRatio ?? "9:16",
        resolution: overrides.resolution ?? "1080p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "first_frame_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: LUMA_RAY2_I2V_ROUTE_ID,
      providerId: "luma_dream_machine",
      modelId: LUMA_RAY2_I2V_MODEL_ID,
      endpointId: LUMA_RAY2_I2V_ENDPOINT_ID,
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: LUMA_RAY2_I2V_PROFILE_ID,
      revision: 1,
      digest: LUMA_RAY2_I2V_PROFILE_DIGEST,
    },
    adapterRevision: LUMA_RAY2_I2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-luma", lastSeenAt: "2026-08-01T00:00:00.000Z" },
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
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlot(
  overrides: Partial<Extract<MediaGenRuntimeSourceSlot["source"], { providerRef: string }>> = {},
): MediaGenRuntimeSourceSlot {
  return {
    role: "first_frame",
    ordinal: 0,
    source: {
      providerRef: IMAGE_URL,
      mimeType: "image/png",
      sha256: IMAGE_SHA,
      ...overrides,
    },
  };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-luma-i2v",
    presetId: "luma",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    sources: [sourceSlot()],
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Luma Ray 2 exact first-frame Image-to-Video compiler", () => {
  it("compiles only the exact keyframes.frame0 request and a stable digest", () => {
    const result = compileLumaRay2I2vRequest(vendorInput());
    expect(result).toMatchObject({
      ok: true,
      body: {
        model: "ray-2",
        prompt: "A lighthouse beam sweeps across a stormy sea.",
        duration: "5s",
        aspect_ratio: "9:16",
        resolution: "1080p",
        keyframes: { frame0: { type: "image", url: IMAGE_URL } },
      },
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(Object.keys(result.body)).toEqual([
      "model",
      "prompt",
      "duration",
      "aspect_ratio",
      "resolution",
      "keyframes",
    ]);
    expect(result.providerRequestDigest).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(result.body)).digest("hex")}`,
    );
  });

  it("rejects stale identity and non-exact mappings", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = "stale-profile";
    expect(compileLumaRay2I2vRequest(vendorInput(stale))).toMatchObject({ ok: false });

    const routeDrift = frozenPlan();
    routeDrift.providerRouteRef.routeId = "luma.unverified.route";
    expect(compileLumaRay2I2vRequest(vendorInput(routeDrift))).toMatchObject({ ok: false });

    const slotDrift = frozenPlan();
    slotDrift.constraintPlan.find(
      (row) => row.intentPath === "references.first_frame.0",
    )!.providerSlot = "references.subject";
    expect(compileLumaRay2I2vRequest(vendorInput(slotDrift))).toMatchObject({ ok: false });

    const nativeCamera = frozenPlan();
    nativeCamera.constraintPlan.find((row) => row.intentPath === "camera.cameraPrompt")!.support =
      "native";
    expect(compileLumaRay2I2vRequest(vendorInput(nativeCamera))).toMatchObject({ ok: false });

    expect(
      compileLumaRay2I2vRequest(vendorInput(frozenPlan(), { params: { loop: true } })),
    ).toMatchObject({ ok: false });
    expect(compileLumaRay2I2vRequest(vendorInput(frozenPlan(), { params: {} }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects artifact, insecure, byte, MIME, digest, and slot source drift", () => {
    const artifact = frozenPlan();
    artifact.generationIntent.references[0].source = {
      kind: "artifact",
      artifactId: "artifact-frame-0",
    };
    expect(compileLumaRay2I2vRequest(vendorInput(artifact))).toMatchObject({ ok: false });

    for (const providerRef of ["http://runtime.example/frame.png", "asset://frame-0"] as const) {
      expect(
        compileLumaRay2I2vRequest(
          vendorInput(frozenPlan(), { sources: [sourceSlot({ providerRef })] }),
        ),
      ).toMatchObject({ ok: false });
    }
    expect(
      compileLumaRay2I2vRequest(
        vendorInput(frozenPlan(), {
          sources: [
            {
              role: "first_frame",
              ordinal: 0,
              source: { bytes: Buffer.from("frame"), mimeType: "image/png", sha256: IMAGE_SHA },
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileLumaRay2I2vRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot({ mimeType: "image/jpeg" })] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileLumaRay2I2vRequest(
        vendorInput(frozenPlan(), { sources: [sourceSlot({ sha256: "b".repeat(64) })] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileLumaRay2I2vRequest(
        vendorInput(frozenPlan(), { sources: [{ ...sourceSlot(), ordinal: 1 }] }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects unsupported controls and counts prompt length by Unicode code point", () => {
    for (const plan of [
      frozenPlan({ durationSec: 6 }),
      frozenPlan({ aspectRatio: "2:1" }),
      frozenPlan({ resolution: "8k" }),
      frozenPlan({ prompt: "😀😀" }),
      frozenPlan({ prompt: "x".repeat(5_001) }),
    ]) {
      expect(compileLumaRay2I2vRequest(vendorInput(plan))).toMatchObject({ ok: false });
    }
    expect(compileLumaRay2I2vRequest(vendorInput(frozenPlan({ prompt: "😀😀😀" })))).toMatchObject({
      ok: true,
    });

    const unsupported = frozenPlan();
    unsupported.generationIntent.output.fps = 24;
    expect(compileLumaRay2I2vRequest(vendorInput(unsupported))).toMatchObject({ ok: false });
    delete unsupported.generationIntent.output.fps;
    unsupported.generationIntent.output.qualityIntent = "cinematic";
    expect(compileLumaRay2I2vRequest(vendorInput(unsupported))).toMatchObject({ ok: false });
    delete unsupported.generationIntent.output.qualityIntent;
    unsupported.generationIntent.narrative.negativePrompt = "no flicker";
    expect(compileLumaRay2I2vRequest(vendorInput(unsupported))).toMatchObject({ ok: false });
    expect(
      compileLumaRay2I2vRequest(vendorInput(frozenPlan(), { source: sourceSlot().source })),
    ).toMatchObject({ ok: false });
  });
});
