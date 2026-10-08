import { expect, test } from "bun:test";
import { createProvider } from "../src/provider.ts";
import { ResponseContractError } from "../src/failures.ts";
const input = { content: "ready", checks: [{ id: "q", question: "Ready?" }] };
const base = {
  model: "actual",
  answers: { q: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 1, output_tokens: 2 },
};
async function evaluate(body: unknown, request = input) {
  return createProvider({
    kind: "openrouter",
    apiKey: "fixture",
    fetch: async () => Response.json(body),
  }).evaluate(request, new AbortController().signal);
}
test("malformed answers, exact IDs, metadata and prototype keys fail atomically", async () => {
  for (const body of [
    { ...base, answers: {} },
    { ...base, answers: { ...base.answers, extra: base.answers.q } },
    { ...base, answers: { q: { type: "score", score: 1 } } },
    { ...base, answers: { q: { type: "noul" } } },
    { ...base, answers: { q: { type: "noul", noul: "yes" } } },
    { ...base, model: 1 },
    { ...base, usage: { input_tokens: -1, output_tokens: 2 } },
    { ...base, usage: undefined },
    JSON.parse(
      '{"model":"actual","answers":{"q":{"type":"noul","noul":0.5,"__proto__":{}}},"usage":{"input_tokens":1,"output_tokens":2}}',
    ),
    { success: false, result: base },
  ])
    await expect(evaluate(body)).rejects.toBeInstanceOf(ResponseContractError);
});
test("optional choice and score metrics stay absent; provider numeric values are preserved", async () => {
  const request = {
    content: "ready",
    classifications: [
      { id: "c", question: "Label?", options: { a: null, b: null } },
    ],
    scores: [{ id: "s", question: "Score?", levels: ["low", "high"] }],
  };
  const provider = createProvider({
    kind: "openrouter",
    apiKey: "fixture",
    fetch: async () =>
      Response.json({
        model: "cloudflare/clef",
        answers: {
          c: { type: "choice", choice: "a" },
          s: {
            type: "score",
            score: 17.01,
            confidence: 2,
            probabilities: { "0": 0.9, "1": 0.9 },
            legend: { "0": "low", "1": "provider description" },
          },
        },
        usage: base.usage,
      }),
  });
  expect(
    (await provider.evaluate(request, new AbortController().signal)).results,
  ).toEqual([
    { id: "c", kind: "classification", value: "a" },
    {
      id: "s",
      kind: "score",
      value: 17.01,
      confidence: 2,
      probabilities: { "0": 0.9, "1": 0.9 },
      levels: { "0": "low", "1": "provider description" },
    },
  ]);
  for (const answer of [
    { type: "choice", choice: "outside" },
    { type: "choice", choice: "a", probabilities: { outside: 1 } },
  ]) {
    const bad = createProvider({
      kind: "system-one",
      allowUnverifiedModels: true,
      baseURL: "http://localhost:8000",
      defaultModel: "custom",
      fetch: async () =>
        Response.json({ model: "custom", answers: { c: answer } }),
    });
    await expect(
      bad.evaluate(
        { content: "ready", classifications: request.classifications },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ResponseContractError);
  }
});
test("Clef native metrics required; generic compatible endpoint accepts absent usage", async () => {
  const clef = createProvider({
    kind: "cloudflare-workers",
    accountId: "fixture",
    apiKey: "fixture",
    fetch: async () =>
      Response.json({
        model: "clef",
        answers: { q: { type: "choice", choice: "a" } },
        usage: base.usage,
      }),
  });
  await expect(
    clef.evaluate(
      {
        content: "ready",
        classifications: [
          { id: "q", question: "Label?", options: { a: null, b: null } },
        ],
      },
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ResponseContractError);
  const generic = createProvider({
    kind: "system-one",
    allowUnverifiedModels: true,
    baseURL: "http://localhost:8000",
    defaultModel: "custom",
    fetch: async () =>
      Response.json({ model: "custom", answers: base.answers }),
  });
  expect(
    (await generic.evaluate(input, new AbortController().signal)).usage,
  ).toBeUndefined();
});

test("OpenRouter retains response identity upstream provider and optional cost", async () => {
  const provider = createProvider({
    kind: "openrouter",
    apiKey: "fixture",
    fetch: async () =>
      Response.json({
        ...base,
        id: "decision-fixture",
        provider: "Cloudflare",
        usage: { ...base.usage, cost: 0.000001 },
      }),
  });
  expect(await provider.evaluate(input, new AbortController().signal)).toEqual({
    provider: "openrouter",
    model: "actual",
    responseId: "decision-fixture",
    upstreamProvider: "Cloudflare",
    results: [{ id: "q", kind: "check", probability: 0.8 }],
    usage: { inputTokens: 1, outputTokens: 2, cost: 0.000001 },
  });
});

test("native System One provider contracts require their declared choice metrics", async () => {
  for (const kind of [
    "typesafe",
    "vercel",
    "zen",
    "cloudflare-gateway",
  ] as const) {
    const provider = createProvider({
      kind,
      accountId: "fixture",
      apiKey: "fixture",
      fetch: async () =>
        Response.json({
          model: "actual",
          answers: { c: { type: "choice", choice: "a" } },
          usage: base.usage,
        }),
    });
    await expect(
      provider.evaluate(
        {
          content: "ready",
          classifications: [
            { id: "c", question: "Label?", options: { a: null, b: null } },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ResponseContractError);
  }
});
