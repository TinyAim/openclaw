import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDispatch } from "../media-gen-runtime-dispatch.js";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import {
  parseMediaGenRuntimeFrozenPlan,
  type MediaGenerationIntentReference,
  type MediaGenerationScenario,
  type MediaGenRuntimeFrozenPlanV2,
  type MediaOutputAudioPolicy,
} from "./frozen-plan.js";
import {
  compileSeedanceV2Request,
  SEEDANCE_V2_LEGACY_IMAGE_PROFILE,
  SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4,
} from "./seedance-v2-compiler.js";
import { createSeedanceV2RuntimeVendor } from "./seedance-vendor-v2.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function reference(input: {
  role: MediaGenerationIntentReference["role"];
  ordinal: number;
  mediaClass: MediaGenerationIntentReference["mediaClass"];
  kind?: "artifact" | "runtime_local";
  digest?: string;
}): MediaGenerationIntentReference {
  return {
    role: input.role,
    ordinal: input.ordinal,
    required: true,
    mediaClass: input.mediaClass,
    source:
      input.kind === "runtime_local"
        ? { kind: "runtime_local", runtimeLocalRef: `local-${input.role}-${input.ordinal}` }
        : { kind: "artifact", artifactId: `artifact-${input.role}-${input.ordinal}` },
    authorityVerified: true,
    mimeType:
      input.mediaClass === "image"
        ? "image/png"
        : input.mediaClass === "audio"
          ? "audio/wav"
          : "video/mp4",
    sourceDigest: `sha256:${input.digest ?? sha(`${input.role}-${input.ordinal}`)}`,
  };
}

