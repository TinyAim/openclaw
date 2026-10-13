import { describe, expect, it } from "vitest";
import {
  readSpatialReferenceV2TreeRssBytes,
  supportsSpatialReferenceV2ResourceLimits,
} from "./v2-resource-watch.js";

describe.skipIf(!supportsSpatialReferenceV2ResourceLimits())(
  "spatial v2 resource observers",
  () => {
    it.skipIf(process.platform === "darwin" && !process.env.SPATIAL_TEST_RESOURCE_OBSERVER_PATH)(
      "observes the current process tree with a positive RSS value",
      async () => {
        await expect(
          readSpatialReferenceV2TreeRssBytes(
            process.pid,
            process.env.SPATIAL_TEST_RESOURCE_OBSERVER_PATH,
          ),
        ).resolves.toEqual(expect.any(Number));
        const rssBytes = await readSpatialReferenceV2TreeRssBytes(
          process.pid,
          process.env.SPATIAL_TEST_RESOURCE_OBSERVER_PATH,
        );
        expect(rssBytes).toBeGreaterThan(0);
      },
    );

    it("fails closed when the requested root is absent from the trusted snapshot", async () => {
      await expect(readSpatialReferenceV2TreeRssBytes(2_147_483_647)).resolves.toBeUndefined();
    });
  },
);
