import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import {
  compileRunwayGen45T2vRequest,
  RUNWAY_GEN45_T2V_ADAPTER_REVISION,
  RUNWAY_GEN45_T2V_ENDPOINT_ID,
  RUNWAY_GEN45_T2V_LEGACY_PROFILE_DIGEST,
  RUNWAY_GEN45_T2V_LEGACY_PROFILE_ID,
  RUNWAY_GEN45_T2V_LEGACY_PROFILE_REVISION,
  RUNWAY_GEN45_T2V_MODEL_ID,
  RUNWAY_GEN45_T2V_PROFILE_DIGEST,
  RUNWAY_GEN45_T2V_PROFILE_ID,
  RUNWAY_GEN45_T2V_PROFILE_REVISION,
  RUNWAY_GEN45_T2V_ROUTE_ID,
} from "./runway-gen45-t2v-compiler.js";
import type { MediaGenRuntimeVendorInput } from "./types.js";

function frozenPlan(
  overrides: {
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const prompt = overrides.prompt ?? "A paper kite crosses a skyline in warm sunset light.";
  return {
    schemaVersion: 2,
    previewId: "preview-runway-gen45",
    presetId: "runway",
    mode: "text2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-runway",
        shotId: "shot-runway",
        shotVersion: "R1",
        promptPackId: "pack-runway",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-08-01T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: [],
      },
      generationScenario: "text_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "text2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references: [],
      output: {
        durationSec: overrides.durationSec ?? 6,
        aspectRatio: overrides.aspectRatio ?? "16:9",
        resolution: overrides.resolution ?? "720p",
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "text_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: RUNWAY_GEN45_T2V_ROUTE_ID,
      providerId: "runway_api",
      modelId: RUNWAY_GEN45_T2V_MODEL_ID,
      endpointId: RUNWAY_GEN45_T2V_ENDPOINT_ID,
      region: "global",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: RUNWAY_GEN45_T2V_PROFILE_ID,
      revision: RUNWAY_GEN45_T2V_PROFILE_REVISION,
      digest: RUNWAY_GEN45_T2V_PROFILE_DIGEST,
    },
    adapterRevision: RUNWAY_GEN45_T2V_ADAPTER_REVISION,
    runtimeRef: { runtimeId: "runtime-runway", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerField: "scenario",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R1",
        sourceRevision: "R1",
        required: true,
        support: "native",
        providerField: "output.audio",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: true,
        support: "prompt",
        providerField: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      ...["output.durationSec", "output.aspectRatio", "output.resolution"].map((intentPath) => ({
        intentPath,
        sourceRef: "pack:R1",
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerField: intentPath,
        reasonCode: "output_value_native",
        messageKey: "media.output_value_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-runway-gen45",
    presetId: "runway",
    mode: "text2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Runway Gen-4.5 exact Text-to-Video compiler", () => {
  it("compiles only the exact landscape request and derives a stable digest", () => {
    const result = compileRunwayGen45T2vRequest(vendorInput());
    expect(result).toMatchObject({
      ok: true,
      body: {
        model: "gen4.5",
        promptText: "A paper kite crosses a skyline in warm sunset light.",
        ratio: "1280:720",
        duration: 6,
      },
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(Object.keys(result.body)).toEqual(["model", "promptText", "ratio", "duration"]);
    expect(result.providerRequestDigest).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(result.body)).digest("hex")}`,
    );
  });

  it("maps the only supported portrait ratio without changing provider fields", () => {
    expect(
      compileRunwayGen45T2vRequest(vendorInput(frozenPlan({ aspectRatio: "9:16" }))),
    ).toMatchObject({
      ok: true,
      body: { ratio: "720:1280", duration: 6 },
    });
  });

  it("rejects route, profile, adapter, and runtime prompt drift", () => {
    const routeDrift = frozenPlan();
    routeDrift.providerRouteRef.routeId = "runway.api.v1.other.text_to_video";
    expect(compileRunwayGen45T2vRequest(vendorInput(routeDrift))).toMatchObject({ ok: false });

    const profileDrift = frozenPlan();
    profileDrift.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileRunwayGen45T2vRequest(vendorInput(profileDrift))).toMatchObject({ ok: false });

    const adapterDrift = frozenPlan();
    adapterDrift.adapterRevision = "openclaw-runway-runtime/unverified";
    expect(compileRunwayGen45T2vRequest(vendorInput(adapterDrift))).toMatchObject({ ok: false });

    expect(
      compileRunwayGen45T2vRequest(vendorInput(frozenPlan(), { prompt: "changed after confirm" })),
    ).toMatchObject({ ok: false });
  });

  it("accepts the exact historical V1 receipt without using it for new claims", () => {
    const legacy = frozenPlan();
    legacy.capabilityProfileRef = {
      profileId: RUNWAY_GEN45_T2V_LEGACY_PROFILE_ID,
      revision: RUNWAY_GEN45_T2V_LEGACY_PROFILE_REVISION,
      digest: RUNWAY_GEN45_T2V_LEGACY_PROFILE_DIGEST,
    };
    expect(compileRunwayGen45T2vRequest(vendorInput(legacy))).toMatchObject({
      ok: true,
      body: { model: "gen4.5" },
    });
  });

  it("rejects incomplete mappings, provider slots, and private params", () => {
    const missingMapping = frozenPlan();
    missingMapping.constraintPlan = missingMapping.constraintPlan.filter(
      (row) => row.intentPath !== "output.resolution",
    );
    expect(compileRunwayGen45T2vRequest(vendorInput(missingMapping))).toMatchObject({ ok: false });

    const wrongMapping = frozenPlan();
    wrongMapping.constraintPlan.find((row) => row.intentPath === "output.aspectRatio")!.support =
      "approximate";
    expect(compileRunwayGen45T2vRequest(vendorInput(wrongMapping))).toMatchObject({ ok: false });

    const providerSlot = frozenPlan();
    providerSlot.constraintPlan[0].providerSlot = "references.first_frame";
    expect(compileRunwayGen45T2vRequest(vendorInput(providerSlot))).toMatchObject({ ok: false });

    expect(
      compileRunwayGen45T2vRequest(vendorInput(frozenPlan(), { params: { seed: 7 } })),
    ).toMatchObject({ ok: false });
    expect(compileRunwayGen45T2vRequest(vendorInput(frozenPlan(), { params: {} }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects unsupported output, reference, and UTF-16 prompt drift", () => {
    for (const plan of [
      frozenPlan({ durationSec: 1 }),
      frozenPlan({ durationSec: 10.5 }),
      frozenPlan({ aspectRatio: "1:1" }),
      frozenPlan({ resolution: "1080p" }),
      frozenPlan({ prompt: "   " }),
      frozenPlan({ prompt: "x".repeat(1_001) }),
      frozenPlan({ prompt: `${"x".repeat(999)}😀` }),
    ]) {
      expect(compileRunwayGen45T2vRequest(vendorInput(plan))).toMatchObject({ ok: false });
    }

    const withReference = frozenPlan();
    withReference.generationIntent.references.push({
      role: "first_frame",
      ordinal: 0,
      required: true,
      mediaClass: "image",
      source: { kind: "artifact", artifactId: "artifact-runway" },
      authorityVerified: true,
    });
    expect(compileRunwayGen45T2vRequest(vendorInput(withReference))).toMatchObject({ ok: false });
    expect(
      compileRunwayGen45T2vRequest(
        vendorInput(frozenPlan(), {
          sources: [
            {
              role: "first_frame",
              ordinal: 0,
              source: { providerRef: "https://private.invalid/input.png", mimeType: "image/png" },
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(compileRunwayGen45T2vRequest(vendorInput(frozenPlan(), { sources: [] }))).toMatchObject({
      ok: false,
    });
  });
});
