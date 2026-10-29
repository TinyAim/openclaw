import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const Reference = closedObject({
  sessionId: NonEmptyString,
  sessionFile: Type.Optional(NonEmptyString),
  leafId: Type.Optional(NonEmptyString),
  entryId: Type.Optional(NonEmptyString),
});
export const SessionCompactionCheckpointSchema = closedObject({
  checkpointId: NonEmptyString,
  sessionKey: NonEmptyString,
  sessionId: NonEmptyString,
  createdAt: Type.Integer({ minimum: 0 }),
  reason: Type.Union([
    Type.Literal("manual"),
    Type.Literal("auto-threshold"),
    Type.Literal("overflow-retry"),
    Type.Literal("timeout-retry"),
  ]),
  tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
  tokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
  tokensVersion: Type.Optional(Type.Literal(1)),
  summary: Type.Optional(Type.String()),
  firstKeptEntryId: Type.Optional(NonEmptyString),
  preCompaction: Reference,
  postCompaction: Reference,
});
export const SessionsCompactionListParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});
export const SessionsCompactionBranchParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  checkpointId: NonEmptyString,
});
export const SessionsCompactionRestoreParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  checkpointId: NonEmptyString,
});
export const SessionsCompactionListResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  checkpoints: Type.Array(SessionCompactionCheckpointSchema),
});
const Entry = Type.Object(
  { sessionId: NonEmptyString, updatedAt: Type.Integer({ minimum: 0 }) },
  { additionalProperties: true },
);
export const SessionsCompactionBranchResultSchema = closedObject({
  ok: Type.Literal(true),
  sourceKey: NonEmptyString,
  key: NonEmptyString,
  sessionId: NonEmptyString,
  checkpoint: SessionCompactionCheckpointSchema,
  entry: Entry,
});
export const SessionsCompactionRestoreResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  sessionId: NonEmptyString,
  checkpoint: SessionCompactionCheckpointSchema,
  entry: Entry,
});
export type SessionsCompactionListParams = Static<typeof SessionsCompactionListParamsSchema>;
export type SessionsCompactionBranchParams = Static<typeof SessionsCompactionBranchParamsSchema>;
export type SessionsCompactionRestoreParams = Static<typeof SessionsCompactionRestoreParamsSchema>;
export type SessionsCompactionListResult = Static<typeof SessionsCompactionListResultSchema>;
export type SessionsCompactionBranchResult = Static<typeof SessionsCompactionBranchResultSchema>;
export type SessionsCompactionRestoreResult = Static<typeof SessionsCompactionRestoreResultSchema>;
