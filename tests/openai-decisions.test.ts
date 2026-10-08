import { expect, test } from "bun:test";
import type { Assessment } from "../src/tasks.ts";
import { openaiDecisionsAdapter } from "../src/providers/openai-decisions.ts";
import { ProviderInputError, ResponseContractError } from "../src/failures.ts";

const context = { provider: "openai", model: "gpt-6-luna" } as const;
const usage = {
  input_tokens: 101,
  input_tokens_details: { cached_tokens: 50, cache_write_tokens: 9 },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 103,
};
const input: Assessment = {
  content: { ticket: "屏幕破裂", evidence: [null, "photo"] },
  classifications: [
    {
      id: "route",
      question: { ask: "分类" },
      options: [
        { value: true, description: { route: "approved" } },
        { value: "true", description: null },
      ],
    },
  ],
  scores: [
    {
      id: "severity",
      question: "Severity?",
      levels: ["Low", { damage: "broken screen" }, null],
    },
  ],
  checks: [
    {
      id: "damaged",
      question: "Damaged?",
      yes: { crack: true },
      no: "Unmarked",
    },
  ],
};
function response() {
  return {
    model: "gpt-6-luna-2026-10-06",
    answers: [
      {
        type: "choice",
        name: "route",
        choice: true,
        confidence: 0.4,
        probabilities: [
          { value: true, probability: 0.8 },
          { value: "true", probability: 0.2 },
        ],
      },
      {
        type: "score",
        name: "severity",
        score: 1.9,
        confidence: 0.65,
        probabilities: [
          { value: 0, label: "0", probability: 0.1 },
          { value: 1, label: "1", probability: 0.7 },
          { value: 2, label: "2", probability: 0.2 },
        ],
      },
      { type: "predicate", name: "damaged", probability: 0.95 },
    ],
    usage: structuredClone(usage),
  };
}
const prepare = (assessment = input) =>
  openaiDecisionsAdapter.prepare(assessment, context);

test("OpenAI Decisions sends native mixed questions, explicit JSON text and distinct typed choices", () => {
  const request = prepare();
  expect(request.path).toBe("/v1/decisions");
  expect(request.body).toEqual({
    model: context.model,
    input: JSON.stringify(input.content),
    questions: [
      {
        type: "choice",
        name: "route",
        instructions: '{"ask":"分类"}',
        choices: [
          { value: true, description: '{"route":"approved"}' },
          { value: "true" },
        ],
      },
      {
        type: "score",
        name: "severity",
        instructions: "Severity?",
        levels: [
          { label: "0", description: "Low" },
          { label: "1", description: '{"damage":"broken screen"}' },
          { label: "2" },
        ],
      },
      {
        type: "predicate",
        name: "damaged",
        instructions:
          '{"question":"Damaged?","yes":{"crack":true},"no":"Unmarked"}',
      },
    ],
  });
  const decoded = request.decode(response());
  expect(decoded).toEqual({
    provider: "openai",
    protocol: "openai-decisions",
    model: "gpt-6-luna-2026-10-06",
    results: [
      {
        id: "route",
        kind: "classification",
        value: true,
        confidence: 0.4,
        probabilities: [
          { value: true, probability: 0.8 },
          { value: "true", probability: 0.2 },
        ],
      },
      {
        id: "severity",
        kind: "score",
        value: 1.9,
        confidence: 0.65,
        levelProbabilities: [
          { value: 0, label: "0", probability: 0.1 },
          { value: 1, label: "1", probability: 0.7 },
          { value: 2, label: "2", probability: 0.2 },
        ],
      },
      { id: "damaged", kind: "check", probability: 0.95 },
    ],
    usage: {
      inputTokens: 101,
      cachedInputTokens: 50,
      cacheWriteTokens: 9,
      outputTokens: 2,
      reasoningTokens: 1,
      totalTokens: 103,
    },
  });
  expect(decoded).not.toHaveProperty("responseId");
  const stringChoice = {
    ...response(),
    answers: [
      { ...response().answers[0], choice: "true" },
      ...response().answers.slice(1),
    ],
  };
  expect(request.decode(stringChoice).results[0]).toMatchObject({
    kind: "classification",
    value: "true",
  });
});

