/** Absolute frame overlay. Missing/null fields inherit static authored data. */
export function mergeSpatialFrozenNodes<T extends { nodeId: string; kind: string }>(
  staticNodes: readonly T[],
  dynamicNodes: readonly ({ nodeId: string; kind: string } & Partial<T>)[],
): T[] {
  const staticIds = new Set(staticNodes.map((node) => node.nodeId));
  const dynamic = new Map<string, { nodeId: string; kind: string } & Partial<T>>();
  for (const node of dynamicNodes) {
    if (!staticIds.has(node.nodeId) || dynamic.has(node.nodeId))
      throw new Error("spatial_v2_frame_node_identity_invalid");
    dynamic.set(node.nodeId, node);
  }
  return staticNodes.map((node) => {
    const override = dynamic.get(node.nodeId);
    if (!override) return { ...node };
    if (override.kind !== node.kind) throw new Error("spatial_v2_frame_node_kind_changed");
    return {
      ...node,
      ...Object.fromEntries(Object.entries(override).filter(([, value]) => value != null)),
    };
  });
}
