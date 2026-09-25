import { z } from "zod";
import type { Questions } from "@typesafe-ai/sdk";

// Reject before Zod's object parsing can silently discard this JSON key.
export function safeJson<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, ctx) => {
    const pending = [value];
    while (pending.length) {
      const next = pending.pop();
      if (next && typeof next === "object") {
        if (Object.hasOwn(next, "__proto__")) {
          ctx.addIssue({
            code: "custom",
            message: "JSON key __proto__ is not supported",
          });
          return z.NEVER;
        }
        pending.push(...Object.values(next));
      }
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
const answer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: probability,
    probabilities: distribution,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    confidence: probability,
    probabilities: distribution,
    legend: z.record(z.string(), entry),
  }),
  z.object({ type: z.literal("noul"), noul: probability }),
]);
const responseSchema = safeJson(
  z.object({
    model: z.string().min(1),
    answers: z.record(z.string(), answer),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    }),
  }),
);
export class ResponseContractError extends Error {}
function requireContract(ok: boolean) {
  if (!ok)
    throw new ResponseContractError("Invalid TypeSafe response contract");
}
function sameKeys(a: object, keys: string[]) {
  return (
    Object.keys(a).length === keys.length &&
    keys.every((k) => Object.hasOwn(a, k))
  );
}
export function validateResponse(raw: unknown, questions: Questions) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new ResponseContractError("Invalid TypeSafe response shape");
  const response = parsed.data;
  requireContract(sameKeys(response.answers, Object.keys(questions)));
  for (const [id, q] of Object.entries(questions)) {
    const a = response.answers[id]!;
    requireContract(a.type === q.type);
  }
  return response;
}
export const outputSchema = z.object({
  results: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        id: z.string(),
        kind: z.literal("classification"),
        value: z.string(),
        confidence: probability,
        probabilities: distribution,
      }),
      z.object({
        id: z.string(),
        kind: z.literal("score"),
        value: z.number(),
        confidence: probability,
        probabilities: distribution,
        levels: z.record(z.string(), entry),
      }),
      z.object({ id: z.string(), kind: z.literal("check"), probability }),
    ]),
  ),
  model: z.string().min(1),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
});
export const modelsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      release_date: z.string(),
    }),
  ),
});
