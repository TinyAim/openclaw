/** Closed mirror of Wisclaw terrain/v1, admitted before renderer work. */
export type SpatialReferenceTerrainProfile = {
  schemaVersion: 1;
  points: Array<{ x: number; y: number; z: number }>;
  widthM: number;
  depthM: number;
};

export function parseSpatialReferenceTerrainProfile(
  value: unknown,
): SpatialReferenceTerrainProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !["schemaVersion", "points", "widthM", "depthM"].includes(key),
    ) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.points) ||
    raw.points.length < 2 ||
    raw.points.length > 32
  )
    return undefined;
  const { widthM, depthM } = raw;
  if (
    typeof widthM !== "number" ||
    !Number.isFinite(widthM) ||
    widthM < 0.2 ||
    widthM > 100 ||
    typeof depthM !== "number" ||
    !Number.isFinite(depthM) ||
    depthM < 0.05 ||
    depthM > 100
  )
    return undefined;
  const points: SpatialReferenceTerrainProfile["points"] = [];
  for (const item of raw.points) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const point = item as Record<string, unknown>;
    if (
      Object.keys(point).some((key) => !["x", "y", "z"].includes(key)) ||
      ["x", "y", "z"].some(
        (key) =>
          typeof point[key] !== "number" ||
          !Number.isFinite(point[key]) ||
          Math.abs(point[key] as number) > 1000,
      )
    )
      return undefined;
    const next = { x: point.x as number, y: point.y as number, z: point.z as number };
    const previous = points[points.length - 1];
    if (previous && Math.hypot(next.x - previous.x, next.z - previous.z) < 0.001) return undefined;
    const before = points[points.length - 2];
    if (previous && before) {
      const ax = previous.x - before.x,
        az = previous.z - before.z;
      const bx = next.x - previous.x,
        bz = next.z - previous.z;
      if (
        ax * bx + az * bz < 0 &&
        Math.abs(ax * bz - az * bx) <= 1e-9 * Math.hypot(ax, az) * Math.hypot(bx, bz)
      )
        return undefined;
    }
    points.push(next);
  }
  return { schemaVersion: 1, points, widthM, depthM };
}
