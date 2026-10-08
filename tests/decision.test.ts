import { expect, test } from "bun:test";
import { DecisionService } from "../src/service.ts";
import type { DecisionProvider, AssessmentResult } from "../src/decision.ts";
import { ProviderInputError, ResponseContractError } from "../src/failures.ts";

const input = {
  content: { ticket: "A duplicate charge" },
  classifications: [
    {
      id: "route",
      question: "Queue?",
      options: { billing: "Billing", other: "Other" },
    },
  ],
};
function fixture(result: AssessmentResult) {
  let calls = 0;
  const provider: DecisionProvider = {
    describe: () => ({
      provider: "selection-only",
      protocol: "fixture",
      defaultModel: "finite-choice",
      model: "finite-choice",
      availability: "supported",
      capabilitySource: "model",
      capabilities: {
        judgments: ["classification"],
        inputs: ["text", "json"],
        mixedQuestions: false,
        maxQuestions: 1,
        confidence: "provider-defined",
      },
    }),
    evaluate: async () => {
      calls++;
      return result;
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
const valid: AssessmentResult = {
  provider: "selection-only",
  model: "finite-choice",
  results: [{ id: "route", kind: "classification", value: "billing" }],
};
test("a native selection-only adapter needs no System One or fabricated measurements", async () => {
  const { service } = fixture(valid);
  const result = await service.evaluate(input, new AbortController().signal);
  expect(result).toEqual({ ...valid, protocol: "fixture" });
  expect(result).not.toHaveProperty("usage");
  expect(result.results[0]).not.toHaveProperty("confidence");
  expect(result.results[0]).not.toHaveProperty("probabilities");
});
test("provider protocol identity cannot be silently rewritten, while actual model versions are preserved", async () => {
  const incompatible = fixture({ ...valid, protocol: "different-protocol" });
  await expect(
    incompatible.service.evaluate(input, new AbortController().signal),
  ).rejects.toBeInstanceOf(ResponseContractError);
  const versioned = {
    ...valid,
    protocol: "fixture",
    model: "finite-choice-v2",
  };
  expect(
    await fixture(versioned).service.evaluate(
      input,
      new AbortController().signal,
    ),
  ).toEqual(versioned);
});
test("a native boolean judgment stays a boolean without invented probability", async () => {
  const provider: DecisionProvider = {
    describe: () => ({
      provider: "boolean-only",
      protocol: "fixture",
      defaultModel: "binary",
      model: "binary",
      availability: "supported",
      capabilitySource: "model",
      capabilities: {
        judgments: ["check"],
        inputs: ["text"],
        mixedQuestions: false,
        confidence: "provider-defined",
      },
    }),
    evaluate: async () => ({
      provider: "boolean-only",
      model: "binary",
      results: [{ id: "q", kind: "check", value: false }],
    }),
    listModels: async () => ({
      ...provider.describe(),
      source: "configured",
      complete: false,
      models: [],
    }),
  };
  const result = await new DecisionService(provider).evaluate(
    { content: "x", checks: [{ id: "q", question: "Ready?" }] },
    new AbortController().signal,
  );
  expect(result.results).toEqual([{ id: "q", kind: "check", value: false }]);
  expect(result.results[0]).not.toHaveProperty("probability");
});

test("the requested model controls admission instead of provider defaults", async () => {
  let calls = 0;
  const provider: DecisionProvider = {
    describe: (model = "mixed") => ({
      provider: "fixture",
      protocol: model === "mixed" ? "native" : "choice",
      defaultModel: "mixed",
      model,
      availability: "supported",
      capabilitySource: "model",
      capabilities: {
        judgments:
          model === "mixed"
            ? ["classification", "score", "check"]
            : ["classification"],
        inputs: ["text", "json"],
        mixedQuestions: model === "mixed",
        confidence: "unavailable",
      },
    }),
    evaluate: async () => {
      calls++;
      return {
        provider: "fixture",
        model: "choice",
        results: [{ id: "q", kind: "score", value: 1 }],
      };
    },
    listModels: async () => ({
      ...provider.describe(),
      source: "configured",
      complete: false,
      models: [],
    }),
  };
  await expect(
    new DecisionService(provider).evaluate(
      {
        model: "choice",
        content: "x",
        scores: [{ id: "q", question: "Quality?", levels: ["low", "high"] }],
      },
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ProviderInputError);
  expect(calls).toBe(0);
});
test("capabilities reject unsupported judgments, mixed questions and images before dispatch", async () => {
  for (const candidate of [
    { content: "x", checks: [{ id: "q", question: "Ready?" }] },
    {
      ...input,
      classifications: [
        ...input.classifications,
        { ...input.classifications[0]!, id: "other" },
      ],
    },
    { ...input, images: ["data:image/png;base64,AAAA"] },
  ]) {
    const f = fixture(valid);
    await expect(
      f.service.evaluate(candidate, new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderInputError);
    expect(f.calls()).toBe(0);
  }
});
test("neutral integration rejects missing, duplicate, wrong-kind and out-of-set answers", async () => {
  for (const results of [
    [],
    [...valid.results, ...valid.results],
    [{ id: "route", kind: "check" as const, value: true }],
    [{ id: "route", kind: "classification" as const, value: "unapproved" }],
    [{ id: "other", kind: "classification" as const, value: "billing" }],
  ]) {
    const f = fixture({ ...valid, results });
    await expect(
      f.service.evaluate(input, new AbortController().signal),
    ).rejects.toBeInstanceOf(ResponseContractError);
  }
});

test("service enforces unverified admission even for external providers", async () => {
  const f = fixture(valid);
  const provider = f.service.provider();
  const describe = provider.describe.bind(provider);
  provider.describe = () => ({ ...describe(), availability: "unverified" });
  await expect(
    f.service.evaluate(input, new AbortController().signal),
  ).rejects.toBeInstanceOf(ProviderInputError);
  expect(f.calls()).toBe(0);
  await f.service.evaluate(
    { ...input, allowUnverifiedModel: true },
    new AbortController().signal,
  );
  expect(f.calls()).toBe(1);
  provider.describe = () => ({
    ...describe(),
    availability: "unsupported",
    unverifiedModelsAllowed: true,
  });
  await expect(
    f.service.evaluate(
      { ...input, allowUnverifiedModel: true },
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ProviderInputError);
  expect(f.calls()).toBe(1);
});

test("closing lazy services never initializes providers and concurrent closes await disposal", async () => {
  let created = 0;
  const unused = new DecisionService(() => {
    created++;
    return fixture(valid).service.provider();
  });
  await unused.close();
  expect(created).toBe(0);
  const provider = fixture(valid).service.provider();
  const disposed = Promise.withResolvers<void>();
  let closes = 0;
  provider.close = () => {
    closes++;
    return disposed.promise;
  };
  const service = new DecisionService(provider);
  let completed = false;
  const first = service.close();
  const second = service.close().then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(closes).toBe(1);
  expect(completed).toBe(false);
  disposed.resolve();
  await Promise.all([first, second]);
  expect(completed).toBe(true);
  expect(() => service.provider()).toThrow();
});
