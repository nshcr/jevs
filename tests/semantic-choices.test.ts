import { expect, test } from "bun:test";
import { classifySchema } from "../src/tasks.ts";
import { DecisionService } from "../src/service.ts";
import type { AssessmentResult, DecisionProvider } from "../src/decision.ts";
import { ProviderInputError, ResponseContractError } from "../src/failures.ts";
import { createProvider } from "../src/provider.ts";

const input = {
  content: "A typed decision",
  classifications: [
    {
      id: "q",
      question: "Which value?",
      options: [{ value: true }, { value: "true" }],
    },
  ],
};
function fixture(
  results: AssessmentResult["results"],
  typedChoices = true,
  refusals = true,
) {
  let calls = 0;
  const provider: DecisionProvider = {
    describe: () => ({
      provider: "fixture",
      protocol: "typed",
      defaultModel: "typed",
      model: "typed",
      availability: "supported",
      capabilitySource: "model",
      capabilities: {
        judgments: ["classification"],
        inputs: ["text"],
        mixedQuestions: false,
        confidence: "provider-defined",
        typedChoices,
        refusals,
      },
    }),
    evaluate: async () => {
      calls++;
      return { provider: "fixture", model: "typed", results };
    },
    listModels: async () => ({
      ...provider.describe(),
      source: "configured",
      complete: false,
      models: [],
    }),
  };
  return { service: new DecisionService(provider), calls: () => calls };
}

test("typed choice input keeps boolean and string identity and rejects typed duplicates", () => {
  expect(
    classifySchema.parse({
      content: input.content,
      items: input.classifications,
    }).items[0]!.options,
  ).toEqual(input.classifications[0]!.options);
  for (const values of [
    [true, true],
    ["a", "a"],
  ])
    expect(
      classifySchema.safeParse({
        content: "x",
        items: [
          {
            id: "q",
            question: "?",
            options: values.map((value) => ({ value })),
          },
        ],
      }).success,
    ).toBe(false);
});

test("neutral result preserves typed distributions and checks selection without coercion", async () => {
  const results: AssessmentResult["results"] = [
    {
      id: "q",
      kind: "classification",
      value: true,
      probabilities: [
        { value: true, probability: 0.7 },
        { value: "true", probability: 0.3 },
      ],
    },
  ];
  expect(
    (
      await fixture(results).service.evaluate(
        input,
        new AbortController().signal,
      )
    ).results,
  ).toEqual(results);
  await expect(
    fixture([
      { id: "q", kind: "classification", value: false },
    ]).service.evaluate(input, new AbortController().signal),
  ).rejects.toBeInstanceOf(ResponseContractError);
});

test("per-question refusals retain the requested judgment and require declared support", async () => {
  const results: AssessmentResult["results"] = [
    { id: "q", kind: "refusal", judgment: "classification" },
  ];
  expect(
    (
      await fixture(results).service.evaluate(
        input,
        new AbortController().signal,
      )
    ).results,
  ).toEqual(results);
  for (const f of [
    fixture(results, true, false),
    fixture([{ id: "q", kind: "refusal", judgment: "check" }]),
  ])
    await expect(
      f.service.evaluate(input, new AbortController().signal),
    ).rejects.toBeInstanceOf(ResponseContractError);
});

test("string-only protocols reject boolean choices before dispatch, without coercion", async () => {
  const f = fixture([], false);
  await expect(
    f.service.evaluate(input, new AbortController().signal),
  ).rejects.toBeInstanceOf(ProviderInputError);
  expect(f.calls()).toBe(0);
  let calls = 0;
  const provider = createProvider({
    kind: "system-one",
    allowUnverifiedModels: true,
    baseURL: "http://localhost:8000",
    defaultModel: "fixture",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await expect(
    provider.evaluate(input, new AbortController().signal),
  ).rejects.toBeInstanceOf(ProviderInputError);
  expect(calls).toBe(0);
});

test("string choice arrays remain usable by existing System One protocols", async () => {
  let sent: unknown;
  const provider = createProvider({
    kind: "system-one",
    allowUnverifiedModels: true,
    baseURL: "http://localhost:8000",
    defaultModel: "fixture",
    fetch: async (_, init) => {
      sent = JSON.parse(String(init!.body));
      return Response.json({
        model: "fixture",
        answers: { q: { type: "choice", choice: "a" } },
      });
    },
  });
  const result = await new DecisionService(provider).evaluate(
    {
      content: "x",
      classifications: [
        {
          id: "q",
          question: "?",
          options: [
            { value: "a", description: { rubric: "first" } },
            { value: "b" },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  expect(sent).toMatchObject({
    questions: { q: { criteria: { a: { rubric: "first" }, b: null } } },
  });
  expect(result.results).toEqual([
    { id: "q", kind: "classification", value: "a" },
  ]);
});
