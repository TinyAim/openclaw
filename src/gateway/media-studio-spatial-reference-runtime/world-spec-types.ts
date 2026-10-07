/** Runtime mirrors of the bounded Contracts world/v1 public payload. */
export type MediaSpatialVec3 = { x: number; y: number; z: number };
export interface MediaSpatialTerrainSurface {
  schemaVersion: 1;
  kind: "heightfield";
  origin: MediaSpatialVec3;
  widthM: number;
  lengthM: number;
  depthM: number;
  rows: number;
  columns: number;
  heightsM: number[];
}
export interface MediaSpatialComponentRod {
  partId: string;
  start: MediaSpatialVec3;
  end: MediaSpatialVec3;
  startRadiusM: number;
  endRadiusM: number;
}
export interface MediaSpatialComponentEllipsoid {
  partId: string;
  center: MediaSpatialVec3;
  radiiM: MediaSpatialVec3;
}
export type MediaSpatialComponentSpec =
  | {
      schemaVersion: 1;
      kind: "tree";
      trunk: MediaSpatialComponentRod;
      branches: MediaSpatialComponentRod[];
      roots: MediaSpatialComponentRod[];
      crowns: MediaSpatialComponentEllipsoid[];
    }
  | {
      schemaVersion: 1;
      kind: "log";
      path: MediaSpatialVec3[];
      radiiM: number[];
      branches: MediaSpatialComponentRod[];
    }
  | { schemaVersion: 1; kind: "rock"; lobes: MediaSpatialComponentEllipsoid[] };