test("OpenAI preserves original record choices and plain predicate instructions", () => {
  expect(
    prepare({
      content: "plain state",
      classifications: [{ id: "q", question: "", options: { a: "", b: null } }],
      checks: [{ id: "check", question: "Ready?" }],
    }).body,
  ).toEqual({
    model: context.model,
    input: "plain state",
    questions: [
      {
        type: "choice",
        name: "q",
        instructions: "",
        choices: [{ value: "a", description: "" }, { value: "b" }],
      },
      { type: "predicate", name: "check", instructions: "Ready?" },
    ],
  });
  const request = prepare({
    content: null,
    checks: [{ id: "q", question: ["Is ready?", null], yes: null }],
  });
  expect(request.body).toEqual({
    model: context.model,
    input: "null",
    questions: [
      {
        type: "predicate",
        name: "q",
        instructions: '{"question":["Is ready?",null],"yes":null}',
      },
    ],
  });
});

test("OpenAI refusal remains per-question data with original judgment identity", () => {
  const raw = response();
  const changed = {
    ...raw,
    answers: raw.answers.map((answer) => ({
      type: "refusal",
      name: answer.name,
    })),
  };
  expect(prepare().decode(changed).results).toEqual([
    { id: "route", kind: "refusal", judgment: "classification" },
    { id: "severity", kind: "refusal", judgment: "score" },
    { id: "damaged", kind: "refusal", judgment: "check" },
  ]);
  const mixed = {
    ...raw,
    answers: [
      raw.answers[0],
      { type: "refusal", name: "severity" },
      raw.answers[2],
    ],
  };
  expect(prepare().decode(mixed).results[1]).toEqual({
    id: "severity",
    kind: "refusal",
    judgment: "score",
  });
  expect(prepare().decode(mixed).results[2]).toEqual({
    id: "damaged",
    kind: "check",
    probability: 0.95,
  });
});

test("OpenAI inline images become user parts, including GIF without Cloudflare byte limits", () => {
  const images: NonNullable<Assessment["images"]> = [
    "data:image/png;base64,YQ==",
    { content_type: "image/gif", base64: "Yg==" },
  ];
  expect(prepare({ ...input, images }).body).toEqual({
    ...(prepare().body as object),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: JSON.stringify(input.content) },
          { type: "input_image", image_url: images[0] },
          { type: "input_image", image_url: "data:image/gif;base64,Yg==" },
        ],
      },
    ],
  });
  const large = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");
  expect(() =>
    prepare({
      ...input,
      images: [{ content_type: "image/png", base64: large }],
    }),
  ).not.toThrow();
  expect(() =>
    prepare({
      ...input,
      images: Array.from({ length: 128 }, () => "data:image/webp;base64,YQ=="),
    }),
  ).not.toThrow();
  for (const bad of [
    "https://example.com/photo.png",
    "file-123",
    "data:image/svg+xml;base64,YQ==",
    "data:image/png;base64,",
    "data:image/png;base64,a",
    "data:image/png;base64,YQ=",
  ])
    expect(() => prepare({ ...input, images: [bad] })).toThrow(
      ProviderInputError,
    );
  expect(() =>
    prepare({
      ...input,
      images: Array.from({ length: 129 }, () => "data:image/png;base64,YQ=="),
    }),
  ).toThrow(ProviderInputError);
});

test("OpenAI capabilities and allowed choice endpoints impose no invented score or question maximum", () => {
  expect(openaiDecisionsAdapter.capabilities(context)).toEqual({
    judgments: ["classification", "score", "check"],
    inputs: ["text", "json", "image"],
    mixedQuestions: true,
    minOptions: 2,
    maxOptions: 255,
    maxImages: 128,
    typedChoices: true,
    refusals: true,
    messages: true,
    imageDetail: true,
    labeledScores: true,
    safetyIdentifier: true,
    confidence: "provider-defined",
  });
  for (const count of [2, 255])
    expect(() =>
      prepare({
        content: "state",
        classifications: [
          {
            id: "q",
            question: "Which?",
            options: Array.from({ length: count }, (_, i) => ({
              value: String(i),
            })),
          },
        ],
      }),
    ).not.toThrow();
  for (const count of [1, 256])
    expect(() =>
      prepare({
        content: "state",
        classifications: [
          {
            id: "q",
            question: "Which?",
            options: Array.from({ length: count }, (_, i) => ({
              value: String(i),
            })),
          },
        ],
      }),
    ).toThrow(ProviderInputError);
  expect(() =>
    prepare({
      content: "state",
      checks: Array.from({ length: 80 }, (_, i) => ({
        id: `q${i}`,
        question: "Ready?",
      })),
      scores: [
        {
          id: "score",
          question: "Rate?",
          levels: Array.from({ length: 20 }, (_, i) => String(i)),
        },
      ],
    }),
  ).not.toThrow();
  expect(() =>
    prepare({
      content: "state",
      classifications: [
        {
          id: "q",
          question: "Which?",
          options: [{ value: true }, { value: true }],
        },
      ],
    }),
  ).toThrow(ProviderInputError);
});

