/** Closed v1 expanded geometry budget; never counts a component as one mesh part. */
import type { MediaSpatialTerrainSurface, MediaSpatialComponentSpec } from "./world-spec-types.js";
type Node = {
  terrainSurface?: MediaSpatialTerrainSurface;
  componentSpec?: MediaSpatialComponentSpec;
  terrainProfile?: { points: unknown[] };
};
export function spatialReferenceWorldGeometryWithinBudget(nodes: Node[]): boolean {
  if (!nodes.some((n) => n.terrainSurface || n.componentSpec)) return true;
  let parts = 0,
    vertices = 0,
    triangles = 0;
  for (const n of nodes) {
    const s = n.terrainSurface,
      c = n.componentSpec;
    if (s) {
      const boundary = 2 * s.rows + 2 * s.columns - 4;
      parts++;
      vertices += s.rows * s.columns + boundary + 1;
      triangles += 2 * (s.rows - 1) * (s.columns - 1) + 3 * boundary;
    } else if (c?.kind === "tree") {
      const rods = 1 + c.branches.length + c.roots.length;
      parts += rods + c.crowns.length;
      vertices += rods * 18 + c.crowns.length * 52;
      triangles += rods * 32 + c.crowns.length * 100;
    } else if (c?.kind === "log") {
      parts += 1 + c.branches.length;
      vertices += c.path.length * 8 + 2 + c.branches.length * 18;
      triangles += c.path.length * 16 + c.branches.length * 32;
    } else if (c?.kind === "rock") {
      parts += c.lobes.length;
      vertices += c.lobes.length * 52;
      triangles += c.lobes.length * 100;
    } else if (n.terrainProfile) {
      parts++;
      vertices += n.terrainProfile.points.length * 4;
      triangles += n.terrainProfile.points.length * 8 - 4;
    } else {
      parts++;
      vertices += 128;
      triangles += 256;
    }
  }
  return nodes.length <= 64 && parts <= 256 && vertices <= 20000 && triangles <= 20000;
}
