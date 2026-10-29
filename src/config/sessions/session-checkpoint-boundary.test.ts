import { describe, expect, it } from "vitest";
import { resolveCheckpointBoundaryPath } from "./session-checkpoint-boundary.js";

const row = (id: string, parentId: string | null) => ({ type: "message", id, parentId });

describe("checkpoint transcript boundary", () => {
  it("copies only the selected ancestry and excludes sibling and later messages", () => {
    const events = [
      row("a", null),
      row("b", "a"),
      row("other", "a"),
      row("c", "b"),
      row("later", "c"),
    ];
    expect(resolveCheckpointBoundaryPath(events, "c")).toEqual([
      row("a", null),
      row("b", "a"),
      row("c", "b"),
    ]);
  });
  it("rejects missing boundaries, broken ancestry, cycles and duplicate identities", () => {
    expect(resolveCheckpointBoundaryPath([row("a", null)], "missing")).toBeNull();
    expect(resolveCheckpointBoundaryPath([row("b", "missing")], "b")).toBeNull();
    expect(resolveCheckpointBoundaryPath([row("a", "b"), row("b", "a")], "a")).toBeNull();
    expect(resolveCheckpointBoundaryPath([row("a", null), row("a", null)], "a")).toBeNull();
  });
  it("normalizes ancestry through leaf controls without accepting a control as the boundary", () => {
    const events = [
      row("a", null),
      row("hidden", "a"),
      { type: "leaf", id: "switch", parentId: "hidden", targetId: "a" },
      row("b", "switch"),
    ];
    expect(resolveCheckpointBoundaryPath(events, "b")).toEqual([row("a", null), row("b", "a")]);
    expect(resolveCheckpointBoundaryPath(events, "switch")).toBeNull();
  });
});
