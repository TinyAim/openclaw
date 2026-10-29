import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAgentParams } from "../../../../packages/gateway-protocol/src/index.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { resolveSubagentRunDurationMs } from "../registry/subagent-run-timeout.js";
import {
  callNativeSubagentGateway,
  resolveSubagentAgentGatewayTimeoutMs,
} from "./subagent-spawn-gateway.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

vi.mock("./subagent-spawn.runtime.js", async () => {
  const dispatch = await import("../../../gateway/server-plugin-in-process-dispatch.js");
  const scopes = await import("../../../gateway/method-scopes.js");
  return {
    ...scopes,
    dispatchGatewayMethodInProcess: dispatch.dispatchGatewayMethodInProcess,
    hasInProcessGatewayContext: () => Boolean(dispatch.getInProcessGatewayRequestContext()),
    callGateway: vi.fn(),
    ensureContextEnginesInitialized: vi.fn(),
    forkSessionEntryFromParent: vi.fn(),
    getGlobalHookRunner: vi.fn(),
    getRuntimeConfig: vi.fn(),
    prepareModelChoice: vi.fn(),
    resolveContextEngine: vi.fn(),
  };
});

vi.mock("../../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

afterEach(() => spawnTesting.setDepsForTest());

describe("native subagent Gateway transport ownership", () => {
  it("caps Gateway timer delays without shortening semantic run durations", () => {
    const thirtyDaysSeconds = 30 * 24 * 60 * 60;

    expect(resolveSubagentAgentGatewayTimeoutMs(thirtyDaysSeconds)).toBe(300_000);
    expect(resolveSubagentRunDurationMs(thirtyDaysSeconds)).toBe(2_592_000_000);
  });

  it.each(["caller", "captured", "scoped"])(
    "rejects a retired %s binding without opening a socket",
    async (binding) => {
      const callGateway = vi.fn<() => void>();
      spawnTesting.setDepsForTest({
        callGateway: async <T>() => {
          callGateway();
          return { runId: "wrong-gateway", status: "accepted" } as T;
        },
      });
      const resolver = () => undefined;
      const launch = () =>
        callNativeSubagentGateway(
          {
            method: "agent",
            params: { message: "must not launch", idempotencyKey: "closed-owner" },
          },
          undefined,
          binding === "captured" ? resolver : undefined,
        );
      const result =
        binding === "caller"
          ? withGatewayToolCallerIdentity(
              { agentId: "main", sessionKey: "agent:main:main", gatewayContextResolver: resolver },
              launch,
            )
          : binding === "scoped"
            ? withPluginRuntimeGatewayRequestScope(
                { resolveGatewayContext: resolver, isWebchatConnect: () => false },
                launch,
              )
            : launch();

      await expect(result).rejects.toThrow("instance binding");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("preserves acceptance when the source closes after the child is admitted", async () => {
    let current = true;
    const assertDispatchCurrent = () => {
      if (!current) {
        throw new Error("source closed");
      }
    };
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        _params: Record<string, unknown>,
      ) => {
        assertDispatchCurrent();
        current = false;
        return { runId: "accepted-child", status: "accepted" } as T;
      },
    });
    await expect(
      callNativeSubagentGateway({
        method: "agent",
        params: { message: "start", idempotencyKey: "accepted-child" },
        assertDispatchCurrent,
      }),
    ).resolves.toMatchObject({
      response: { runId: "accepted-child" },
    });
  });

  it("carries inherited fallback restriction only through trusted dispatch metadata", async () => {
    const dispatch = vi.fn(async () => ({ runId: "inherited-run", status: "accepted" }));
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: dispatch as never,
    });
    await callNativeSubagentGateway(
      {
        method: "agent",
        params: {
          message: "inspect",
          idempotencyKey: "inherited-run",
        },
      },
      { modelOverride: { provider: "openai", model: "gpt-5.4" }, disableModelFallbacks: true },
    );
    expect(dispatch).toHaveBeenCalledWith(
      "agent",
      expect.not.objectContaining({ disableModelFallbacks: true }),
      expect.objectContaining({ disableModelFallbacks: true, allowSyntheticModelOverride: true }),
    );
    expect(
      validateAgentParams({
        message: "external",
        idempotencyKey: "external",
        disableModelFallbacks: true,
      }),
    ).toBe(false);
  });

  it("rejects an inherited policy without a trusted in-process owner before socket dispatch", async () => {
    const socket = vi.fn();
    spawnTesting.setDepsForTest({ hasInProcessGatewayContext: () => false, callGateway: socket });
    await expect(
      callNativeSubagentGateway(
        {
          method: "agent",
          params: {
            message: "inspect",
            idempotencyKey: "no-owner",
          },
        },
        { modelOverride: { provider: "openai", model: "gpt-5.4" }, disableModelFallbacks: true },
      ),
    ).rejects.toThrow("trusted in-process Gateway");
    expect(socket).not.toHaveBeenCalled();
  });

  it("keeps socket dispatch available when no Gateway owner was bound", async () => {
    const callGateway = vi.fn<() => void>();
    spawnTesting.setDepsForTest({
      callGateway: async <T>() => {
        callGateway();
        return { runId: "remote-run", status: "accepted" } as T;
      },
    });

    await expect(
      callNativeSubagentGateway({
        method: "agent",
        params: { message: "standalone", idempotencyKey: "remote-run" },
      }),
    ).resolves.toEqual({
      response: { runId: "remote-run", status: "accepted" },
      registrationRequired: false,
    });
    expect(callGateway).toHaveBeenCalledOnce();
  });
});
