import type { MediaGenReferenceRole, MediaGenRuntimeDispatch } from "../media-gen-runtime-http.js";
import type {
  MediaGenRuntimeBridge,
  MediaGenRuntimeSource,
  MediaGenRuntimeSourceSlot,
} from "./types.js";

export type MediaGenRuntimeLocalReferenceResolver = (input: {
  dispatch: MediaGenRuntimeDispatch;
  runtimeLocalRef: string;
  role: MediaGenReferenceRole;
  ordinal: number;
}) => Promise<MediaGenRuntimeSource>;

export async function resolveMediaGenRuntimeSources(input: {
  dispatch: MediaGenRuntimeDispatch;
  bridge: MediaGenRuntimeBridge;
  resolveRuntimeLocalReference?: MediaGenRuntimeLocalReferenceResolver;
}): Promise<{ source?: MediaGenRuntimeSource; sources?: MediaGenRuntimeSourceSlot[] }> {
  const { dispatch } = input;
  const slots = dispatch.references;
  if (!slots?.length) {
    if (!dispatch.reference) return {};
    if (dispatch.reference.kind === "runtime_local") {
      if (!input.resolveRuntimeLocalReference || !dispatch.reference.runtimeLocalRef) {
        throw new Error("runtime_local media references require a configured local resolver");
      }
      return {
        source: await input.resolveRuntimeLocalReference({
          dispatch,
          runtimeLocalRef: dispatch.reference.runtimeLocalRef,
          role: "subject",
          ordinal: 0,
        }),
      };
    }
    if (!dispatch.reference.artifactId) {
      throw new Error("artifact reference is missing artifactId");
    }
    return {
      source: await input.bridge.resolveArtifactReference({
        dispatch,
        artifactId: dispatch.reference.artifactId,
        role: "subject",
        ordinal: 0,
      }),
    };
  }

  const sources: MediaGenRuntimeSourceSlot[] = [];
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    const role = slot.role ?? "subject";
    const ordinal = slot.ordinal ?? index;
    if (slot.kind === "runtime_local") {
      if (!input.resolveRuntimeLocalReference || !slot.runtimeLocalRef) {
        throw new Error("runtime_local media references require a configured local resolver");
      }
      sources.push({
        role,
        ordinal,
        source: await input.resolveRuntimeLocalReference({
          dispatch,
          runtimeLocalRef: slot.runtimeLocalRef,
          role,
          ordinal,
        }),
      });
      continue;
    }
    if (!slot.artifactId) throw new Error("artifact reference is missing artifactId");
    sources.push({
      role,
      ordinal,
      source: await input.bridge.resolveArtifactReference({
        dispatch,
        artifactId: slot.artifactId,
        role,
        ordinal,
      }),
    });
  }
  return { sources };
}
