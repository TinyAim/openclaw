import { describe, expect, it } from "vitest";
import { createSpatialReferenceV2GuardianProtocol } from "./v2-guardian-protocol.js";

const generation = "generation-1";

function event(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, generation, ...fields };
}

describe("Spatial v2 guardian event protocol", () => {
  it("rejects a toolchain proof before start authorization", () => {
    const protocol = createSpatialReferenceV2GuardianProtocol(generation);

    expect(protocol.consume(event("spatial-v2-toolchain-proof-v1"))).toEqual({
      kind: "protocol-error",
      code: "spatial_guardian_event_out_of_order",
    });
    expect(protocol.phase()).toBe("awaiting-spawn-intent");
  });

  it("rejects wrong-generation and wrong-sequence checkpoints", () => {
    const protocol = createSpatialReferenceV2GuardianProtocol(generation);

    expect(
      protocol.consume({
        type: "spatial-guardian-spawn-intent-v1",
        generation: "other-generation",
        sequence: 0,
      }),
    ).toEqual({
      kind: "protocol-error",
      code: "spatial_guardian_event_identity_invalid",
    });
    expect(protocol.consume(event("spatial-guardian-spawn-intent-v1", { sequence: 1 }))).toEqual({
      kind: "protocol-error",
      code: "spatial_guardian_event_out_of_order",
    });
  });

  it("rejects duplicate checkpoints after the phase has advanced", () => {
    const protocol = createSpatialReferenceV2GuardianProtocol(generation);

    expect(protocol.consume(event("spatial-guardian-spawn-intent-v1", { sequence: 0 }))).toEqual({
      kind: "spawn-intent",
    });
    expect(protocol.consume(event("spatial-guardian-spawn-intent-v1", { sequence: 0 }))).toEqual({
      kind: "protocol-error",
      code: "spatial_guardian_event_out_of_order",
    });
  });

  it("accepts the complete ordered checkpoint stream", () => {
    const protocol = createSpatialReferenceV2GuardianProtocol(generation);

    expect(protocol.consume(event("spatial-guardian-spawn-intent-v1", { sequence: 0 }))).toEqual({
      kind: "spawn-intent",
    });
    expect(protocol.consume(event("spatial-guardian-worker-prepared-v1", { sequence: 1 }))).toEqual(
      { kind: "worker-prepared" },
    );
    expect(
      protocol.consume(event("spatial-guardian-start-authorized-v1", { sequence: 2 })),
    ).toEqual({ kind: "start-authorized" });
    expect(protocol.consume(event("spatial-v2-toolchain-proof-v1"))).toEqual({
      kind: "toolchain-proof",
    });
    expect(
      protocol.consume(event("spatial-guardian-scope-observation-v1", { sequence: 2 })),
    ).toEqual({ kind: "scope-observation" });
  });
});
