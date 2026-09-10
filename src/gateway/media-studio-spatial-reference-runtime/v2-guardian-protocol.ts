/**
 * Parent-side validation for the private v2 guardian event stream.
 *
 * The guardian is the only process allowed to open the renderer start gate.
 * Therefore a valid-looking child event is still invalid unless the parent
 * has observed the exact preceding checkpoint for this generation.
 */

type GuardianEvent = Record<string, unknown>;

export type SpatialReferenceV2GuardianEventKind =
  | "spawn-intent"
  | "worker-prepared"
  | "start-authorized"
  | "scope-observation"
  | "toolchain-proof"
  | "failure";

export type SpatialReferenceV2GuardianProtocolResult =
  | { kind: SpatialReferenceV2GuardianEventKind }
  | { kind: "protocol-error"; code: string };

type Phase =
  | "awaiting-spawn-intent"
  | "awaiting-worker-prepared"
  | "awaiting-start-authorized"
  | "start-authorized";

const KNOWN_EVENTS = new Set([
  "spatial-guardian-spawn-intent-v1",
  "spatial-guardian-worker-prepared-v1",
  "spatial-guardian-start-authorized-v1",
  "spatial-guardian-scope-observation-v1",
  "spatial-v2-toolchain-proof-v1",
  "spatial-v2-failed",
  "spatial-guardian-failed-v1",
]);

function protocolError(code: string): SpatialReferenceV2GuardianProtocolResult {
  return { kind: "protocol-error", code };
}

/**
 * Create a one-shot validator. It deliberately knows only event identity,
 * sequence, and phase. Payload validation remains next to the code that
 * materializes the typed lifecycle evidence.
 */
export function createSpatialReferenceV2GuardianProtocol(generation: string): {
  consume(message: GuardianEvent): SpatialReferenceV2GuardianProtocolResult | undefined;
  /** Fixture-only branch: the parent owns the start acknowledgement. */
  markParentAuthorizedStart(): void;
  phase(): Phase;
} {
  let current: Phase = "awaiting-spawn-intent";

  return {
    phase: () => current,
    markParentAuthorizedStart() {
      if (current === "awaiting-start-authorized") current = "start-authorized";
    },
    consume(event) {
      const type = event.type;
      if (typeof type !== "string" || !KNOWN_EVENTS.has(type)) return undefined;
      if (event.generation !== generation)
        return protocolError("spatial_guardian_event_identity_invalid");

      if (type === "spatial-v2-failed" || type === "spatial-guardian-failed-v1") {
        return { kind: "failure" };
      }
      if (type === "spatial-guardian-spawn-intent-v1") {
        if (current !== "awaiting-spawn-intent" || event.sequence !== 0) {
          return protocolError("spatial_guardian_event_out_of_order");
        }
        current = "awaiting-worker-prepared";
        return { kind: "spawn-intent" };
      }
      if (type === "spatial-guardian-worker-prepared-v1") {
        if (current !== "awaiting-worker-prepared" || event.sequence !== 1) {
          return protocolError("spatial_guardian_event_out_of_order");
        }
        current = "awaiting-start-authorized";
        return { kind: "worker-prepared" };
      }
      if (type === "spatial-guardian-start-authorized-v1") {
        if (current !== "awaiting-start-authorized" || event.sequence !== 2) {
          return protocolError("spatial_guardian_event_out_of_order");
        }
        current = "start-authorized";
        return { kind: "start-authorized" };
      }
      if (type === "spatial-guardian-scope-observation-v1") {
        if (current !== "start-authorized" || event.sequence !== 2) {
          return protocolError("spatial_guardian_event_out_of_order");
        }
        return { kind: "scope-observation" };
      }
      if (current !== "start-authorized") {
        return protocolError("spatial_guardian_event_out_of_order");
      }
      return { kind: "toolchain-proof" };
    },
  };
}
