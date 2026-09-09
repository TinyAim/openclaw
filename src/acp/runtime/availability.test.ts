import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
/** Fail-closed availability checks for ACP runtime spawn. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAcpRuntimeSpawnAvailable } from "./availability.js";
import { testing, registerAcpRuntimeBackend } from "./registry.js";

function createRuntimeStub(): AcpRuntime {
  return {
    async ensureSession(input) {
      return {
        sessionKey: input.sessionKey,
        backend: "stub",
        runtimeSessionName: `${input.sessionKey}:runtime`,
      };
    },
    async *runTurn() {},
    async cancel() {},
    async close() {},
  };
}

describe("isAcpRuntimeSpawnAvailable", () => {
  beforeEach(() => {
    testing.resetAcpRuntimeBackendsForTests();
  });

  afterEach(() => {
    testing.resetAcpRuntimeBackendsForTests();
  });

  it("returns false when no backend is registered", () => {
    expect(isAcpRuntimeSpawnAvailable({})).toBe(false);
  });

  it("returns false when backend omits healthy (fail-closed)", () => {
    registerAcpRuntimeBackend({ id: "acpx", runtime: createRuntimeStub() });
    expect(isAcpRuntimeSpawnAvailable({ backendId: "acpx" })).toBe(false);
  });

  it("returns true when backend reports healthy", () => {
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: createRuntimeStub(),
      healthy: () => true,
    });
    expect(isAcpRuntimeSpawnAvailable({ backendId: "acpx" })).toBe(true);
  });

  it("returns false when backend reports unhealthy", () => {
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: createRuntimeStub(),
      healthy: () => false,
    });
    expect(isAcpRuntimeSpawnAvailable({ backendId: "acpx" })).toBe(false);
  });
});
