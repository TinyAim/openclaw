// Public manual compaction request; recovery never shares the destructive trim path.
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SessionsCompactParamsSchema = Object.assign(
  closedObject({
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
    customInstructions: Type.Optional(Type.String({ maxLength: 800 })),
    historyMode: Type.Optional(
      Type.Union([Type.Literal("preserve_recent"), Type.Literal("summary_only")]),
    ),
  }),
  {
    not: {
      anyOf: [
        { required: ["maxLines", "customInstructions"] },
        {
          required: ["maxLines", "historyMode"],
          properties: { historyMode: { const: "summary_only" } },
        },
      ],
    },
  },
);
