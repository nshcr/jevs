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
function decimalPlaces(value: number) {
  const [significand = "", exponentText] = value
    .toString()
    .toLowerCase()
    .split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, (significand.split(".")[1]?.length ?? 0) - exponent);
}
function precision(values: number[]) {
  return Math.max(0, ...values.map(decimalPlaces));
}
function interval(value: number, places: number, maximum: number) {
  if (places === 0) return [value, value] as const;
  const halfStep = 0.5 * 10 ** -places;
  return [
    Math.max(0, value - halfStep),
    Math.min(maximum, value + halfStep),
  ] as const;
}
// Decimal JSON numbers do not preserve trailing zeroes. Infer one shared
// precision per numeric group and check whether a normalized underlying
// distribution and weighted score can fit the reported rounding intervals.
// Provider values remain untouched.
function roundedBounds(values: number[], places: number) {
  const lower = values.map((p) => interval(p, places, 1)[0]);
  const upper = values.map((p) => interval(p, places, 1)[1]);
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
export function validateResponse(raw: unknown, questions: Questions) {
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
    const sum = values.reduce((total, p) => total + p, 0);
    const probabilityPlaces = precision(values);
    const scorePlaces = a.type === "score" ? decimalPlaces(a.score) : 0;
    if (a.type === "choice") {
      if (Math.abs(sum - 1) > tolerance) {
        const places = probabilityPlaces;
        requireContract(places > 0);
        roundedBounds(values, places);
      }
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
      if (
        Math.abs(sum - 1) <= tolerance &&
        Math.abs(a.score - expected) <=
          tolerance * Math.max(1, q.criteria.length - 1)
      )
        continue;
      const inferredProbabilityPlaces = probabilityPlaces || scorePlaces;
      const inferredScorePlaces = scorePlaces || probabilityPlaces;
      requireContract(inferredProbabilityPlaces > 0 || inferredScorePlaces > 0);
      const expectedBounds = roundedBounds(values, inferredProbabilityPlaces);
      const scoreBounds = interval(
        a.score,
        inferredScorePlaces,
        q.criteria.length - 1,
      );
      requireContract(
        scoreBounds[0] <= expectedBounds[1] + tolerance &&
          scoreBounds[1] >= expectedBounds[0] - tolerance,
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
