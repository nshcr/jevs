import { z } from "zod";
import { hasPrototypeKey } from "./json.ts";

// Reject before Zod's object parsing can silently discard this JSON key.
export function safeJson<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, ctx) => {
    if (hasPrototypeKey(value)) {
      ctx.addIssue({
        code: "custom",
        message: "JSON key __proto__ is not supported",
      });
      return z.NEVER;
    }
    return value;
  }, schema);
}
export const entry = safeJson(
  z.union([
    z.string(),
    z.record(z.string(), z.json()),
    z.array(z.json()),
    z.null(),
  ]),
);
const probability = z.number();
const distribution = z.record(z.string(), probability);
export const choiceValue = z.union([z.string(), z.boolean()]);
// Missing measurements stay missing; provider confidence is not comparable
// across models. Values are preserved without normalization or recomputation.
export const outputSchema = z.object({
  provider: z.string().min(1),
  protocol: z.string().min(1).optional(),
  results: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        id: z.string(),
        kind: z.literal("classification"),
        value: choiceValue,
        confidence: probability.optional(),
        probabilities: z
          .union([
            distribution,
            z.array(z.object({ value: choiceValue, probability })),
          ])
          .optional(),
      }),
      z.object({
        id: z.string(),
        kind: z.literal("score"),
        value: z.number(),
        confidence: probability.optional(),
        probabilities: distribution.optional(),
        levelProbabilities: z
          .array(
            z.object({
              value: z.number().int(),
              label: z.string(),
              probability,
            }),
          )
          .optional(),
        levels: z.record(z.string(), entry).optional(),
      }),
      z
        .object({
          id: z.string(),
          kind: z.literal("check"),
          probability: probability.optional(),
          value: z.boolean().optional(),
        })
        .refine(
          (v) => v.probability !== undefined || v.value !== undefined,
          "A check must report a probability or a boolean value",
        ),
      z.object({
        id: z.string(),
        kind: z.literal("refusal"),
        judgment: z.enum(["classification", "score", "check"]),
      }),
    ]),
  ),
  model: z.string().min(1),
  responseId: z.string().optional(),
  upstreamProvider: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
      reasoningTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});
export const capabilitiesSchema = z.object({
  judgments: z.array(z.enum(["classification", "score", "check"])),
  inputs: z.array(z.enum(["text", "json", "image", "video"])),
  mixedQuestions: z.boolean(),
  messages: z.boolean().optional(),
  imageDetail: z.boolean().optional(),
  labeledScores: z.boolean().optional(),
  safetyIdentifier: z.boolean().optional(),
  mediaOptions: z.boolean().optional(),
  typedChoices: z.boolean().optional(),
  refusals: z.boolean().optional(),
  maxQuestions: z.number().int().positive().optional(),
  maxOptions: z.number().int().positive().optional(),
  minOptions: z.number().int().positive().optional(),
  maxScoreLevels: z.number().int().positive().optional(),
  minScoreLevels: z.number().int().positive().optional(),
  maxImages: z.number().int().nonnegative().optional(),
  confidence: z.enum(["provider-defined", "unavailable"]),
});
export const providerSchema = z.object({
  provider: z.string().min(1),
  protocol: z.string().min(1),
  defaultModel: z.string().min(1),
  model: z.string().min(1),
  availability: z.enum(["supported", "unverified", "unsupported"]),
  capabilitySource: z.enum(["model", "protocol", "configuration"]),
  reason: z.string().optional(),
  unverifiedModelsAllowed: z.boolean().optional(),
  toolSupport: z
    .object({
      classify: z.enum(["supported", "unverified", "unsupported"]),
      score: z.enum(["supported", "unverified", "unsupported"]),
      check: z.enum(["supported", "unverified", "unsupported"]),
      assess_structure: z.enum(["supported", "unverified", "unsupported"]),
      assess_batch: z.enum(["supported", "unverified", "unsupported"]),
    })
    .optional(),
  capabilities: capabilitiesSchema,
});
export const modelsSchema = providerSchema.extend({
  source: z.enum(["remote", "configured"]),
  complete: z.boolean(),
  models: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().optional(),
      protocol: z.string().optional(),
      availability: z.enum(["supported", "unverified", "unsupported"]),
      capabilitySource: z.enum(["model", "protocol", "configuration"]),
      reason: z.string().optional(),
      capabilities: capabilitiesSchema.optional(),
    }),
  ),
});