test("OpenAI rejects malformed response names, order, quantity, types and out-of-set typed values", () => {
  const request = prepare();
  const good = response();
  const invalid: unknown[] = [
    null,
    {},
    { ...good, model: "" },
    { ...good, answers: good.answers.slice(0, 2) },
    { ...good, answers: [...good.answers, good.answers[0]] },
    { ...good, answers: [good.answers[1], good.answers[0], good.answers[2]] },
  ];
  for (const first of [
    { ...good.answers[0], name: null },
    { ...good.answers[0], name: "other" },
    { ...good.answers[0], choice: false },
    { ...good.answers[0], choice: 1 },
    { type: "predicate", name: "route", probability: 0.5 },
    { type: "choice", name: "route", choice: true, probabilities: [] },
    {
      ...good.answers[0],
      probabilities: [{ value: "false", probability: 0.1 }],
    },
    {
      ...good.answers[0],
      probabilities: [
        { value: true, probability: 0.5 },
        { value: true, probability: 0.5 },
      ],
    },
  ])
    invalid.push({ ...good, answers: [first, ...good.answers.slice(1)] });
  invalid.push({
    ...good,
    answers: [
      good.answers[0],
      {
        ...good.answers[1],
        probabilities: [{ value: 1.5, label: "1", probability: 0.1 }],
      },
      good.answers[2],
    ],
  });
  invalid.push({
    ...good,
    answers: [
      good.answers[0],
      {
        ...good.answers[1],
        probabilities: [{ value: 3, label: "3", probability: 0.1 }],
      },
      good.answers[2],
    ],
  });
  invalid.push({
    ...good,
    answers: [
      good.answers[0],
      {
        ...good.answers[1],
        probabilities: [
          { value: 0, label: "0", probability: 0.1 },
          { value: 0, label: "0", probability: 0.2 },
        ],
      },
      good.answers[2],
    ],
  });
  for (const raw of invalid)
    expect(() => request.decode(raw)).toThrow(ResponseContractError);
  const proto = JSON.parse(JSON.stringify(good));
  proto.answers[0].probabilities[0] = JSON.parse(
    '{"value":true,"probability":0.8,"__proto__":{}}',
  );
  expect(() => request.decode(proto)).toThrow(ResponseContractError);
});

test("OpenAI does not recalculate numeric probability, confidence, score or token relationships", () => {
  const good = response();
  const changed = {
    ...good,
    answers: [
      {
        ...good.answers[0],
        confidence: 2,
        probabilities: [
          { value: true, probability: -0.1 },
          { value: "true", probability: 0.3 },
        ],
      },
      {
        ...good.answers[1],
        score: 20,
        confidence: -1,
        probabilities: [
          { value: 1, label: "provider label", probability: 1.2 },
        ],
      },
      { ...good.answers[2], probability: 1.1 },
    ],
    usage: { ...usage, total_tokens: 1 },
  };
  const output = prepare().decode(changed);
  expect(output.results[0]).toEqual({
    id: "route",
    kind: "classification",
    value: true,
    confidence: 2,
    probabilities: [
      { value: true, probability: -0.1 },
      { value: "true", probability: 0.3 },
    ],
  });
  expect(output.results[1]).toMatchObject({
    kind: "score",
    value: 20,
    confidence: -1,
  });
  expect(output.results[1]).toHaveProperty("levelProbabilities", [
    { value: 1, label: "provider label", probability: 1.2 },
  ]);
  expect(output.results[2]).toEqual({
    id: "damaged",
    kind: "check",
    probability: 1.1,
  });
  expect(output.usage?.totalTokens).toBe(1);
});

test("OpenAI usage requires all documented integer fields", () => {
  const request = prepare();
  const good = response();
  for (const badUsage of [
    undefined,
    {},
    { ...usage, input_tokens: 1.5 },
    { ...usage, total_tokens: "103" },
    { ...usage, input_tokens_details: { cached_tokens: 50 } },
    { ...usage, output_tokens_details: {} },
  ])
    expect(() => request.decode({ ...good, usage: badUsage })).toThrow(
      ResponseContractError,
    );
});

