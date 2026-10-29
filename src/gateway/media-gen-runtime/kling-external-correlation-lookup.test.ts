import { describe, expect, it, vi } from "vitest";
import { lookupKlingExternalCorrelation } from "./kling-external-correlation-lookup.js";
const externalTaskId = `wis_${"a".repeat(32)}`;
describe("Kling external attempt correlation lookup", () => {
  it("queries the exact external ID and returns the original string task ID", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ code: 0, data: [{ external_id: externalTaskId, id: "000000000000000123" }] }),
    );
    expect(
      await lookupKlingExternalCorrelation({
        baseUrl: "https://provider.example",
        apiKey: "secret",
        externalTaskId,
        fetchImpl,
      }),
    ).toEqual({ status: "matched", vendorJobId: "000000000000000123" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://provider.example/tasks?external_task_ids=${externalTaskId}`,
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it.each([
    { code: 0, data: [] },
    { code: 0, data: [{ external_id: "other", id: "id" }] },
    {
      code: 0,
      data: [
        { external_id: externalTaskId, id: "one" },
        { external_id: externalTaskId, id: "two" },
      ],
    },
    { code: 0, data: [{ external_id: externalTaskId, id: 123 }] },
    { code: 1, data: [] },
  ])("keeps missing, mismatched, duplicate and malformed results unknown", async (payload) => {
    expect(
      await lookupKlingExternalCorrelation({
        baseUrl: "https://provider.example",
        apiKey: "secret",
        externalTaskId,
        fetchImpl: async () => Response.json(payload),
      }),
    ).toEqual({ status: "unknown" });
  });
});
