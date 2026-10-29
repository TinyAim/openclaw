import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionListParams,
  validateSessionsCompactionRestoreParams,
} from "../validator-registry.js";
import { ProtocolSchemas } from "./protocol-schemas.js";
import {
  SessionsCompactionListResultSchema,
  SessionsCompactionBranchResultSchema,
  SessionsCompactionRestoreResultSchema,
} from "./sessions-compaction-checkpoints.js";

describe("checkpoint compatibility contract", () => {
  it("retains closed request contracts and scoped agent selection", () => {
    expect(validateSessionsCompactionListParams({ key: "main", agentId: "agent" })).toBe(true);
    expect(validateSessionsCompactionListParams({ key: "main", extra: true })).toBe(false);
    for (const validate of [
      validateSessionsCompactionBranchParams,
      validateSessionsCompactionRestoreParams,
    ]) {
      expect(validate({ key: "main", checkpointId: "checkpoint" })).toBe(true);
      expect(validate({ key: "main", checkpointId: "", tenantId: "other" })).toBe(false);
    }
  });
  it("retains list, branch and restore result shapes in the public registry", () => {
    const checkpoint = {
      checkpointId: "checkpoint",
      sessionKey: "main",
      sessionId: "session",
      createdAt: 1,
      reason: "manual",
      preCompaction: { sessionId: "session" },
      postCompaction: { sessionId: "session" },
    };
    const entry = { sessionId: "next", updatedAt: 1 };
    expect(
      Value.Check(SessionsCompactionListResultSchema, {
        ok: true,
        key: "main",
        checkpoints: [checkpoint],
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionsCompactionBranchResultSchema, {
        ok: true,
        sourceKey: "main",
        key: "next",
        sessionId: "next",
        checkpoint,
        entry,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionsCompactionRestoreResultSchema, {
        ok: true,
        key: "main",
        sessionId: "next",
        checkpoint,
        entry,
      }),
    ).toBe(true);
    expect(ProtocolSchemas.SessionsCompactionRestoreParams).toBeDefined();
  });
});
