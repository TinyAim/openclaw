/** Preserve the frozen shot pose at the authenticated Runtime relay boundary. */
type Vector3 = { x: number; y: number; z: number };
export type SpatialReferenceRelayCamera = {
  position: Vector3;
  targetPoint: Vector3;
  worldAimTarget?: Vector3;
  aimMode?: "look_at" | "orientation";
  targetNodeId?: string;
  orientationQuaternion?: Vector3 & { w: number };
  rollDegrees?: number;
  focalLengthMm: number;
  sensorWidthMm: number;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function vector(value: unknown): Vector3 | undefined {
  const raw = record(value);
  return raw && finite(raw.x) && finite(raw.y) && finite(raw.z)
    ? { x: raw.x, y: raw.y, z: raw.z }
    : undefined;
}

export function parseSpatialReferenceRelayCamera(
  value: unknown,
): SpatialReferenceRelayCamera | undefined {
  const raw = record(value);
  const position = vector(raw?.position),
    targetPoint = vector(raw?.targetPoint);
  if (!raw || !position || !targetPoint || !finite(raw.focalLengthMm) || !finite(raw.sensorWidthMm))
    return undefined;
  const worldAimTarget = raw.worldAimTarget === undefined ? undefined : vector(raw.worldAimTarget);
  if (raw.worldAimTarget !== undefined && !worldAimTarget) return undefined;
  const aimMode = raw.aimMode;
  if (aimMode !== undefined && aimMode !== "look_at" && aimMode !== "orientation") return undefined;
  const targetNodeId = typeof raw.targetNodeId === "string" ? raw.targetNodeId.trim() : undefined;
  if (raw.targetNodeId !== undefined && (!targetNodeId || aimMode !== "look_at")) return undefined;
  let orientationQuaternion: SpatialReferenceRelayCamera["orientationQuaternion"];
  if (raw.orientationQuaternion !== undefined) {
    const q = record(raw.orientationQuaternion),
      xyz = vector(q);
    if (!xyz || !finite(q?.w) || aimMode !== "orientation") return undefined;
    const magnitude = Math.hypot(xyz.x, xyz.y, xyz.z, q.w);
    if (Math.abs(magnitude - 1) > 1e-3) return undefined;
    orientationQuaternion = { ...xyz, w: q.w };
  }
  if (aimMode === "orientation" && !orientationQuaternion) return undefined;
  const rollDegrees = raw.rollDegrees;
  if (
    rollDegrees !== undefined &&
    (!finite(rollDegrees) || Math.abs(rollDegrees) > 180 || aimMode !== "look_at")
  )
    return undefined;
  return {
    position,
    targetPoint,
    focalLengthMm: raw.focalLengthMm,
    sensorWidthMm: raw.sensorWidthMm,
    ...(worldAimTarget ? { worldAimTarget } : {}),
    ...(aimMode ? { aimMode } : {}),
    ...(targetNodeId ? { targetNodeId } : {}),
    ...(orientationQuaternion ? { orientationQuaternion } : {}),
    ...(rollDegrees === undefined ? {} : { rollDegrees: rollDegrees as number }),
  };
}
