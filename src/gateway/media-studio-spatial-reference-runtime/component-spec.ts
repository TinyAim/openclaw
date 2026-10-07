/** Closed connected component declarations. All coordinates are node-local meters. */
import type {
  MediaSpatialComponentSpec,
  MediaSpatialComponentRod as Rod,
  MediaSpatialComponentEllipsoid as Ellipsoid,
  MediaSpatialVec3 as V,
} from "./world-spec-types.js";
export const MEDIA_SPATIAL_COMPONENT_LIMITS = {
  maxParts: 32,
  maxBranches: 12,
  maxRoots: 8,
  maxCrowns: 8,
  maxLogPoints: 8,
  maxRockLobes: 8,
} as const;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const only = (r: Record<string, unknown>, keys: string[]) =>
  Object.keys(r).every((k) => keys.includes(k));
const finite = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(v);
const vec = (v: unknown, positive = false): V | undefined => {
  const r = obj(v);
  if (
    !r ||
    !only(r, ["x", "y", "z"]) ||
    !["x", "y", "z"].every((k) => finite(r[k], positive ? 0.005 : -100, 100))
  )
    return undefined;
  return { x: r.x as number, y: r.y as number, z: r.z as number };
};
const distance = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function rod(v: unknown): Rod | undefined {
  const r = obj(v);
  if (
    !r ||
    !only(r, ["partId", "start", "end", "startRadiusM", "endRadiusM"]) ||
    !id(r.partId) ||
    !finite(r.startRadiusM, 0.005, 5) ||
    !finite(r.endRadiusM, 0.005, 5)
  )
    return undefined;
  const start = vec(r.start),
    end = vec(r.end);
  if (!start || !end || distance(start, end) < 0.01 || distance(start, end) > 100) return undefined;
  return { partId: r.partId, start, end, startRadiusM: r.startRadiusM, endRadiusM: r.endRadiusM };
}
function ellipsoid(v: unknown): Ellipsoid | undefined {
  const r = obj(v);
  if (!r || !only(r, ["partId", "center", "radiiM"]) || !id(r.partId)) return undefined;
  const center = vec(r.center),
    radiiM = vec(r.radiiM, true);
  if (!center || !radiiM || Math.max(radiiM.x, radiiM.y, radiiM.z) > 10) return undefined;
  return { partId: r.partId, center, radiiM };
}
function list<T>(v: unknown, max: number, parse: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const values = v.map(parse);
  return values.every((x) => x !== undefined) ? (values as T[]) : undefined;
}
export function mediaSpatialRodContainsPoint(r: Rod, p: V, tolerance = 0.01): boolean {
  const dx = r.end.x - r.start.x,
    dy = r.end.y - r.start.y,
    dz = r.end.z - r.start.z;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - r.start.x) * dx + (p.y - r.start.y) * dy + (p.z - r.start.z) * dz) /
        (dx * dx + dy * dy + dz * dz),
    ),
  );
  return (
    distance(p, { x: r.start.x + t * dx, y: r.start.y + t * dy, z: r.start.z + t * dz }) <=
    r.startRadiusM + t * (r.endRadiusM - r.startRadiusM) + tolerance
  );
}
function connectedRods(base: Rod[], additions: Rod[]): boolean {
  const known = [...base];
  for (const r of additions) {
    if (!known.some((k) => mediaSpatialRodContainsPoint(k, r.start))) return false;
    known.push(r);
  }
  return true;
}
function crownTouchesRod(c: Ellipsoid, r: Rod): boolean {
  // An actual rod-axis point inside the crown guarantees geometry contact.
  const a = {
    x: (r.start.x - c.center.x) / c.radiiM.x,
    y: (r.start.y - c.center.y) / c.radiiM.y,
    z: (r.start.z - c.center.z) / c.radiiM.z,
  };
  const b = {
    x: (r.end.x - c.center.x) / c.radiiM.x,
    y: (r.end.y - c.center.y) / c.radiiM.y,
    z: (r.end.z - c.center.z) / c.radiiM.z,
  };
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
    dd = d.x * d.x + d.y * d.y + d.z * d.z;
  const t = dd > 0 ? Math.max(0, Math.min(1, -(a.x * d.x + a.y * d.y + a.z * d.z) / dd)) : 0;
  return Math.hypot(a.x + t * d.x, a.y + t * d.y, a.z + t * d.z) <= 1 + 1e-8;
}
function lobesTouch(a: Ellipsoid, b: Ellipsoid): boolean {
  const d = distance(a.center, b.center);
  if (d < 1e-8) return true;
  const u = {
    x: (b.center.x - a.center.x) / d,
    y: (b.center.y - a.center.y) / d,
    z: (b.center.z - a.center.z) / d,
  };
  const radial = (c: Ellipsoid) =>
    1 / Math.hypot(u.x / c.radiiM.x, u.y / c.radiiM.y, u.z / c.radiiM.z);
  return d <= radial(a) + radial(b) + 1e-8;
}
export function parseSpatialReferenceComponentSpec(
  value: unknown,
): MediaSpatialComponentSpec | undefined {
  const r = obj(value);
  if (!r || r.schemaVersion !== 1) return undefined;
  if (r.kind === "tree") {
    if (!only(r, ["schemaVersion", "kind", "trunk", "branches", "roots", "crowns"]))
      return undefined;
    const trunk = rod(r.trunk),
      branches = list(r.branches, 12, rod),
      roots = list(r.roots, 8, rod),
      crowns = list(r.crowns, 8, ellipsoid);
    if (
      !trunk ||
      !branches ||
      !roots ||
      !crowns?.length ||
      trunk.end.y <= trunk.start.y ||
      !connectedRods([trunk], branches) ||
      !roots.every((root) => mediaSpatialRodContainsPoint(trunk, root.start)) ||
      !crowns.every((c) => [trunk, ...branches].some((x) => crownTouchesRod(c, x)))
    )
      return undefined;
    const all = [trunk, ...branches, ...roots, ...crowns];
    if (all.length > 32 || new Set(all.map((x) => x.partId)).size !== all.length) return undefined;
    return { schemaVersion: 1, kind: "tree", trunk, branches, roots, crowns };
  }
  if (r.kind === "log") {
    if (!only(r, ["schemaVersion", "kind", "path", "radiiM", "branches"])) return undefined;
    const path = list(r.path, 8, (v) => vec(v)),
      branches = list(r.branches, 12, rod);
    if (
      !path ||
      path.length < 2 ||
      !branches ||
      !Array.isArray(r.radiiM) ||
      r.radiiM.length !== path.length ||
      !r.radiiM.every((x) => finite(x, 0.005, 5))
    )
      return undefined;
    const radiiM = [...r.radiiM] as number[];
    const axis: Rod[] = path
      .slice(1)
      .map((p, i) => ({
        partId: "axis",
        start: path[i]!,
        end: p,
        startRadiusM: radiiM[i]!,
        endRadiusM: radiiM[i + 1]!,
      }));
    if (path.slice(1, -1).some((_, i) => distance(path[i]!, path[i + 2]!) < 0.01)) return undefined;
    if (
      axis.some((x) => distance(x.start, x.end) < 0.01 || distance(x.start, x.end) > 100) ||
      !connectedRods(axis, branches) ||
      branches.some((x) => x.partId === "axis") ||
      new Set(branches.map((x) => x.partId)).size !== branches.length
    )
      return undefined;
    return { schemaVersion: 1, kind: "log", path, radiiM, branches };
  }
  if (r.kind === "rock") {
    if (!only(r, ["schemaVersion", "kind", "lobes"])) return undefined;
    const lobes = list(r.lobes, 8, ellipsoid);
    if (!lobes?.length || new Set(lobes.map((x) => x.partId)).size !== lobes.length)
      return undefined;
    for (let i = 1; i < lobes.length; i++)
      if (!lobes.slice(0, i).some((a) => lobesTouch(a, lobes[i]!))) return undefined;
    return { schemaVersion: 1, kind: "rock", lobes };
  }
  return undefined;
}
