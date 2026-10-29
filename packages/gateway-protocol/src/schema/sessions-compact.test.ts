import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateSessionsCompactParams } from "../validator-registry.js";
import { SessionsCompactParamsSchema } from "./sessions.js";

describe("public sessions.compact instructions", () => {
  it.each([
    ["legacy summary", { key: "main" }, true],
    ["legacy trim", { key: "main", agentId: "main", maxLines: 20 }, true],
    ["preserve recent", { key: "main", historyMode: "preserve_recent" }, true],
    [
      "summary only",
      { key: "main", historyMode: "summary_only", customInstructions: "Current role." },
      true,
    ],
    ["unknown history mode", { key: "main", historyMode: "all" }, false],
    ["summary only with trim", { key: "main", maxLines: 20, historyMode: "summary_only" }, false],
    [
      "explicit summary focus",
      { key: "main", customInstructions: "Retain confirmed facts." },
      true,
    ],
    ["800 Unicode code points", { key: "main", customInstructions: "😀".repeat(800) }, true],
    ["empty focus", { key: "main", customInstructions: "" }, true],
    ["unknown fields", { key: "main", unexpected: true }, false],
    ["overlong ASCII", { key: "main", customInstructions: "x".repeat(801) }, false],
    ["overlong Unicode", { key: "main", customInstructions: "😀".repeat(801) }, false],
    ["non-string focus", { key: "main", customInstructions: 7 }, false],
    ["null focus", { key: "main", customInstructions: null }, false],
    ["focus with trim", { key: "main", maxLines: 20, customInstructions: "Keep facts." }, false],
    ["empty focus with trim", { key: "main", maxLines: 20, customInstructions: "" }, false],
  ])("validates %s at both schema and RPC boundaries", (_label, params, valid) => {
    expect(Value.Check(SessionsCompactParamsSchema, params)).toBe(valid);
    expect(validateSessionsCompactParams(params)).toBe(valid);
  });
});
