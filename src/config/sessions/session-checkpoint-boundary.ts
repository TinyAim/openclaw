import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSessionTranscriptLeafControl, scanSessionTranscriptTree } from "./transcript-tree.js";

/** Resolve an exact retained boundary without copying sibling branches or accepting broken ancestry. */
export function resolveCheckpointBoundaryPath<T>(
  events: readonly T[],
  boundaryId: string,
): T[] | null {
  const tree = scanSessionTranscriptTree(events);
  if (!boundaryId.trim() || tree.hasInvalidLeafControl) return null;
  const boundary = tree.byId.get(boundaryId);
  if (!boundary || isSessionTranscriptLeafControl(boundary.entry)) return null;
  const seenIds = new Set<string>();
  for (const node of tree.nodes) {
    if (seenIds.has(node.id)) return null;
    seenIds.add(node.id);
  }
  const path: typeof tree.nodes = [];
  const visited = new Set<string>();
  let id: string | null = boundaryId;
  while (id !== null) {
    if (visited.has(id)) return null;
    visited.add(id);
    const node = tree.byId.get(id);
    if (!node) return null;
    if (!isSessionTranscriptLeafControl(node.entry)) path.push(node);
    id = node.parentId;
  }
  if (path.length === 0) return null;
  return path.toReversed().map((node, index, nodes) => {
    const parentId = index ? nodes[index - 1]!.id : null;
    return isRecord(node.entry) ? ({ ...node.entry, parentId } as T) : node.entry;
  });
}
