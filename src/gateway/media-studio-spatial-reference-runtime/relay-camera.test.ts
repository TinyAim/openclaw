import { describe, expect, it } from "vitest";
import { parseSpatialReferenceRelayCamera } from "./relay-camera.js";
const base = {
  position: { x: 3, y: 1, z: 4 },
  targetPoint: { x: 0, y: 0.2, z: 0 },
  worldAimTarget: { x: 10, y: 0.2, z: 8 },
  focalLengthMm: 35,
  sensorWidthMm: 36,
};
describe("frozen relay camera projection", () => {
  it("preserves world aim, node binding and roll instead of resetting composition", () => {
    const camera = { ...base, aimMode: "look_at", targetNodeId: "hero", rollDegrees: 12 };
    expect(parseSpatialReferenceRelayCamera(camera)).toEqual(camera);
  });
  it("preserves normalized orientation and legacy camera fields", () => {
    const camera = {
      ...base,
      aimMode: "orientation",
      orientationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    };
    expect(parseSpatialReferenceRelayCamera(camera)).toEqual(camera);
    expect(parseSpatialReferenceRelayCamera(base)).toEqual(base);
  });
  it.each([
    { ...base, aimMode: "unknown" },
    { ...base, worldAimTarget: { x: NaN, y: 0, z: 0 } },
    { ...base, aimMode: "orientation" },
    { ...base, aimMode: "orientation", orientationQuaternion: { x: 0, y: 0, z: 0, w: 0 } },
    { ...base, aimMode: "look_at", rollDegrees: Infinity },
    { ...base, aimMode: "look_at", targetNodeId: "" },
  ])("rejects malformed explicit pose metadata %#", (value) =>
    expect(parseSpatialReferenceRelayCamera(value)).toBeUndefined(),
  );
});
