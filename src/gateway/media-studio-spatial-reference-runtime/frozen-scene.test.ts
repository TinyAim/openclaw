import { expect, it } from "vitest";
import { mergeSpatialFrozenNodes } from "./frozen-scene.js";

it("merges absolute transforms by nodeId and retains static shape/appearance across seeks", () => {
  const original = [
    {
      nodeId: "chair",
      kind: "prop_placeholder",
      propType: "chair",
      appearance: { colorToken: "blue" },
      position: { x: 0, y: 0, z: 0 },
    },
  ];
  const dynamic = [{ nodeId: "chair", kind: "prop_placeholder", position: { x: 2, y: 0, z: 0 } }];
  const moved = mergeSpatialFrozenNodes(original, dynamic);
  expect(moved[0]).toEqual({ ...original[0], position: { x: 2, y: 0, z: 0 } });
  expect(mergeSpatialFrozenNodes(original, [])).toEqual(original);
  expect(mergeSpatialFrozenNodes(original, dynamic)).toEqual(moved);
  expect(original[0].position.x).toBe(0);
  expect(() =>
    mergeSpatialFrozenNodes(original, [{ nodeId: "foreign", kind: "prop_placeholder" }]),
  ).toThrow("identity_invalid");
  expect(() => mergeSpatialFrozenNodes(original, [...dynamic, ...dynamic])).toThrow(
    "identity_invalid",
  );
});
