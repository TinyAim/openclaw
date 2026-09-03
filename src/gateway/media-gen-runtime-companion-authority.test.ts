import { describe, expect, it } from "vitest";
import { parseDispatch } from "./media-gen-runtime-dispatch.js";

const base = {
  op: "submit",
  taskId: "task-companion-1",
  workspaceId: "workspace-1",
  correlationId: "correlation-1",
  presetId: "seedance",
  mode: "image2video",
  prompt: "Use the frozen reference.",
} as const;

describe("runtime-local companion Artifact authority", () => {
  it("preserves the safe companion id beside the opaque runtime handle", () => {
    expect(
      parseDispatch({
        ...base,
        references: [
          {
            kind: "runtime_local",
            runtimeLocalRef: "runtime-video-01",
            companionArtifactId: "artifact-video-01",
            role: "source_video",
            ordinal: 0,
          },
        ],
      })?.references?.[0],
    ).toMatchObject({
      kind: "runtime_local",
      runtimeLocalRef: "runtime-video-01",
      companionArtifactId: "artifact-video-01",
    });
  });

  it("rejects an empty companion and the field on the Artifact branch", () => {
    expect(
      parseDispatch({
        ...base,
        references: [
          {
            kind: "runtime_local",
            runtimeLocalRef: "runtime-video-01",
            companionArtifactId: "",
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseDispatch({
        ...base,
        references: [
          {
            kind: "artifact",
            artifactId: "artifact-video-01",
            companionArtifactId: "artifact-shadow",
          },
        ],
      }),
    ).toBeNull();
  });
});
