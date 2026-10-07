/** Bounded heightfield/v1. Local RH Y-up meters; node TRS is applied once. */
import type { MediaSpatialTerrainSurface, MediaSpatialVec3 } from "./world-spec-types.js";

export const MEDIA_SPATIAL_TERRAIN_SURFACE_LIMITS = {
  maxRows: 33,
  maxColumns: 33,
  maxSamples: 1089,
  minExtentM: 0.2,
  maxExtentM: 100,
  maxHeightM: 100,
} as const;
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

export function parseSpatialReferenceTerrainSurface(
  value: unknown,
): MediaSpatialTerrainSurface | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) =>
        ![
          "schemaVersion",
          "kind",
          "origin",
          "widthM",
          "lengthM",
          "rows",
          "columns",
          "heightsM",
          "depthM",
        ].includes(k),
    ) ||
    r.schemaVersion !== 1 ||
    r.kind !== "heightfield" ||
    !finite(r.widthM, 0.2, 100) ||
    !finite(r.lengthM, 0.2, 100) ||
    !finite(r.depthM, 0.05, 100) ||
    !Number.isInteger(r.rows) ||
    !Number.isInteger(r.columns) ||
    !finite(r.rows, 2, 33) ||
    !finite(r.columns, 2, 33) ||
    !Array.isArray(r.heightsM) ||
    r.heightsM.length !== r.rows * r.columns ||
    r.heightsM.length > 1089 ||
    !r.heightsM.every((v) => finite(v, -100, 100))
  )
    return undefined;
  if (!r.origin || typeof r.origin !== "object" || Array.isArray(r.origin)) return undefined;
  const o = r.origin as Record<string, unknown>;
  if (
    Object.keys(o).some((k) => !["x", "y", "z"].includes(k)) ||
    !finite(o.x, -1000, 1000) ||
    !finite(o.y, -1000, 1000) ||
    !finite(o.z, -1000, 1000)
  )
    return undefined;
  return {
    schemaVersion: 1,
    kind: "heightfield",
    origin: { x: o.x, y: o.y, z: o.z },
    widthM: r.widthM,
    lengthM: r.lengthM,
    depthM: r.depthM,
    rows: r.rows,
    columns: r.columns,
    heightsM: [...r.heightsM] as number[],
  };
}
