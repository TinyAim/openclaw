import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// Wisclaw collaboration branches — operator-plane subagent orchestration
// methods. These wrap the SAME implementations the in-agent `subagents` /
// `sessions_spawn` tools use (registry queries, cascade kill, announce
// flow, task routing), exposed as scoped gateway methods so the Control
// API can orchestrate subagents WITHOUT opening `sessions_spawn` on the
// unscoped HTTP `/tools/invoke` surface (RCE deny list stays intact).

export const SubagentsListParamsSchema = Type.Object(
  {
    /** Parent (requester) session key whose child runs should be listed. */
    requesterSessionKey: NonEmptyString,
    /** Recent-completions window in minutes (default 30, max 1440). */
    recentMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const SubagentsSpawnParamsSchema = Type.Object(
  {
    /** Parent session key the subagent is delegated FROM (announce target). */
    requesterSessionKey: NonEmptyString,
    task: NonEmptyString,
    label: Type.Optional(Type.String()),
    /**
     * Wisclaw Tier B task routing — explicit task class resolving
     * `agents.defaults.subagents.taskRouting.<class>`. Never inferred.
     */
    taskClass: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    mode: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("session")])),
    cleanup: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("keep")])),
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SubagentsKillParamsSchema = Type.Object(
  {
    /** Parent (requester) session key scoping the target resolution. */
    requesterSessionKey: NonEmptyString,
    /** runId | child session key | label | "all". */
    target: NonEmptyString,
  },
  { additionalProperties: false },
);
