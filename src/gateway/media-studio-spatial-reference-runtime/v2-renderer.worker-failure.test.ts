import { describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import type { ProcessSupervisor, SpawnInput } from "../../process/supervisor/types.js";
import { v2Dispatch } from "./reference.test-harness.js";
import { createSpatialReferenceV2Renderer } from "./v2-renderer.js";
import { supportsSpatialReferenceV2ResourceLimits } from "./v2-resource-watch.js";

const fixtureUrl = new URL("./v2-renderer.supervision.fixture.mjs", import.meta.url);

describe.skipIf(process.platform === "win32" || !supportsSpatialReferenceV2ResourceLimits())(
  "spatial v2 worker failure settlement",
  () => {
    it.each([
      ["spatial_v2_motion_encode_failed", undefined],
      ["spatial_guardian_worker_spawn_failed", undefined],
      ["spatial_v2_rss_observation_node_missing", "valid"],
      ["spatial_v2_rss_observation_node_missing", "invalid"],
    ] as const)(
      "preserves %s when its Guardian exits cleanly after extinction",
      async (failureCode, diagnosticMode) => {
        const owned = createProcessSupervisor();
        const supervisor: ProcessSupervisor = {
          acquireScopeCleanup: (scope, options) => owned.acquireScopeCleanup(scope, options),
          spawn: async (input: SpawnInput) =>
            owned.spawn({
              ...input,
              ...(input.mode === "child"
                ? {
                    argv: [
                      process.execPath,
                      fixtureUrl.pathname,
                      ...input.argv.slice(input.argv.indexOf("--request")),
                      "--worker-failure-code",
                      failureCode,
                      ...(diagnosticMode ? ["--native-diagnostic-mode", diagnosticMode] : []),
                    ],
                  }
                : {}),
            }),
          cancel: (...args) => owned.cancel(...args),
          cancelScope: (...args) => owned.cancelScope(...args),
          getRecord: (...args) => owned.getRecord(...args),
        };
        try {
          const renderer = createSpatialReferenceV2Renderer({
            chromiumExecutablePath: "fixture-no-browser",
            referenceRenderHtmlPath: "/fixture/no-html",
            supervisor,
            guardianWorkerUrl: fixtureUrl,
          });
          const error = await renderer
            .renderMissing?.(v2Dispatch(), new AbortController().signal, [
              { slot: "end_frame", ordinal: 0 },
            ])
            .then(
              () => {
                throw new Error("must reject");
              },
              (value) => value,
            );
          expect(error.message).toBe(failureCode);
          if (diagnosticMode === "valid")
            expect(error.cause).toEqual({
              source: "darwin_native_rss/v1",
              pid: 123,
              errno: 3,
              readBytes: 0,
              stage: "task_rss",
              lifecycleProven: true,
              renderStage: "motion_encode",
            });
          else expect(error.cause).toBeUndefined();
        } finally {
          await owned.shutdown();
        }
      },
    );
  },
);
