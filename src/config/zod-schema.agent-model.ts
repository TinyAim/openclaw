import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      fallbackPolicy: z
        .union([z.literal("strict"), z.literal("transient_only"), z.literal("continuity")])
        .optional(),
    })
    .strict(),
]);
