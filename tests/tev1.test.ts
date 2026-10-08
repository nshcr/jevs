import { expect, test } from "bun:test";
import type { Assessment } from "../src/tasks.ts";
import { tev1ChatAdapter } from "../src/providers/tev1-chat.ts";
import { ProviderInputError, ResponseContractError } from "../src/failures.ts";

const context = {
  provider: "openrouter",
  model: "togethercomputer/tev1-4b-experimental",
} as const;
const input: Assessment = {
  content: { policy: ["允许", null], count: 12 },
  classifications: [
    {
      id: "route",
      question: "去哪里？",
      options: { 退款: "允许退款", 复核: "人工复核" },
    },
  ],
};
function reply(content: unknown = " B\n") {
  return {
    model: "actual-tev-version",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}
const prepare = (assessment = input) =>
  tev1ChatAdapter.prepare(assessment, context);

test("Tev1 transports structured state and maps letters to original keys without inventing metrics", () => {
  const request = prepare();
  expect(request.path).toBe("/v1/chat/completions");
  const body = request.body as {
    messages: { role: string; content: string }[];
    [key: string]: unknown;
  };
  expect(body.model).toBe(context.model);
  expect(body.temperature).toBe(0);
  expect(body.max_tokens).toBe(8);
  expect(body.messages[0]?.role).toBe("system");
  expect(body.messages[0]?.content).toContain(
    "Return only its letter, with no explanation.",
  );
  expect(JSON.parse(body.messages[1]!.content)).toEqual({
    state: input.content,
    question: "去哪里？",
    options: [
      { label: "A", key: "退款", description: "允许退款" },
      { label: "B", key: "复核", description: "人工复核" },
    ],
  });
  expect(body).not.toHaveProperty("chat_template_kwargs");
  expect(body).not.toHaveProperty("logprobs");
  expect(
    request.decode({
      ...reply(),
      id: "response-1",
      provider: "Together",
      logprobs: { B: -0.1 },
    }),
  ).toEqual({
    provider: "openrouter",
    protocol: "tev1-chat",
    model: "actual-tev-version",
    responseId: "response-1",
    upstreamProvider: "Together",
    results: [{ id: "route", kind: "classification", value: "复核" }],
  });
});

test("Tev1 preserves declared choice-array order for numeric string values", () => {
  const request = prepare({
    content: "state",
    classifications: [
      {
        id: "q",
        question: "Which?",
        options: [
          { value: "10", description: "First candidate" },
          { value: "2", description: "Second candidate" },
        ],
      },
    ],
  });
  expect(request.decode(reply("A")).results[0]).toMatchObject({
    kind: "classification",
    value: "10",
  });
});

test("Tev1 exposes classification-only bounds and preserves 2/24 option endpoints", () => {
  expect(tev1ChatAdapter.capabilities(context)).toEqual({
    judgments: ["classification"],
    inputs: ["text", "json"],
    mixedQuestions: false,
    maxQuestions: 1,
    minOptions: 2,
    maxOptions: 24,
    confidence: "unavailable",
  });
  for (const count of [2, 24]) {
    const options = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`key-${i}`, `Description ${i}`]),
    );
    const request = prepare({
      content: "state",
      classifications: [{ id: "q", question: "Which?", options }],
    });
    expect(
      request.decode(reply(String.fromCharCode(64 + count))).results[0],
    ).toMatchObject({
      kind: "classification",
      value: `key-${count - 1}`,
    });
  }
});

test("Tev1 rejects unsupported judgments, question counts, images and lossy descriptions", () => {
  const invalid: Assessment[] = [
    { content: "state", checks: [{ id: "q", question: "Ready?" }] },
    {
      content: "state",
      scores: [{ id: "q", question: "Quality?", levels: ["low", "high"] }],
    },
    { ...input, checks: [{ id: "q", question: "Ready?" }] },
    {
      ...input,
      classifications: [
        ...input.classifications!,
        { ...input.classifications![0]!, id: "second" },
      ],
    },
    { ...input, images: ["data:image/png;base64,YQ=="] },
    {
      ...input,
      classifications: [
        {
          id: "q",
          question: { prompt: "Which?" },
          options: { a: "a", b: "b" },
        },
      ],
    },
    {
      ...input,
      classifications: [
        { id: "q", question: " ", options: { a: "a", b: "b" } },
      ],
    },
    {
      ...input,
      classifications: [
        {
          id: "q",
          question: "Which?",
          options: { a: "a", b: { rubric: "b" } },
        },
      ],
    },
    {
      ...input,
      classifications: [
        { id: "q", question: "Which?", options: { a: "a", b: " " } },
      ],
    },
    {
      ...input,
      classifications: [
        { id: "q", question: "Which?", options: { " ": "a", b: "b" } },
      ],
    },
    ...[1, 25].map((count) => ({
      content: "state",
      classifications: [
        {
          id: "q",
          question: "Which?",
          options: Object.fromEntries(
            Array.from({ length: count }, (_, i) => [`k${i}`, `Option ${i}`]),
          ),
        },
      ],
    })),
  ];
  for (const assessment of invalid)
    expect(() => prepare(assessment)).toThrow(ProviderInputError);
});

test("Tev1 rejects out-of-set labels, prose, truncation, refusal, tool calls and ambiguous responses", () => {
  const request = prepare();
  const invalid: unknown[] = [
    ...["C", "a", "B because policy applies", "AB", "", " ", null, 1].map(
      reply,
    ),
    { ...reply(), model: "" },
    { ...reply(), choices: [] },
    { ...reply(), choices: [reply().choices[0], reply().choices[0]] },
    {
      ...reply(),
      choices: [{ ...reply().choices[0], finish_reason: "length" }],
    },
    {
      ...reply(),
      choices: [
        {
          ...reply().choices[0],
          message: {
            role: "assistant",
            content: "A",
            refusal: "Cannot evaluate",
          },
        },
      ],
    },
    {
      ...reply(),
      choices: [
        {
          ...reply().choices[0],
          message: {
            role: "assistant",
            content: "A",
            tool_calls: [{ id: "call", type: "function" }],
          },
        },
      ],
    },
  ];
  for (const response of invalid)
    expect(() => request.decode(response)).toThrow(ResponseContractError);
});

test("Tev1 preserves supplied usage and rejects malformed counters", () => {
  const request = prepare();
  expect(
    request.decode({
      ...reply("A"),
      usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.001 },
    }).usage,
  ).toEqual({ inputTokens: 10, outputTokens: 1, cost: 0.001 });
  for (const usage of [
    { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 1.5, completion_tokens: 1 },
    { prompt_tokens: 10 },
    { prompt_tokens: 10, completion_tokens: "1" },
    null,
  ])
    expect(() => request.decode({ ...reply(), usage })).toThrow(
      ResponseContractError,
    );
});