function plan(input: {
  references: MediaGenerationIntentReference[];
  scenario?: MediaGenerationScenario;
  audio?: MediaOutputAudioPolicy;
}): MediaGenRuntimeFrozenPlanV2 {
  const generationScenario = input.scenario ?? "multimodal_reference_to_video";
  const outputAudioPolicy = input.audio ?? "reference_conditioned";
  const intent = {
    schemaVersion: 2 as const,
    identity: {
      projectId: "project-short-drama",
      shotId: "shot-2-of-3",
      shotVersion: "R4",
      promptPackId: "prompt-pack-9x16",
      promptPackVersion: 3,
      promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
      promptPackDigest: `sha256:${"1".repeat(64)}`,
      sourceDigests: input.references.map((item) => item.sourceDigest!),
    },
    generationScenario,
    outputAudioPolicy,
    legacyMode: "image2video" as const,
    compiledPrompt: "9:16 short drama, shot 2, preserve the actor and screen direction",
    narrative: {
      visualPrompt: "actor crosses frame left to right",
      reservedForLater: [],
    },
    camera: { cameraPrompt: "medium tracking shot" },
    performance: { actorDirection: "hesitate, then answer" },
    look: { continuityPrompt: "same wardrobe and warm practical light" },
    references: input.references,
    output: {
      durationSec: 6,
      aspectRatio: "9:16",
      resolution: "1080p",
      shotCount: 1,
    },
    policy: { authority: "server" as const },
  };
  const generationIntentDigest = `intent:sha256:${createHash("sha256").update(stableJson(intent)).digest("hex")}`;
  return {
    schemaVersion: 2,
    previewId: "preview-seedance-v2",
    presetId: "seedance",
    mode: "image2video",
    generationIntent: intent,
    generationIntentDigest,
    generationScenario,
    outputAudioPolicy,
    providerRouteRef: {
      schemaVersion: 1,
      routeId: "volcengine.ark.seedance2.multimodal",
      providerId: "volcengine_ark",
      modelId: "doubao-seedance-2-0-260128",
      endpointId: "ark.v3.contents.generations.tasks",
      region: "cn-beijing",
      accountTier: "online",
    },
    capabilityProfileRef: {
      ...SEEDANCE_V2_LEGACY_IMAGE_PROFILE_V4,
    },
    adapterRevision: "openclaw-seedance-runtime/v2",
    runtimeRef: {
      runtimeId: "runtime-seedance",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    },
    constraintPlan: [
      {
        intentPath: "generationScenario",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        reasonCode: "scenario_native",
        messageKey: "media.scenario_native",
      },
      {
        intentPath: "outputAudioPolicy",
        sourceRef: "shot:R4",
        sourceRevision: "R4",
        required: true,
        support: "native",
        reasonCode: "audio_native",
        messageKey: "media.audio_native",
      },
      {
        intentPath: "compiledPrompt",
        sourceRef: "prompt-pack:R3",
        sourceRevision: "R3",
        required: true,
        support: "prompt",
        reasonCode: "prompt_compiled",
        messageKey: "media.prompt_compiled",
      },
      ...input.references.map((item) => ({
        intentPath: `references.${item.role}.${item.ordinal}`,
        sourceRef: `shot:R4`,
        sourceRevision: "R4",
        required: true,
        support: "native" as const,
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlot(
  ref: MediaGenerationIntentReference,
  source: MediaGenRuntimeSourceSlot["source"],
): MediaGenRuntimeSourceSlot {
  return {
    role: ref.role,
    ordinal: ref.ordinal,
    ...(ref.source.kind === "artifact" ? { artifactId: ref.source.artifactId } : {}),
    source,
  };
}

function vendorInput(
  frozenPlan: MediaGenRuntimeFrozenPlanV2,
  sources: MediaGenRuntimeSourceSlot[],
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-seedance",
    presetId: "seedance",
    mode: "image2video",
    prompt: frozenPlan.generationIntent.compiledPrompt,
    durationSec: 6,
    resolution: "1080p",
    params: { ratio: "9:16" },
    sources,
    frozenPlan,
  };
}

describe("Seedance Runtime Adapter V2", () => {
  const job = (mode: "text2video" | "image2video", id: string) => `seedance-v2:${mode}:${id}`;

  it("advertises both exact official Ark routes and no claims for a custom base", () => {
    expect(createSeedanceV2RuntimeVendor({ apiKey: "ark-key" }).capabilityRouteClaims).toEqual([
      expect.objectContaining({
        presetId: "seedance",
        mode: "text2video",
        route: expect.objectContaining({
          routeId: "volcengine.ark.seedance2.text2video",
        }),
      }),
      expect.objectContaining({
        presetId: "seedance",
        mode: "image2video",
        route: expect.objectContaining({
          routeId: "volcengine.ark.seedance2.multimodal",
        }),
      }),
    ]);
    expect(
      createSeedanceV2RuntimeVendor({
        apiKey: "ark-key",
        baseUrl: "https://proxy.example.test/api/v3",
      }).capabilityRouteClaims,
    ).toBeUndefined();
  });

  it("keeps the frozen plan only on submit/retry at the public gateway parser", () => {
    const ref = reference({ role: "subject", ordinal: 0, mediaClass: "image" });
    const frozenPlan = plan({
      references: [ref],
      scenario: "subject_reference_to_video",
      audio: "silent",
    });
    const base = {
      taskId: "task-wire",
      workspaceId: "ws-1",
      correlationId: "corr-wire",
      presetId: "seedance",
      mode: "image2video",
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-subject-0",
          role: "subject",
          ordinal: 0,
        },
      ],
    };
    expect(
      parseDispatch({ ...base, op: "submit", prompt: "prompt", frozenPlan })?.frozenPlan,
    ).toEqual(frozenPlan);
    expect(
      parseDispatch({
        ...base,
        op: "submit",
        prompt: "prompt",
        frozenPlan,
        executionAttempt: 1,
        frozenPlanDigest: `sha256:${"e".repeat(64)}`,
        spatialInputEnvelope: {
          schemaVersion: 1,
          envelopeDigest: `spa_env:sha256:${"a".repeat(64)}`,
          references: [
            {
              artifactId: "artifact-subject-0",
              checksum: `sha256:${"b".repeat(64)}`,
              role: "subject",
              ordinal: 0,
            },
          ],
        },
      }),
    ).toMatchObject({ executionAttempt: 1, spatialInputEnvelope: { schemaVersion: 1 } });
    const staleCompiledPromptPath = structuredClone(frozenPlan);
    staleCompiledPromptPath.constraintPlan = staleCompiledPromptPath.constraintPlan.map((row) =>
      row.intentPath === "compiledPrompt"
        ? { ...row, intentPath: "narrative.compiledPrompt" }
        : row,
    );
    expect(
      parseDispatch({
        ...base,
        op: "submit",
        prompt: "prompt",
        frozenPlan: staleCompiledPromptPath,
      }),
    ).toBeNull();
    expect(parseDispatch({ ...base, op: "poll", frozenPlan })).toBeNull();
  });

  it("keeps exact V3 typed audio/video mapping for historical frozen work", () => {
    const imageBytes = Buffer.from("image-reference");
    const audioBytes = Buffer.from("audio-reference");
    const refs = [
      reference({ role: "subject", ordinal: 0, mediaClass: "image", digest: sha(imageBytes) }),
      reference({ role: "source_video", ordinal: 0, mediaClass: "video", kind: "runtime_local" }),
      reference({ role: "voice", ordinal: 0, mediaClass: "audio", digest: sha(audioBytes) }),
    ];
    const frozenPlan = plan({ references: refs });
    frozenPlan.capabilityProfileRef = { ...SEEDANCE_V2_LEGACY_IMAGE_PROFILE };
    expect(parseMediaGenRuntimeFrozenPlan(frozenPlan)).toEqual(frozenPlan);
    const compiled = compileSeedanceV2Request(
      vendorInput(frozenPlan, [
        sourceSlot(refs[0], { bytes: imageBytes, mimeType: "image/png", sha256: sha(imageBytes) }),
        sourceSlot(refs[1], {
          providerRef: "asset://trusted-video-1",
          mimeType: "video/mp4",
          sha256: sha("source_video-0"),
        }),
        sourceSlot(refs[2], { bytes: audioBytes, mimeType: "audio/wav", sha256: sha(audioBytes) }),
      ]),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(Object.keys(compiled.body)).toEqual([
      "model",
      "content",
      "generate_audio",
      "ratio",
      "duration",
      "resolution",
    ]);
    expect(compiled.body).toMatchObject({
      model: "doubao-seedance-2-0-260128",
      generate_audio: true,
      ratio: "9:16",
      duration: 6,
      resolution: "1080p",
      content: [
        { type: "text" },
        { type: "image_url", role: "reference_image" },
        {
          type: "video_url",
          role: "reference_video",
          video_url: { url: "asset://trusted-video-1" },
        },
        { type: "audio_url", role: "reference_audio" },
      ],
    });
    expect(compiled.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(compiled.body)).not.toContain("runtime-seedance");
  });

  it("rejects a stale or forged capability-profile digest", () => {
    const ref = reference({ role: "subject", ordinal: 0, mediaClass: "image" });
    const frozenPlan = plan({
      references: [ref],
      scenario: "subject_reference_to_video",
      audio: "silent",
    });
    frozenPlan.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;

    expect(
      compileSeedanceV2Request(
        vendorInput(frozenPlan, [
          sourceSlot(ref, {
            bytes: Buffer.from("subject-0"),
            mimeType: "image/png",
            sha256: sha("subject-0"),
          }),
        ]),
      ),
    ).toMatchObject({ ok: false });
  });

  it("keeps an exact historical V3 multimodal frozen receipt executable", () => {
    const ref = reference({ role: "first_frame", ordinal: 0, mediaClass: "image" });
    const frozenPlan = plan({
      references: [ref],
      scenario: "first_frame_to_video",
      audio: "silent",
    });
    frozenPlan.capabilityProfileRef = { ...SEEDANCE_V2_LEGACY_IMAGE_PROFILE };

    expect(
      compileSeedanceV2Request(
        vendorInput(frozenPlan, [
          sourceSlot(ref, {
            bytes: Buffer.from("first-frame"),
            mimeType: "image/png",
            sha256: sha("first_frame-0"),
          }),
        ]),
      ),
    ).toMatchObject({ ok: true });
  });

  it("keeps frozen V4 image-only by rejecting a slot outside its evidenced subset", () => {
    const subject = reference({ role: "subject", ordinal: 0, mediaClass: "image" });
    const voice = reference({ role: "voice", ordinal: 0, mediaClass: "audio" });
    const frozenPlan = plan({ references: [subject, voice] });
    expect(
      compileSeedanceV2Request(
        vendorInput(frozenPlan, [
          sourceSlot(subject, {
            bytes: Buffer.from("subject"),
            mimeType: "image/png",
            sha256: sha("subject-0"),
          }),
          sourceSlot(voice, {
            bytes: Buffer.from("voice"),
            mimeType: "audio/wav",
            sha256: sha("voice-0"),
          }),
        ]),
      ),
    ).toMatchObject({ ok: false });
  });

  it("preserves all nine frozen V4 image references across internal roles", () => {
    const refs = [
      ...Array.from({ length: 5 }, (_, ordinal) =>
        reference({ role: "subject", ordinal, mediaClass: "image" }),
      ),
      ...Array.from({ length: 4 }, (_, ordinal) =>
        reference({ role: "style", ordinal, mediaClass: "image" }),
      ),
    ];
    const frozenPlan = plan({
      references: refs,
      scenario: "multimodal_reference_to_video",
      audio: "silent",
    });
    const compiled = compileSeedanceV2Request(
      vendorInput(
        frozenPlan,
        refs.map((ref) =>
          sourceSlot(ref, {
            bytes: Buffer.from(`${ref.role}-${ref.ordinal}`),
            mimeType: "image/png",
            sha256: sha(`${ref.role}-${ref.ordinal}`),
          }),
        ),
      ),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.body.content).toHaveLength(10);
    expect(compiled.body.content.slice(1)).toEqual(
      refs.map((ref) =>
        expect.objectContaining({
          type: "image_url",
          role: "reference_image",
          image_url: {
            url: `data:image/png;base64,${Buffer.from(`${ref.role}-${ref.ordinal}`).toString(
              "base64",
            )}`,
          },
        }),
      ),
    );
  });

  it("fails closed on frame/multimodal mixing and on reference overflow", () => {
    const frame = reference({ role: "first_frame", ordinal: 0, mediaClass: "image" });
    const voice = reference({ role: "voice", ordinal: 0, mediaClass: "audio" });
    const mixed = plan({ references: [frame, voice] });
    const mixedResult = compileSeedanceV2Request(
      vendorInput(mixed, [
        sourceSlot(frame, {
          bytes: Buffer.from("frame"),
          mimeType: "image/png",
          sha256: sha("first_frame-0"),
        }),
        sourceSlot(voice, {
          bytes: Buffer.from("voice"),
          mimeType: "audio/wav",
          sha256: sha("voice-0"),
        }),
      ]),
    );
    expect(mixedResult).toMatchObject({ ok: false });

    const many = [
      ...Array.from({ length: 5 }, (_, ordinal) =>
        reference({ role: "subject", ordinal, mediaClass: "image" }),
      ),
      ...Array.from({ length: 5 }, (_, ordinal) =>
        reference({ role: "style", ordinal, mediaClass: "image" }),
      ),
    ];
    const overflow = plan({
      references: many,
      scenario: "multimodal_reference_to_video",
      audio: "silent",
    });
    const overflowResult = compileSeedanceV2Request(
      vendorInput(
        overflow,
        many.map((ref) =>
          sourceSlot(ref, {
            bytes: Buffer.from(`${ref.role}-${ref.ordinal}`),
            mimeType: "image/png",
            sha256: sha(`${ref.role}-${ref.ordinal}`),
          }),
        ),
      ),
    );
    expect(overflowResult).toMatchObject({ ok: false });
  });

  it("normalizes submit/poll/cancel and marks a lost create receipt unknown", async () => {
    const ref = reference({ role: "subject", ordinal: 0, mediaClass: "image" });
    const frozenPlan = plan({
      references: [ref],
      scenario: "subject_reference_to_video",
      audio: "silent",
    });
    const input = vendorInput(frozenPlan, [
      sourceSlot(ref, {
        bytes: Buffer.from("subject-0"),
        mimeType: "image/png",
        sha256: sha("subject-0"),
      }),
    ]);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init });
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "ark-job-1" }), { status: 200 });
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          status: "succeeded",
          content: { video_url: "https://cdn.example/out.mp4" },
          duration: 6,
          resolution: "1080p",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const vendor = createSeedanceV2RuntimeVendor({ apiKey: "ark-key", fetchImpl });
    expect(await vendor.submit(input)).toMatchObject({
      state: "processing",
      vendorJobId: job("image2video", "ark-job-1"),
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: "volcengine.ark.seedance2.multimodal",
        adapterRevision: "openclaw-seedance-runtime/v2",
        operation: "submit",
        outcome: "processing",
        qualityOutcome: "not_run",
      },
    });
    expect(await vendor.reconcile!(job("image2video", "ark-job-1"))).toMatchObject({
      state: "succeeded",
      output: { mediaRef: "https://cdn.example/out.mp4" },
      providerObservation: {
        routeId: "volcengine.ark.seedance2.multimodal",
        adapterRevision: "openclaw-seedance-runtime/v2",
        operation: "reconcile",
        outcome: "succeeded",
      },
    });
    await vendor.cancel!(job("image2video", "ark-job-1"));
    expect(calls.map((call) => call.init?.method)).toEqual(["POST", "GET", "DELETE"]);

    const unknownVendor = createSeedanceV2RuntimeVendor({
      apiKey: "ark-key",
      fetchImpl: vi.fn(async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch,
    });
    expect(await unknownVendor.submit(input)).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
    });
  });

  it("binds Spatial acceptance only after native content mapping receives a job receipt", async () => {
    const bytes = Buffer.from("first-frame-spatial");
    const ref = reference({
      role: "first_frame",
      ordinal: 0,
      mediaClass: "image",
      digest: sha(bytes),
    });
    const frozenPlan = plan({
      references: [ref],
      scenario: "first_frame_to_video",
      audio: "silent",
    });
    const input: MediaGenRuntimeVendorInput = {
      ...vendorInput(frozenPlan, [
        sourceSlot(ref, { bytes, mimeType: "image/png", sha256: sha(bytes) }),
      ]),
      executionAttempt: 1,
      frozenPlanDigest: `sha256:${"e".repeat(64)}`,
      spatialInputEnvelope: {
        schemaVersion: 1,
        envelopeDigest: `spa_env:sha256:${"a".repeat(64)}`,
        references: [
          {
            assetRefId: "aref-first-frame",
            artifactId: "artifact-first_frame-0",
            checksum: `sha256:${sha(bytes)}`,
            role: "first_frame",
            ordinal: 0,
          },
        ],
      },
    };
    const vendor = createSeedanceV2RuntimeVendor({
      apiKey: "ark-key",
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ id: "ark-spatial-1" }), { status: 200 }),
      ) as unknown as typeof fetch,
    });
    await expect(vendor.submit(input)).resolves.toMatchObject({
      state: "processing",
      vendorJobId: job("image2video", "ark-spatial-1"),
      spatialInputAcceptance: {
        envelopeDigest: input.spatialInputEnvelope!.envelopeDigest,
        executionAttempt: 1,
        frozenPlanDigest: input.frozenPlanDigest,
        runtimeJobId: job("image2video", "ark-spatial-1"),
        references: input.spatialInputEnvelope!.references,
      },
    });
    await expect(
      vendor.submit({
        ...input,
        spatialInputEnvelope: {
          ...input.spatialInputEnvelope!,
          references: [
            { ...input.spatialInputEnvelope!.references[0]!, checksum: `sha256:${"f".repeat(64)}` },
          ],
        },
      }),
    ).resolves.toMatchObject({ state: "failed", reason: "vendor_rejected" });
  });

  it("runs submit to quality gate to Artifact Center through the existing executor", async () => {
    const bytes = Buffer.from("subject-0");
    const ref = reference({ role: "subject", ordinal: 0, mediaClass: "image", digest: sha(bytes) });
    const frozenPlan = plan({
      references: [ref],
      scenario: "subject_reference_to_video",
      audio: "silent",
    });
    const handoffArtifact = vi.fn(async () => ({
      artifactId: "artifact-output-1",
      mimeType: "video/mp4",
      sha256: sha("video-bytes"),
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-seedance",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(async () => ({
        bytes,
        mimeType: "image/png",
        sha256: sha(bytes),
      })),
      handoffArtifact,
    };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "ark-job-vertical" }), { status: 200 });
      }
      if (value.includes("ark-job-vertical")) {
        return new Response(
          JSON.stringify({
            status: "succeeded",
            content: { video_url: "https://cdn.example/video.mp4" },
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from("video-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createSeedanceV2RuntimeVendor({ apiKey: "ark-key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["cdn.example"],
      moderation: {
        screenInput: vi.fn(async () => ({ allowed: true })),
        screenOutput: vi.fn(async () => ({ allowed: true })),
      },
      labeler: {
        applyLabel: vi.fn(async (output) => ({ ...output, applied: true })),
      },
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-vertical",
      workspaceId: "ws-1",
      correlationId: "corr-1",
      presetId: "seedance",
      mode: "image2video",
      prompt: frozenPlan.generationIntent.compiledPrompt,
      references: [
        {
          kind: "artifact",
          artifactId: "artifact-subject-0",
          role: "subject",
          ordinal: 0,
        },
      ],
      durationSec: 6,
      resolution: "1080p",
      params: { ratio: "9:16" },
      executionAttempt: 1,
      frozenPlanDigest: `sha256:${"e".repeat(64)}`,
      frozenPlan,
      spatialInputEnvelope: {
        schemaVersion: 1,
        envelopeDigest: `spa_env:sha256:${"a".repeat(64)}`,
        references: [
          {
            assetRefId: "aref-subject",
            artifactId: "artifact-subject-0",
            checksum: `sha256:${sha(bytes)}`,
            role: "subject",
            ordinal: 0,
          },
        ],
      },
    };
    const submitted = await executor.dispatch(dispatch);
    const runtimeJobId = job("image2video", "ark-job-vertical");
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId,
      spatialInputAcceptance: {
        executionAttempt: 1,
        frozenPlanDigest: dispatch.frozenPlanDigest,
        runtimeJobId,
        references: dispatch.spatialInputEnvelope!.references,
      },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-2",
      presetId: "seedance",
      mode: "image2video",
      runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-output-1" },
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: "volcengine.ark.seedance2.multimodal",
        adapterRevision: "openclaw-seedance-runtime/v2",
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
      snapshot: {
        executionOwner: "user_runtime",
        moderationStatus: "runtime_enforced",
        labelingStatus: "runtime_applied",
      },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
