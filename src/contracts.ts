import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
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
const probability = z.number().min(0).max(1);
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
    score: z.number().min(0),
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
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    }),
  }),
);
export class ResponseContractError extends Error {}
const tolerance = 1e-6;
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
// Zen serializes probabilities and scores to two decimals. Validate whether a
// normalized underlying distribution can exist inside those rounding intervals.
// Preserve the reported numbers instead of fabricating precision by renormalizing.
function roundedBounds(values: number[]) {
  const lower = values.map((p) => Math.max(0, p - 0.005));
  const upper = values.map((p) => Math.min(1, p + 0.005));
  const lowSum = lower.reduce((a, b) => a + b, 0);
  requireContract(
    lowSum <= 1 + tolerance &&
      upper.reduce((a, b) => a + b, 0) >= 1 - tolerance,
  );
  function extreme(reverse: boolean) {
    let remaining = Math.max(0, 1 - lowSum);
    let result = lower.reduce((sum, p, i) => sum + i * p, 0);
    const indices = values.map((_, i) => i);
    if (reverse) indices.reverse();
    for (const i of indices) {
      const mass = Math.min(remaining, upper[i]! - lower[i]!);
      result += i * mass;
      remaining -= mass;
    }
    return result;
  }
  return [extreme(false), extreme(true)] as const;
}
export function validateResponse(
  raw: unknown,
  questions: Questions,
  rounded = false,
) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new ResponseContractError("Invalid TypeSafe response shape");
  const response = parsed.data;
  requireContract(sameKeys(response.answers, Object.keys(questions)));
  for (const [id, q] of Object.entries(questions)) {
    const a = response.answers[id]!;
    requireContract(a.type === q.type);
    if (a.type === "noul") continue;
    const keys =
      q.type === "choice"
        ? Object.keys(q.criteria)
        : q.type === "score"
          ? q.criteria.map((_, i) => String(i))
          : [];
    requireContract(sameKeys(a.probabilities, keys));
    const values = keys.map((k) => a.probabilities[k]!);
    const twoDecimals = (n: number) =>
      Math.abs(n * 100 - Math.round(n * 100)) <= tolerance;
    const rounding =
      rounded &&
      values.every(twoDecimals) &&
      (a.type !== "score" || twoDecimals(a.score));
    const bounds = rounding ? roundedBounds(values) : undefined;
    if (!rounding)
      requireContract(
        Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) <= tolerance,
      );
    if (a.type === "choice") {
      requireContract(keys.includes(a.choice));
      requireContract(
        a.probabilities[a.choice]! + tolerance >=
          Math.max(...Object.values(a.probabilities)),
      );
    } else if (q.type === "score") {
      requireContract(a.score <= q.criteria.length - 1);
      requireContract(sameKeys(a.legend, keys));
      requireContract(
        keys.every((k, i) => isDeepStrictEqual(a.legend[k], q.criteria[i])),
      );
      const expected = keys.reduce(
        (sum, k) => sum + Number(k) * a.probabilities[k]!,
        0,
      );
      if (bounds)
        requireContract(
          a.score + 0.005 + tolerance >= bounds[0] &&
            a.score - 0.005 - tolerance <= bounds[1],
        );
      else
        requireContract(
          Math.abs(a.score - expected) <=
            tolerance * Math.max(1, q.criteria.length - 1),
        );
    }
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
        value: z.number().nonnegative(),
        confidence: probability,
        probabilities: distribution,
        levels: z.record(z.string(), entry),
      }),
      z.object({ id: z.string(), kind: z.literal("check"), probability }),
    ]),
  ),
  model: z.string().min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
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
