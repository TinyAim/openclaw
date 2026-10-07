/** Deterministic mannequin pose. Local units are one authored character height.
 * The root/path transform is applied once by the consumer. Flat local support
 * only: this is not terrain following, skeletal GLB, or a physics simulation.
 */
import type { MediaSpatialVec3 } from "./world-spec-types.js";

export const MEDIA_SPATIAL_HUMANOID_JOINTS = [
  "head",
  "neck",
  "hip",
  "leftHip",
  "rightHip",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftHand",
  "rightHand",
  "leftKnee",
  "rightKnee",
  "leftFoot",
  "rightFoot",
] as const;
export type MediaSpatialHumanoidJoint = (typeof MEDIA_SPATIAL_HUMANOID_JOINTS)[number];
export type MediaSpatialHumanoidAction = "walk" | "run" | "squat" | "crawl" | "prone";
export type MediaSpatialHumanoidPose = {
  schemaVersion: 1;
  algorithm: "humanoid_flat/v1";
  action: MediaSpatialHumanoidAction;
  progress: number;
  phase: number;
  joints: Record<MediaSpatialHumanoidJoint, MediaSpatialVec3>;
  support: {
    kind: "local_plane";
    planeY: 0;
    leftFoot: boolean;
    rightFoot: boolean;
    leftHand: boolean;
    rightHand: boolean;
    leftKnee: boolean;
    rightKnee: boolean;
    terrainFollowing: false;
  };
};
/** Strict frozen render reader: no arbitrary skeleton, code, or extra joints. */
export function parseSpatialReferenceActorPose(
  value: unknown,
): MediaSpatialHumanoidPose | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as MediaSpatialHumanoidPose;
  const keys = ["schemaVersion", "algorithm", "action", "progress", "phase", "joints", "support"];
  if (
    Object.keys(p).some((k) => !keys.includes(k)) ||
    p.schemaVersion !== 1 ||
    p.algorithm !== "humanoid_flat/v1" ||
    !["walk", "run", "squat", "crawl", "prone"].includes(p.action) ||
    !Number.isFinite(p.progress) ||
    p.progress < 0 ||
    p.progress > 1 ||
    !Number.isFinite(p.phase) ||
    p.phase < 0 ||
    p.phase >= 1 ||
    !p.joints ||
    Object.keys(p.joints).length !== MEDIA_SPATIAL_HUMANOID_JOINTS.length
  )
    return undefined;
  for (const key of MEDIA_SPATIAL_HUMANOID_JOINTS) {
    const j = p.joints[key];
    if (
      !j ||
      Object.keys(j).length !== 3 ||
      !["x", "y", "z"].every(
        (k) =>
          Number.isFinite(j[k as keyof MediaSpatialVec3]) &&
          Math.abs(j[k as keyof MediaSpatialVec3]) <= 2,
      )
    )
      return undefined;
  }
  const s = p.support;
  if (
    !s ||
    Object.keys(s).length !== 9 ||
    s.kind !== "local_plane" ||
    s.planeY !== 0 ||
    s.terrainFollowing !== false ||
    !["leftFoot", "rightFoot", "leftHand", "rightHand", "leftKnee", "rightKnee"].every(
      (k) => typeof s[k as keyof typeof s] === "boolean",
    )
  )
    return undefined;
  return p;
}
