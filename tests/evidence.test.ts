import { expect, test } from "bun:test";
import { structureSchema, batchSchema } from "../src/tasks.ts";
import { validateAssessment } from "../src/capabilities.ts";
import type { DecisionCapabilities } from "../src/decision.ts";
const base = { checks: [{ id: "ok", question: "Valid?" }] };
const cap: DecisionCapabilities = {
  judgments: ["check", "score"],
  inputs: ["text", "json", "image"],
  mixedQuestions: true,
  confidence: "unavailable",
};
const messages = [
  {
    parts: [
      { type: "text" as const, text: "first" },
      {
        type: "image" as const,
        image: {
          content_type: "image/png" as const,
          base64: "AA==",
          detail: "high" as const,
        },
      },
    ],
  },
  { parts: [{ type: "text" as const, text: "last" }] },
];
test("ordered messages and native metadata are preserved by semantic schema", () => {
  const input = {
    ...base,
    messages,
    safetyIdentifier: null,
    allowUnverifiedModel: true,
  };
  expect(structureSchema.parse(input)).toEqual(input);
  expect(
    structureSchema.safeParse({ ...input, content: "legacy" }).success,
  ).toBe(false);
  expect(
    structureSchema.safeParse({
      ...input,
      images: ["data:image/png;base64,AA=="],
    }).success,
  ).toBe(false);
  expect(structureSchema.safeParse(base).success).toBe(false);
});
test("score labels must cover every ordered level", () => {
  expect(
    structureSchema.safeParse({
      content: "x",
      scores: [
        { id: "s", question: "q", levels: ["a", "b"], levelLabels: ["bad"] },
      ],
    }).success,
  ).toBe(false);
  expect(
    structureSchema.parse({
      content: "x",
      scores: [
        {
          id: "s",
          question: "q",
          levels: ["a", "b"],
          levelLabels: ["low", "high"],
        },
      ],
    }).scores![0]!.levelLabels,
  ).toEqual(["low", "high"]);
});
test("undeclared evidence and native options fail before provider dispatch", () => {
  for (const extra of [
    { messages },
    { content: "x", videos: [{ frames: ["data:image/png;base64,AA=="] }] },
    { content: "x", mediaOptions: { fps: 1 } },
    { content: "x", safetyIdentifier: "id" },
    {
      content: "x",
      images: [{ content_type: "image/png", base64: "AA==", detail: null }],
    },
  ]) {
    expect(() =>
      validateAssessment({ ...base, ...extra } as never, cap),
    ).toThrow();
  }
  expect(() =>
    validateAssessment(
      {
        content: "x",
        scores: [{ id: "s", question: "q", levels: ["a"], levelLabels: ["a"] }],
      },
      cap,
    ),
  ).toThrow();
});
test("batch records accept ordered or video evidence without dropping metadata", () => {
  const input = {
    ...base,
    allowUnverifiedModel: true,
    safetyIdentifier: "id",
    records: [
      { id: "m", messages },
      {
        id: "v",
        content: null,
        videos: [{ frames: ["data:image/png;base64,AA=="] }],
        mediaOptions: { fps: 1 },
      },
    ],
  };
  expect(batchSchema.parse(input)).toEqual(input);
});