test("OpenAI ordered messages preserve message boundaries and interleaved evidence", () => {
  const request = prepare({
    messages: [
      {
        parts: [
          { type: "text", text: "Before" },
          { type: "image", image: "data:image/png;base64,YQ==" },
          { type: "text", text: "After" },
        ],
      },
      {
        parts: [
          {
            type: "image",
            image: {
              content_type: "image/jpeg",
              base64: "Yg==",
              detail: "original",
            },
          },
          { type: "text", text: "Second message" },
        ],
      },
    ],
    checks: input.checks,
    safetyIdentifier: "anonymous-user-01",
  });
  expect(request.body).toEqual({
    model: context.model,
    safety_identifier: "anonymous-user-01",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Before" },
          { type: "input_image", image_url: "data:image/png;base64,YQ==" },
          { type: "input_text", text: "After" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/jpeg;base64,Yg==",
            detail: "original",
          },
          { type: "input_text", text: "Second message" },
        ],
      },
    ],
    questions: [
      {
        type: "predicate",
        name: "damaged",
        instructions:
          '{"question":"Damaged?","yes":{"crack":true},"no":"Unmarked"}',
      },
    ],
  });
});

test("OpenAI image detail is transmitted only when explicitly supplied", () => {
  for (const detail of ["low", "high", "auto", "original", null] as const) {
    const image = {
      content_type: "image/png",
      base64: "YQ==",
      detail,
    } as const;
    const legacy = prepare({ ...input, images: [image] }).body as {
      input: { content: unknown[] }[];
    };
    expect(legacy.input[0]!.content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,YQ==",
      detail,
    });
    const messages = prepare({
      messages: [{ parts: [{ type: "image", image }] }],
      checks: input.checks,
    }).body as { input: { content: unknown[] }[] };
    expect(messages.input[0]!.content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,YQ==",
      detail,
    });
  }
  const request = prepare({
    messages: [
      {
        parts: [
          {
            type: "image",
            image: { content_type: "image/png", base64: "YQ==" },
          },
        ],
      },
    ],
    checks: input.checks,
  });
  const body = request.body as { input: { content: unknown[] }[] };
  expect(body.input[0]!.content[0]).toEqual({
    type: "input_image",
    image_url: "data:image/png;base64,YQ==",
  });
});

test("OpenAI score labels and safety identifier retain explicit caller values", () => {
  const nullIdentifier = prepare({ ...input, safetyIdentifier: null }).body;
  expect(nullIdentifier).toHaveProperty("safety_identifier", null);
  const request = prepare({
    ...input,
    safetyIdentifier: "",
    scores: [{ ...input.scores![0]!, levelLabels: ["同一", "同一", ""] }],
  });
  const body = request.body as {
    safety_identifier: string;
    questions: { levels?: { label: string }[] }[];
  };
  expect(body.safety_identifier).toBe("");
  expect(body.questions[1]!.levels!.map((level) => level.label)).toEqual([
    "同一",
    "同一",
    "",
  ]);
  expect(() =>
    prepare({ ...input, safetyIdentifier: "x".repeat(128) }),
  ).not.toThrow();
  expect(() =>
    prepare({ ...input, safetyIdentifier: "x".repeat(129) }),
  ).toThrow(ProviderInputError);
  expect(() =>
    prepare({
      ...input,
      scores: [{ ...input.scores![0]!, levelLabels: ["one"] }],
    }),
  ).toThrow(ProviderInputError);
  expect(request.decode(response()).results[1]).toHaveProperty(
    "levelProbabilities",
    response().answers[1]!.probabilities,
  );
});

test("OpenAI counts inline images across messages and rejects unsupported or conflicting input", () => {
  const message = (count: number) => ({
    parts: Array.from({ length: count }, () => ({
      type: "image" as const,
      image: "data:image/png;base64,YQ==",
    })),
  });
  expect(() =>
    prepare({ messages: [message(64), message(64)], checks: input.checks }),
  ).not.toThrow();
  expect(() =>
    prepare({ messages: [message(64), message(65)], checks: input.checks }),
  ).toThrow(ProviderInputError);
  const invalid: Assessment[] = [
    { ...input, messages: [message(1)] },
    {
      messages: [message(1)],
      images: ["data:image/png;base64,YQ=="],
      checks: input.checks,
    },
    {
      messages: [message(1)],
      videos: [{ frames: ["data:image/png;base64,YQ=="] }],
      checks: input.checks,
    },
    { ...input, videos: [{ frames: ["data:image/png;base64,YQ=="] }] },
    { ...input, mediaOptions: {} },
    { messages: [], checks: input.checks },
    { messages: [{ parts: [] }], checks: input.checks },
    { checks: input.checks },
  ];
  for (const value of invalid)
    expect(() => prepare(value)).toThrow(ProviderInputError);
});
