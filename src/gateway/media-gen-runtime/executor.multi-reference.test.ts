import { describe, expect, it, vi } from "vitest";
import type { MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import { createOpenClawMediaGenRuntimeExecutor } from "./executor.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeVendor,
  MediaGenRuntimeVendorInput,
  MediaGenRuntimeVendorJob,
} from "./types.js";

// CP3-d multi-asset reference execution (Multi_Asset_Reference_Design_CP3.md §3 /
// §8). Split out of executor.test.ts to keep both files under the 500-line cap.
// These pin the runtime-side honesty boundary: a `references[]` dispatch is
// resolved per slot (role-aware grant) and handed to the vendor ONLY when the
// vendor declares multi-reference support AND every sensitive-role slot carries
// authorized per-slot consent — otherwise it fails closed before any vendor call.

function dispatch(overrides: Partial<MediaGenRuntimeDispatch> = {}): MediaGenRuntimeDispatch {
  return {
    op: "submit",
    taskId: "task-1",
    workspaceId: "ws-1",
    correlationId: "corr-1",
    presetId: "kling",
    mode: "text2video",
    prompt: "a short drama scene",
    ...overrides,
  };
}

describe("OpenClaw media-generation runtime executor · multi-reference", () => {
  it("resolves every reference slot with its role and hands the multi-source set to a multi-ref vendor", async () => {
    const resolveArtifactReference = vi.fn(async ({ artifactId }: { artifactId: string }) => ({
      bytes: Buffer.from(artifactId),
      mimeType: "image/png",
    }));
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference,
      handoffArtifact: vi.fn(),
    };
    const submit = vi.fn(
      async (_input: MediaGenRuntimeVendorInput): Promise<MediaGenRuntimeVendorJob> => ({
        state: "processing",
        vendorJobId: "job-multi",
      }),
    );
    const vendor: MediaGenRuntimeVendor = {
      presetId: "vidu",
      supportsMultiReference: true,
      isConfigured: () => true,
      submit,
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });

    const result = await executor.dispatch(
      dispatch({
        presetId: "vidu",
        references: [
          { kind: "artifact", artifactId: "ref-a", role: "subject", ordinal: 0 },
          { kind: "artifact", artifactId: "ref-b", role: "subject", ordinal: 1 },
        ],
      }),
    );

    expect(result).toMatchObject({ status: "processing", runtimeJobId: "job-multi" });
    expect(resolveArtifactReference).toHaveBeenCalledTimes(2);
    expect(resolveArtifactReference).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ artifactId: "ref-a", role: "subject" }),
    );
    expect(resolveArtifactReference).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ artifactId: "ref-b", role: "subject" }),
    );
    const sources = submit.mock.calls[0]![0].sources;
    expect(sources).toHaveLength(2);
    expect(sources?.[0]).toMatchObject({ role: "subject", ordinal: 0 });
  });

  it("refuses a multi-reference dispatch when the vendor does not declare multi-reference support", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "kling",
      isConfigured: () => true,
      submit: vi.fn(),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });

    const result = await executor.dispatch(
      dispatch({
        presetId: "kling",
        references: [{ kind: "artifact", artifactId: "ref-a", role: "subject", ordinal: 0 }],
      }),
    );

    expect(result).toMatchObject({ status: "failed", failureReason: "vendor_rejected" });
    expect(vendor.submit).not.toHaveBeenCalled();
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
  });

  it("blocks a sensitive-role slot that lacks authorized per-slot consent", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "vidu",
      supportsMultiReference: true,
      isConfigured: () => true,
      submit: vi.fn(),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });

    const result = await executor.dispatch(
      dispatch({
        presetId: "vidu",
        references: [{ kind: "artifact", artifactId: "ref-pose", role: "pose_face", ordinal: 0 }],
      }),
    );

    expect(result).toMatchObject({ status: "failed", failureReason: "content_blocked" });
    expect(vendor.submit).not.toHaveBeenCalled();
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
  });

  it("requires a persisted consentRefs set before executing a per-slot-consented multi-reference job", async () => {
    // Per-slot receipt honesty (parity with the singular `consentRef` gate): a slot
    // that carries subject consent but arrives with NO `consentRefs` means the
    // control plane did not persist it — the runtime cannot vouch for per-subject
    // authorization, so it fails closed (internal) before any vendor call.
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(),
      handoffArtifact: vi.fn(),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "vidu",
      supportsMultiReference: true,
      isConfigured: () => true,
      submit: vi.fn(),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({ bridge, vendors: [vendor] });

    const result = await executor.dispatch(
      dispatch({
        presetId: "vidu",
        references: [
          {
            kind: "artifact",
            artifactId: "ref-a",
            role: "subject",
            ordinal: 0,
            consent: { subjectType: "portrait", authorized: true },
          },
        ],
        // consentRefs intentionally absent → cannot vouch for the consent.
      }),
    );

    expect(result).toMatchObject({ status: "failed", failureReason: "internal" });
    expect(vendor.submit).not.toHaveBeenCalled();
    expect(bridge.resolveArtifactReference).not.toHaveBeenCalled();
  });

  it("stamps the FULL persisted consentRefs set onto the at-generation snapshot", async () => {
    const bridge: MediaGenRuntimeBridge = {
      runtimeId: "runtime-1",
      register: vi.fn(),
      resolveArtifactReference: vi.fn(async ({ artifactId }: { artifactId: string }) => ({
        bytes: Buffer.from(artifactId),
        mimeType: "image/png",
      })),
      handoffArtifact: vi.fn(async ({ output }) => ({
        artifactId: "artifact-multi",
        mimeType: output.mimeType,
      })),
    };
    const vendor: MediaGenRuntimeVendor = {
      presetId: "vidu",
      supportsMultiReference: true,
      isConfigured: () => true,
      submit: vi.fn(async () => ({
        state: "succeeded" as const,
        vendorJobId: "job-multi",
        output: { mediaRef: "https://cdn.example/out.mp4", mimeType: "video/mp4" },
      })),
      poll: vi.fn(),
    };
    const executor = createOpenClawMediaGenRuntimeExecutor({
      bridge,
      vendors: [vendor],
      fetchImpl: vi.fn(
        async () =>
          new Response("video", { status: 200, headers: { "content-type": "video/mp4" } }),
      ),
      allowedMediaHosts: ["cdn.example"],
    });

    const result = await executor.dispatch(
      dispatch({
        presetId: "vidu",
        mode: "image2video",
        references: [
          {
            kind: "artifact",
            artifactId: "ref-subject",
            role: "subject",
            ordinal: 0,
            consent: { subjectType: "portrait", authorized: true },
          },
          {
            kind: "artifact",
            artifactId: "ref-pose",
            role: "pose_face",
            ordinal: 1,
            consent: { subjectType: "pose_face", authorized: true },
          },
        ],
        consentRefs: ["mediagen-consent-0", "mediagen-consent-1"],
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.snapshot).toMatchObject({
      executionOwner: "user_runtime",
      consentRefs: ["mediagen-consent-0", "mediagen-consent-1"],
    });
  });
});
