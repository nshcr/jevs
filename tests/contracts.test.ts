import { test, expect } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import {
  structureSchema,
  classifySchema,
  scoreSchema,
  toRequest,
} from "../src/tasks.ts";
import { validateResponse } from "../src/contracts.ts";

const input = { content: null, checks: [{ id: "q", question: null }] };
const base = () => ({
  model: "fixture",
  answers: { q: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 1, output_tokens: 2 },
});
const malformed: [string, unknown][] = [
  ["missing answer", { ...base(), answers: {} }],
  [
    "extra ID",
    {
      ...base(),
      answers: { ...base().answers, other: { type: "noul", noul: 0.5 } },
    },
  ],
  [
    "wrong type",
    {
      ...base(),
      answers: {
        q: {
          type: "choice",
          choice: "a",
          confidence: 1,
          probabilities: { a: 1 },
        },
      },
    },
  ],
  ...[3, -0.1, "yes", null, undefined].map(
    (value) =>
      [
        "invalid probability " + String(value),
        { ...base(), answers: { q: { type: "noul", noul: value } } },
      ] as [string, unknown],
  ),
  ["unknown type", { ...base(), answers: { q: { type: "unknown" } } }],
  [
    "bad metadata",
    { ...base(), model: 5, usage: { input_tokens: -1, output_tokens: "x" } },
  ],
];
test("MCP rejects malformed successful HTTP responses and advertises output schemas", async () => {
  let body: unknown = base();
  const server = createServer(
    new TypeSafeClient({
      baseURL: "https://api.typesafe.ai",
      defaultModel: "fixture",
      apiKey: "mock",
      logLevel: "off",
      fetch: async () => Response.json(body),
    }),
  );
  const client = new Client({ name: "contracts", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    for (const tool of (await client.listTools()).tools)
      expect(tool.outputSchema).toBeDefined();
    for (const [, fixture] of malformed) {
      body = fixture;
      const result = await client.callTool({
        name: "assess_structure",
        arguments: input,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain("no results were accepted");
    }
    body = { models: [{ name: 12 }] };
    expect(
      (await client.callTool({ name: "jev_list_models", arguments: {} }))
        .isError,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Choice and Score cross-check candidates, probabilities, weighted value and rubric", () => {
  const choice = {
    q: { type: "choice" as const, criteria: { a: null, b: null } },
  };
  const score = {
    q: {
      type: "score" as const,
      criteria: [null, { summary: "high" }] as [null, { summary: string }],
    },
  };
  const validChoice = {
    type: "choice",
    choice: "a",
    confidence: 0.5,
    probabilities: { a: 0.7, b: 0.3 },
  };
  const validScore = {
    type: "score",
    score: 0.7,
    confidence: 0.5,
    probabilities: { "0": 0.3, "1": 0.7 },
    legend: { "0": null, "1": { summary: "high" } },
  };
  for (const [q, answer] of [
    [choice, validChoice],
    [score, validScore],
  ] as const)
    expect(() =>
      validateResponse({ ...base(), answers: { q: answer } }, q),
    ).not.toThrow();
  const roundedChoice = {
    type: "choice",
    choice: "a",
    confidence: 0.34,
    probabilities: { a: 0.33, b: 0.33, c: 0.33 },
  };
  expect(() =>
    validateResponse(
      { ...base(), answers: { q: roundedChoice } },
      { q: { type: "choice", criteria: { a: null, b: null, c: null } } },
    ),
  ).not.toThrow();
  const badChoices = [
    { ...validChoice, choice: "c" },
    { ...validChoice, confidence: 2 },
    { ...validChoice, choice: "b" },
    { ...validChoice, probabilities: { a: 0.9, b: 0.9 } },
    { ...validChoice, probabilities: { a: 1 } },
  ];
  for (const a of badChoices)
    expect(() =>
      validateResponse({ ...base(), answers: { q: a } }, choice),
    ).toThrow();
  for (const a of [
    { ...validScore, score: 99 },
    { ...validScore, score: 0.2 },
    { ...validScore, legend: { "0": null, "1": "wrong" } },
  ])
    expect(() =>
      validateResponse({ ...base(), answers: { q: a } }, score),
    ).toThrow();
});

test("API limits and dangerous JSON keys are rejected before transformation", () => {
  const options = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, null]));
  for (const [n, accepted] of [
    [2, true],
    [255, true],
    [256, false],
  ] as const)
    expect(
      classifySchema.safeParse({
        content: null,
        items: [{ id: "q", question: null, options: options(n) }],
      }).success,
    ).toBe(accepted);
  for (const [n, accepted] of [
    [2, true],
    [10, true],
    [11, false],
  ] as const)
    expect(
      scoreSchema.safeParse({
        content: null,
        items: [{ id: "q", question: null, levels: Array(n).fill(null) }],
      }).success,
    ).toBe(accepted);
  const bad = JSON.parse('{"nested":[{"__proto__":{"secret":1}}]}');
  for (const data of [
    { ...input, content: bad },
    { ...input, checks: [{ id: "q", question: bad }] },
    { ...input, checks: [{ id: "q", question: null, yes: bad }] },
    { ...input, checks: [{ id: "__proto__", question: null }] },
  ])
    expect(structureSchema.safeParse(data).success).toBe(false);
  expect(
    classifySchema.safeParse({
      content: null,
      items: [
        {
          id: "q",
          question: null,
          options: JSON.parse('{"a":null,"__proto__":null}'),
        },
      ],
    }).success,
  ).toBe(false);
});

test("30 generated batches preserve 465 structured judgments and match responses", () => {
  for (let n = 1; n <= 30; n++) {
    const content = {
      中文: [
        true,
        false,
        null,
        n,
        "🙂",
        { constructor: "valid data", values: [1, 2] },
      ],
    };
    const checks = Array.from({ length: n }, (_, i) => ({
      id: `字段.${i}`,
      question: content,
      yes: null,
      no: [content],
    }));
    const req = toRequest(structureSchema.parse({ content, checks }));
    expect(req.state).toEqual(content);
    for (const item of checks)
      expect(req.questions[item.id]).toEqual({
        type: "noul",
        instructions: content,
        criteria: { true: null, false: [content] },
      });
    const response = {
      ...base(),
      answers: Object.fromEntries(
        checks.map((c, i) => [c.id, { type: "noul", noul: i / n }]),
      ),
    };
    expect(
      Object.keys(validateResponse(response, req.questions).answers),
    ).toHaveLength(n);
  }
});
