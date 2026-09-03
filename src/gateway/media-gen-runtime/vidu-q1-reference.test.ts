import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSourceSlot,
  MediaGenRuntimeVendorInput,
} from "./types.js";
import {
  compileViduQ1ReferenceRequest,
  VIDU_Q1_REFERENCE_ADAPTER_REVISION,
  VIDU_Q1_REFERENCE_PROFILE_DIGEST,
  VIDU_Q1_REFERENCE_ROUTE_ID,
} from "./vidu-q1-reference-compiler.js";
import { createViduRuntimeVendor } from "./vidu-vendor.js";

const SUBJECT_BYTES = [
  Buffer.from("vidu-subject-front"),
  Buffer.from("vidu-subject-profile"),
  Buffer.from("vidu-subject-detail"),
];

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.href : value.url;
}

function requestBody(value: BodyInit | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function frozenPlan(
  input: {
    subjectBytes?: Buffer[];
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    prompt?: string;
  } = {},
): MediaGenRuntimeFrozenPlanV2 {
  const bytes = input.subjectBytes ?? SUBJECT_BYTES;
  const prompt = input.prompt ?? "Keep the same ceramic robot consistent across the workshop.";
  const references = bytes.map((value, index) => ({
    role: "subject" as const,
    ordinal: index,
    required: true,
    mediaClass: "image" as const,
    source: { kind: "artifact" as const, artifactId: `artifact-vidu-${index}` },
    assetRefId: `asset-vidu-${index}`,
    authorityRef: `artifact:vidu-${index}`,
    authorityVerified: true,
    mimeType: "image/png",
    sourceDigest: `sha256:${sha(value)}`,
  }));
  return {
    schemaVersion: 2,
    previewId: "preview-vidu-q1",
    presetId: "vidu",
    mode: "image2video",
    generationIntent: {
      schemaVersion: 2,
      identity: {
        projectId: "project-vidu",
        shotId: "shot-vidu",
        shotVersion: "R1",
        promptPackId: "pack-vidu",
        promptPackVersion: 1,
        promptPackUpdatedAt: "2026-07-31T00:00:00.000Z",
        promptPackDigest: `sha256:${"1".repeat(64)}`,
        sourceDigests: references.map((reference) => reference.sourceDigest),
      },
      generationScenario: "subject_reference_to_video",
      outputAudioPolicy: "silent",
      legacyMode: "image2video",
      compiledPrompt: prompt,
      narrative: { visualPrompt: prompt, reservedForLater: [] },
      camera: {},
      performance: {},
      look: {},
      references,
      output: {
        durationSec: input.durationSec ?? 5,
        aspectRatio: input.aspectRatio ?? "9:16",
        resolution: input.resolution ?? "1080p",
        fps: 24,
        shotCount: 1,
      },
      policy: { authority: "server" },
    },
    generationIntentDigest: `intent:sha256:${"2".repeat(64)}`,
    generationScenario: "subject_reference_to_video",
    outputAudioPolicy: "silent",
    providerRouteRef: {
      schemaVersion: 1,
      routeId: VIDU_Q1_REFERENCE_ROUTE_ID,
      providerId: "vidu_enterprise",
      modelId: "viduq1",
      endpointId: "vidu.ent.v2.reference2video",
      region: "unknown",
      accountTier: "api_key",
    },
    capabilityProfileRef: {
      profileId: "vidu.openclaw-runtime.viduq1.subject_reference.v1",
      revision: 1,
      digest: VIDU_Q1_REFERENCE_PROFILE_DIGEST,
    },
    adapterRevision: VIDU_Q1_REFERENCE_ADAPTER_REVISION,
    runtimeRef: {
      runtimeId: "runtime-vidu",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    },
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
      ...references.map((reference) => ({
        intentPath: `references.subject.${reference.ordinal}`,
        sourceRef: `asset:${reference.assetRefId}`,
        sourceRevision: "R1",
        required: true,
        support: "native" as const,
        providerSlot: "references.subject",
        reasonCode: "reference_native",
        messageKey: "media.reference_native",
      })),
      ...["output.durationSec", "output.aspectRatio", "output.resolution", "output.fps"].map(
        (path) => ({
          intentPath: path,
          sourceRef: "pack:R1",
          sourceRevision: "R1",
          required: false,
          support: "native" as const,
          providerField: path,
          reasonCode: "output_native",
          messageKey: "media.output_native",
        }),
      ),
    ],
    inputFingerprint: "3".repeat(64),
    intentFingerprint: "4".repeat(64),
  };
}

