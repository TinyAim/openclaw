import { describe, expect, it } from "vitest";
import type { SpatialReferenceRelayDispatchAck } from "../media-studio-spatial-reference-render-http.js";
import {
  referenceExpectedOutputs,
  referenceIdentity,
  parseReferenceReadback,
} from "./reference-execution.js";
import { v2Dispatch } from "./reference.test-harness.js";

function fixture() {
  const input = v2Dispatch();
  const ack: SpatialReferenceRelayDispatchAck = {
    ok: true,
    accepted: true,
    deferredSettlement: true,
    runtimeId: input.runtimeId,
    taskId: input.taskId,
    materializationId: input.materializationId,
    executionId: "spatial-test",
    dispatchAttemptId: input.dispatchAttemptId,
    attempt: input.attempt,
    sequence: input.sequence,
    leaseExpiresAt: input.leaseExpiresAt,
    intentFingerprint: input.intentFingerprint,
    executionFingerprint: input.executionFingerprint,
    blueprintDigest: input.blueprint.blueprintDigest,
  };
  return { input, ack, ...referenceIdentity(input, ack) };
}

describe("frozen reference recovery projections", () => {
  it("binds every output and source fact but permits rotated transport grants", () => {
    const { input, ack, identity } = fixture();
    const rotated = structuredClone(input);
    rotated.outputUploadGrant!.grantToken = "rotated";
    rotated.leaseExpiresAt = "2099-01-01T00:00:00Z";
    expect(referenceIdentity(rotated, ack).identity.frozenDispatchDigest).toBe(
      identity.frozenDispatchDigest,
    );
    rotated.outputUploadGrant!.artifactId = "different-artifact";
    expect(() => referenceIdentity(rotated, ack)).toThrow("output_identity_conflict");
    rotated.outputUploadGrant!.artifactId = input.outputUploadGrant!.artifactId;
    rotated.outputUploadGrants!.find((g) => g.slot === "composition_frame")!.artifactId =
      "different-artifact";
    expect(() => referenceIdentity(rotated, ack)).toThrow("output_identity_conflict");
    expect(referenceExpectedOutputs(input).map((o) => o.slot)).toEqual([
      "composition_frame",
      "motion_reference_video",
      "start_frame",
      "end_frame",
      "topdown_frame",
    ]);
  });
  it("requires exact server receipt identity and local render byte proof; pending is not finalized", () => {
    const { identity, expectedOutputs } = fixture();
    const proof = {
      slot: "composition_frame",
      ordinal: 0,
      artifactId: expectedOutputs[0]!.artifactId,
      size: 4,
      sha256Hex: "a".repeat(64),
      mimeType: "image/png" as const,
    };
    const body = {
      runtimeId: identity.runtimeId,
      taskId: identity.taskId,
      materializationId: identity.materializationId,
      dispatchAttemptId: identity.dispatchAttemptId,
      executionFingerprint: identity.executionFingerprint,
      expectedOutputs,
      cancelled: false,
      receipts: [{ ...proof, storageKey: "safe/receipt.png" }],
      pendingSlots: ["motion_reference_video"],
    };
    const read = parseReferenceReadback(body, identity, expectedOutputs, [proof]);
    expect(read.receipts).toHaveLength(1);
    expect(read.pendingSlots).toEqual(["motion_reference_video"]);
    for (const mutation of [
      { ...body, runtimeId: "foreign" },
      { ...body, receipts: [{ ...body.receipts[0], artifactId: "foreign" }] },
      { ...body, receipts: [{ ...body.receipts[0], sha256Hex: "b".repeat(64) }] },
      { ...body, receipts: [...body.receipts, ...body.receipts] },
    ])
      expect(() => parseReferenceReadback(mutation, identity, expectedOutputs, [proof])).toThrow(
        /mismatch/,
      );
  });
});
