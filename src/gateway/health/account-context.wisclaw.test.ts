import { beforeEach, expect, it, vi } from "vitest";
import { inspectChannelAccount } from "../../channels/account-inspection.js";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import {
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../../channels/account-summary.js";
import { resolveHealthAccountContext } from "./account-context.js";

vi.mock("../../channels/account-inspection.js", () => ({ inspectChannelAccount: vi.fn() }));
vi.mock("../../channels/account-resolution.js", () => ({ resolveChannelAccount: vi.fn() }));
vi.mock("../../channels/account-summary.js", () => ({
  resolveChannelAccountConfigured: vi.fn(),
  resolveChannelAccountEnabled: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(inspectChannelAccount).mockResolvedValue({ enabled: true, configured: true } as never);
  vi.mocked(resolveChannelAccount).mockResolvedValue({ enabled: true, configured: true } as never);
  vi.mocked(resolveChannelAccountEnabled).mockReturnValue(true);
  vi.mocked(resolveChannelAccountConfigured).mockResolvedValue(true);
});

it.each(["enabled", "configured"] as const)(
  "fails closed when the %s evaluator throws",
  async (field) => {
    if (field === "enabled")
      vi.mocked(resolveChannelAccountEnabled).mockImplementation(() => {
        throw new Error("failed");
      });
    else vi.mocked(resolveChannelAccountConfigured).mockRejectedValue(new Error("failed"));
    const result = await resolveHealthAccountContext({
      plugin: { id: "test" } as never,
      cfg: {},
      accountId: "test",
    });
    expect(result[field]).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.stringContaining(`failed to evaluate ${field}`),
    );
  },
);
