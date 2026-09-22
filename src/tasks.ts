import { z } from "zod";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";

import { entry, safeJson } from "./contracts.ts";
const id = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0 && v !== "__proto__", "Invalid identifier")
  .describe("Unique result identifier within this call.");
const question = entry.describe(
  "Focused question; accepts text, JSON object/array, or null. Preserve supporting data as JSON.",
);
export const classification = z.strictObject({
  id,
  question,
  options: safeJson(z.record(z.string().min(1), entry))
    .refine(
      (v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 255,
      "Provide 2 to 255 options",
    )
    .meta({ minProperties: 2, maxProperties: 255 })
    .describe(
      "Labels mapped to descriptions, structured rubrics, taxonomy subtrees, or null.",
    ),
});
export const scoring = z.strictObject({
  id,
  question,
  levels: z
    .array(entry)
    .min(2)
    .max(10)
    .describe(
      "Ordered levels, each text, JSON object/array, or null. Score is a zero-based expected position, possibly fractional.",
    ),
});
export const checking = z.strictObject({
  id,
  question,
  yes: entry
    .optional()
    .describe("Optional structured definition of a positive answer."),
  no: entry
    .optional()
    .describe("Optional structured definition of a negative answer."),
});
const common = {
  content: entry.describe(
    "Shared text or JSON context to evaluate; transmitted to TypeSafe AI.",
  ),
  model: z.string().trim().min(1).optional(),
};
function uniqueIds(items: { id: string }[]) {
  return new Set(items.map((x) => x.id)).size === items.length;
}
export const classifySchema = z
  .strictObject({ ...common, items: z.array(classification).min(1) })
  .refine((v) => uniqueIds(v.items), "Item IDs must be unique");
export const scoreSchema = z
  .strictObject({ ...common, items: z.array(scoring).min(1) })
  .refine((v) => uniqueIds(v.items), "Item IDs must be unique");
export const checkSchema = z
  .strictObject({ ...common, items: z.array(checking).min(1) })
  .refine((v) => uniqueIds(v.items), "Item IDs must be unique");
const groups = {
  classifications: z.array(classification).optional(),
  scores: z.array(scoring).optional(),
  checks: z.array(checking).optional(),
};
function validateGroups(
  v: {
    classifications?: { id: string }[];
    scores?: { id: string }[];
    checks?: { id: string }[];
  },
  ctx: z.RefinementCtx,
) {
  const items = [
    ...(v.classifications ?? []),
    ...(v.scores ?? []),
    ...(v.checks ?? []),
  ];
  if (!items.length)
    ctx.addIssue({
      code: "custom",
      message: "Provide at least one assessment",
    });
  if (!uniqueIds(items))
    ctx.addIssue({
      code: "custom",
      message: "IDs must be unique across all assessment groups",
    });
}
export const structureSchema = z
  .strictObject({ ...common, ...groups })
  .superRefine(validateGroups);
export const batchSchema = z
  .strictObject({
    model: common.model,
    ...groups,
    records: z
      .array(z.strictObject({ id, content: entry }))
      .min(1)
      .max(32)
      .refine(uniqueIds, "Record IDs must be unique"),
  })
  .superRefine(validateGroups);
export type Assessment = z.infer<typeof structureSchema>;
export function toRequest(input: Assessment) {
  const entries: [string, Questions[string]][] = [];
  for (const item of input.classifications ?? [])
    entries.push([
      item.id,
      { type: "choice", instructions: item.question, criteria: item.options },
    ]);
  for (const item of input.scores ?? [])
    entries.push([
      item.id,
      {
        type: "score",
        instructions: item.question,
        criteria: [item.levels[0]!, item.levels[1]!, ...item.levels.slice(2)],
      },
    ]);
  for (const item of input.checks ?? [])
    entries.push([
      item.id,
      {
        type: "noul",
        instructions: item.question,
        ...(item.yes !== undefined || item.no !== undefined
          ? {
              criteria: {
                ...(item.yes !== undefined ? { true: item.yes } : {}),
                ...(item.no !== undefined ? { false: item.no } : {}),
              },
            }
          : {}),
      },
    ]);
  return {
    state: input.content,
    questions: Object.fromEntries(entries),
    ...(input.model ? { model: input.model } : {}),
  };
}
export function toResult(response: SystemOneResult<Questions>) {
  return {
    results: Object.entries(response.answers).map(([id, answer]) => {
      switch (answer.type) {
        case "choice":
          return {
            id,
            kind: "classification",
            value: answer.choice,
            confidence: answer.confidence,
            probabilities: answer.probabilities,
          };
        case "score":
          return {
            id,
            kind: "score",
            value: answer.score,
            confidence: answer.confidence,
            probabilities: answer.probabilities,
            levels: answer.legend,
          };
        case "noul":
          return { id, kind: "check", probability: answer.noul };
      }
    }),
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