function sourceSlots(bytes = SUBJECT_BYTES): MediaGenRuntimeSourceSlot[] {
  return bytes.map((value, index) => ({
    role: "subject",
    ordinal: index,
    source: { bytes: value, mimeType: "image/png", sha256: sha(value) },
  }));
}

function vendorInput(
  plan = frozenPlan(),
  overrides: Partial<MediaGenRuntimeVendorInput> = {},
): MediaGenRuntimeVendorInput {
  return {
    taskId: "task-vidu",
    presetId: "vidu",
    mode: "image2video",
    prompt: plan.generationIntent.compiledPrompt,
    durationSec: plan.generationIntent.output.durationSec,
    resolution: plan.generationIntent.output.resolution,
    sources: sourceSlots(
      plan.generationIntent.references.map(
        (reference) =>
          SUBJECT_BYTES.find(
            (bytes) => sha(bytes) === reference.sourceDigest?.replace("sha256:", ""),
          ) ?? Buffer.from(`fallback-${reference.ordinal}`),
      ),
    ),
    frozenPlan: plan,
    ...overrides,
  };
}

describe("Vidu Q1 exact reference-to-video runtime", () => {
  it("compiles exact Q1 fields and submits to reference2video with Token auth", async () => {
    const input = vendorInput();
    const compiled = compileViduQ1ReferenceRequest(input);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.body).toEqual({
      model: "viduq1",
      images: SUBJECT_BYTES.map((bytes) => `data:image/png;base64,${bytes.toString("base64")}`),
      prompt: "Keep the same ceramic robot consistent across the workshop.",
      duration: 5,
      aspect_ratio: "9:16",
      resolution: "1080p",
      bgm: false,
      movement_amplitude: "auto",
      off_peak: false,
    });
    expect(compiled.providerRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const vendor = createViduRuntimeVendor({
      apiKey: "vidu-key",
      fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return new Response(JSON.stringify({ task_id: "vidu-q1-job" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await vendor.submit(input)).toMatchObject({
      state: "processing",
      vendorJobId: "vidu-q1-job",
      providerRequestDigest: compiled.providerRequestDigest,
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    expect(calls[0]?.url).toBe("https://api.vidu.com/ent/v2/reference2video");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Token vidu-key" });
    expect(JSON.parse(requestBody(calls[0]?.init?.body))).toEqual(compiled.body);
  });

  it("rejects stale identity, raw params, unsupported output, and source drift", () => {
    const stale = frozenPlan();
    stale.capabilityProfileRef.digest = `sha256:${"f".repeat(64)}`;
    expect(compileViduQ1ReferenceRequest(vendorInput(stale))).toMatchObject({ ok: false });
    expect(
      compileViduQ1ReferenceRequest(vendorInput(frozenPlan(), { params: { seed: 7 } })),
    ).toMatchObject({ ok: false });
    expect(
      compileViduQ1ReferenceRequest(
        vendorInput(frozenPlan({ durationSec: 6, aspectRatio: "4:3", resolution: "720p" })),
      ),
    ).toMatchObject({ ok: false });

    const drifted = sourceSlots();
    drifted[0] = {
      ...drifted[0],
      source: {
        bytes: Buffer.from("changed"),
        mimeType: "image/png",
        sha256: sha(Buffer.from("changed")),
      },
    };
    expect(
      compileViduQ1ReferenceRequest(vendorInput(frozenPlan(), { sources: drifted })),
    ).toMatchObject({ ok: false });
    expect(
      compileViduQ1ReferenceRequest(
        vendorInput(
          frozenPlan({ subjectBytes: Array.from({ length: 8 }, (_, i) => Buffer.from(`s-${i}`)) }),
          {
            sources: sourceSlots(Array.from({ length: 8 }, (_, i) => Buffer.from(`s-${i}`))),
          },
        ),
      ),
    ).toMatchObject({ ok: false });
  });

  it("marks ambiguous submit and normalizes poll, reconcile, and cancel", async () => {
    const ambiguous = createViduRuntimeVendor({
      apiKey: "vidu-key",
      fetchImpl: vi.fn(async () => {
        throw new Error("private transport detail");
      }),
    });
    const unknown = await ambiguous.submit(vendorInput());
    expect(unknown).toMatchObject({
      state: "submission_unknown",
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        routeId: VIDU_Q1_REFERENCE_ROUTE_ID,
        adapterRevision: VIDU_Q1_REFERENCE_ADAPTER_REVISION,
        operation: "submit",
        outcome: "submission_unknown",
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("private transport detail");

    let taskState: "processing" | "failed" | "success" = "processing";
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      calls.push({ url: value, method: init?.method, body: requestBody(init?.body) });
      if (value.endsWith("/reference2video")) {
        return new Response(JSON.stringify({ task_id: "vidu-state-job" }), { status: 200 });
      }
      if (value.endsWith("/cancel")) {
        return new Response("{}", { status: 200 });
      }
      if (taskState === "processing") {
        return new Response(JSON.stringify({ state: "queueing" }), { status: 200 });
      }
      if (taskState === "failed") {
        return new Response(
          JSON.stringify({ state: "failed", err_code: "CONTENT_POLICY_VIOLATION" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          state: "success",
          creations: [{ url: "https://media.example/vidu.mp4" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const vendor = createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl });
    await vendor.submit(vendorInput());
    expect(await vendor.poll("vidu-state-job")).toMatchObject({
      state: "processing",
      providerObservation: { operation: "poll", outcome: "processing" },
    });
    taskState = "failed";
    expect(await vendor.reconcile!("vidu-state-job")).toMatchObject({
      state: "failed",
      reason: "content_blocked",
      providerObservation: { operation: "reconcile", outcome: "failed" },
    });
    taskState = "success";
    expect(await vendor.poll("vidu-state-job")).toMatchObject({
      state: "succeeded",
      output: {
        mediaRef: "https://media.example/vidu.mp4",
        durationSec: 5,
        resolution: "1080p",
      },
    });
    await expect(vendor.cancel!("vidu-state-job")).resolves.toBeUndefined();
    expect(calls.at(-1)).toEqual({
      url: "https://api.vidu.com/ent/v2/tasks/vidu-state-job/cancel",
      method: "POST",
      body: JSON.stringify({ id: "vidu-state-job" }),
    });
  });

  it("downloads the expiring output before quality proof and Artifact handoff", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = requestUrl(url);
      if (value.endsWith("/reference2video") && init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "vidu-artifact-job" }), { status: 200 });
      }
      if (value.endsWith("/tasks/vidu-artifact-job/creations")) {
        return new Response(
          JSON.stringify({
            state: "success",
            creations: [{ url: "https://media.example/vidu.mp4" }],
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from("vidu-video-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;
    const handoffArtifact = vi.fn(async ({ sha256 }: { sha256: string }) => ({
      artifactId: "artifact-vidu-output",
      mimeType: "video/mp4",
      sha256,
      durationSec: 5,
      resolution: "1080p",
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-vidu",
      register: vi.fn(async () => undefined),
      resolveArtifactReference: vi.fn(async ({ artifactId }: { artifactId: string }) => {
        const index = Number(artifactId.split("-").at(-1));
        const bytes = SUBJECT_BYTES[index];
        return { bytes, mimeType: "image/png", sha256: sha(bytes) };
      }),
      handoffArtifact,
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [createViduRuntimeVendor({ apiKey: "vidu-key", fetchImpl })],
      fetchImpl,
      allowedMediaHosts: ["media.example"],
      validateMediaBytes: vi.fn(async () => ({ ok: true as const })),
    });
    const plan = frozenPlan();
    const dispatch: MediaGenRuntimeDispatch = {
      op: "submit",
      taskId: "task-vidu-artifact",
      workspaceId: "ws-vidu",
      correlationId: "corr-vidu-submit",
      presetId: "vidu",
      mode: "image2video",
      prompt: plan.generationIntent.compiledPrompt,
      durationSec: 5,
      resolution: "1080p",
      references: plan.generationIntent.references.map((reference) => ({
        kind: "artifact" as const,
        artifactId: reference.source.kind === "artifact" ? reference.source.artifactId : undefined,
        role: "subject" as const,
        ordinal: reference.ordinal,
      })),
      frozenPlan: plan,
    };
    const submitted = await executor.dispatch(dispatch);
    expect(submitted).toMatchObject({
      status: "processing",
      runtimeJobId: "vidu-artifact-job",
      providerObservation: { operation: "submit", outcome: "processing" },
    });
    const completed = await executor.dispatch({
      op: "poll",
      taskId: dispatch.taskId,
      workspaceId: dispatch.workspaceId,
      correlationId: "corr-vidu-poll",
      presetId: "vidu",
      mode: "image2video",
      runtimeJobId: submitted.runtimeJobId,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { artifactId: "artifact-vidu-output" },
      providerRequestDigest: expect.stringMatching(/^sha256:/u),
      providerObservation: {
        operation: "poll",
        outcome: "succeeded",
        qualityOutcome: "passed",
      },
    });
    expect(handoffArtifact).toHaveBeenCalledTimes(1);
  });
});
