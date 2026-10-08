import { z } from "zod";
import type { Assessment } from "../tasks.ts";
import type { AssessmentResult } from "../decision.ts";
import { entry } from "../contracts.ts";
import { ProviderInputError, ResponseContractError } from "../failures.ts";
import type { Entry } from "../choices.ts";
import { stringOptions } from "../choices.ts";
export type WireQuestion =
  | {
      type: "choice";
      instructions: Entry;
      criteria: Record<string, Entry>;
    }
  | {
      type: "score";
      instructions: Entry;
      criteria: Entry[];
    }
  | {
      type: "noul";
      instructions: Entry;
      criteria?: {
        true?: Entry;
        false?: Entry;
      };
    };
export type WireRequest = {
  model: string;
  state: Entry;
  questions: Record<string, WireQuestion>;
  images?: Assessment["images"];
};
export function toWire(input: Assessment, model: string): WireRequest {
  if (input.content === undefined || input.messages !== undefined)
    throw new ProviderInputError("This protocol requires legacy content.");
  const questions: Record<string, WireQuestion> = Object.create(null);
  function put(id: string, question: WireQuestion) {
    if (!id.trim() || id === "__proto__" || Object.hasOwn(questions, id))
      throw new ProviderInputError(
        "Judgment IDs must be unique and non-empty.",
      );
    questions[id] = question;
  }
  for (const item of input.classifications ?? [])
    put(item.id, {
      type: "choice",
      instructions: item.question,
      criteria: stringOptions(item.options),
    });
  for (const item of input.scores ?? [])
    put(item.id, {
      type: "score",
      instructions: item.question,
      criteria: item.levels,
    });
  for (const item of input.checks ?? [])
    put(item.id, {
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
    });
  if (!Object.keys(questions).length)
    throw new ProviderInputError("Provide at least one judgment.");
  return {
    model,
    state: input.content,
    questions,
    ...(input.images ? { images: input.images } : {}),
  };
}
const measurement = z.number();
const probabilities = z.record(z.string(), measurement);
const responseSchema = z.object({
  model: z.string().min(1),
  id: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        confidence: measurement.optional(),
        probabilities: probabilities.optional(),
      }),
      z.object({
        type: z.literal("score"),
        score: measurement,
        confidence: measurement.optional(),
        probabilities: probabilities.optional(),
        legend: z.record(z.string(), entry).optional(),
      }),
      z.object({ type: z.literal("noul"), noul: measurement }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cost: z.number().optional(),
    })
    .optional(),
});
export function normalizeResponse(
  raw: unknown,
  request: WireRequest,
  provider: string,
  config: { requiredUsage: boolean; requiredMetrics: boolean },
): AssessmentResult {
  const parsed = responseSchema.safeParse(raw);
  const fail = () => {
    throw new ResponseContractError(
      "Model service returned an invalid response; no results were accepted.",
    );
  };
  if (!parsed.success) return fail();
  const result = parsed.data;
  if (config.requiredUsage && !result.usage) return fail();
  const expected = Object.keys(request.questions);
  if (
    Object.keys(result.answers).length !== expected.length ||
    expected.some((id) => !Object.hasOwn(result.answers, id))
  )
    return fail();
  const results: AssessmentResult["results"] = [];
  for (const id of expected) {
    const answer = result.answers[id]!;
    const q = request.questions[id]!;
    if (answer.type !== q.type) return fail();
    if (answer.type === "choice" && q.type === "choice") {
      if (!Object.hasOwn(q.criteria, answer.choice)) return fail();
      if (
        answer.probabilities &&
        Object.keys(answer.probabilities).some(
          (key) => !Object.hasOwn(q.criteria, key),
        )
      )
        return fail();
      if (
        config.requiredMetrics &&
        (answer.confidence === undefined || answer.probabilities === undefined)
      )
        return fail();
      results.push({
        id,
        kind: "classification",
        value: answer.choice,
        ...(answer.confidence !== undefined
          ? { confidence: answer.confidence }
          : {}),
        ...(answer.probabilities !== undefined
          ? { probabilities: answer.probabilities }
          : {}),
      });
    } else if (answer.type === "score" && q.type === "score") {
      const validIndex = (key: string) =>
        /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < q.criteria.length;
      if (
        answer.probabilities &&
        Object.keys(answer.probabilities).some((key) => !validIndex(key))
      )
        return fail();
      if (
        answer.legend &&
        Object.keys(answer.legend).some((key) => !validIndex(key))
      )
        return fail();
      if (
        config.requiredMetrics &&
        (answer.confidence === undefined ||
          !answer.probabilities ||
          !answer.legend)
      )
        return fail();
      results.push({
        id,
        kind: "score",
        value: answer.score,
        ...(answer.confidence !== undefined
          ? { confidence: answer.confidence }
          : {}),
        ...(answer.probabilities !== undefined
          ? { probabilities: answer.probabilities }
          : {}),
        ...(answer.legend !== undefined ? { levels: answer.legend } : {}),
      });
    } else if (answer.type === "noul")
      results.push({ id, kind: "check", probability: answer.noul });
  }
  return {
    provider,
    model: result.model,
    results,
    ...(result.id !== undefined ? { responseId: result.id } : {}),
    ...(result.provider !== undefined
      ? { upstreamProvider: result.provider }
      : {}),
    ...(result.usage
      ? {
          usage: {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
            ...(result.usage.cost !== undefined
              ? { cost: result.usage.cost }
              : {}),
          },
        }
      : {}),
  };
}
