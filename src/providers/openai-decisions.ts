import { z } from "zod";
import type { AssessmentResult, DecisionAdapter } from "../decision.ts";
import type { Assessment } from "../tasks.ts";
import { choiceValue, safeJson } from "../contracts.ts";
import { optionEntries, type Entry } from "../choices.ts";
import { ProviderInputError, ResponseContractError } from "../failures.ts";

// Native beta contract: https://developers.openai.com/api/reference/resources/decisions/methods/create
const answerName = z.string().nullable();
const responseSchema = safeJson(
  z.object({
    model: z.string().min(1),
    answers: z.array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("predicate"),
          name: answerName,
          probability: z.number(),
        }),
        z.object({
          type: z.literal("choice"),
          name: answerName,
          choice: choiceValue,
          confidence: z.number(),
          probabilities: z.array(
            z.object({ value: choiceValue, probability: z.number() }),
          ),
        }),
        z.object({
          type: z.literal("score"),
          name: answerName,
          score: z.number(),
          confidence: z.number(),
          probabilities: z.array(
            z.object({
              value: z.number().int(),
              label: z.string(),
              probability: z.number(),
            }),
          ),
        }),
        z.object({ type: z.literal("refusal"), name: answerName }),
      ]),
    ),
    usage: z.object({
      input_tokens: z.number().int(),
      input_tokens_details: z.object({
        cached_tokens: z.number().int(),
        cache_write_tokens: z.number().int(),
      }),
      output_tokens: z.number().int(),
      output_tokens_details: z.object({ reasoning_tokens: z.number().int() }),
      total_tokens: z.number().int(),
    }),
  }),
);
type Choices = { value: string | boolean; description?: string }[];
type Question =
  | { type: "choice"; name: string; instructions: string; choices: Choices }
  | {
      type: "score";
      name: string;
      instructions: string;
      levels: { label: string; description?: string }[];
    }
  | { type: "predicate"; name: string; instructions: string };
const text = (value: Entry): string =>
  typeof value === "string" ? value : JSON.stringify(value);
function description(value: Entry | undefined): { description?: string } {
  return value == null ? {} : { description: text(value) };
}
function dataUrl(
  image: string | { content_type: string; base64: string },
): string {
  if (
    typeof image !== "string" &&
    (!image ||
      typeof image.content_type !== "string" ||
      typeof image.base64 !== "string")
  )
    throw new ProviderInputError("Provide inline image data.");
  const url =
    typeof image === "string"
      ? image
      : `data:${image.content_type};base64,${image.base64}`;
  const match =
    /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
      url,
    );
  if (
    !match ||
    !match[2] ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(
      match[2],
    )
  )
    throw new ProviderInputError(
      "OpenAI Decisions requires inline base64 PNG, JPEG, WebP or GIF images.",
    );
  return url;
}
type Image = NonNullable<Assessment["images"]>[number];
function imagePart(image: Image) {
  const image_url = dataUrl(image);
  const detail = typeof image === "string" ? undefined : image.detail;
  if (
    detail !== undefined &&
    detail !== null &&
    !["low", "high", "auto", "original"].includes(detail)
  )
    throw new ProviderInputError("Provide a supported image detail value.");
  return {
    type: "input_image",
    image_url,
    ...(detail !== undefined ? { detail } : {}),
  };
}
function encodeInput(input: Assessment) {
  if (input.videos !== undefined || input.mediaOptions !== undefined)
    throw new ProviderInputError(
      "OpenAI Decisions does not support videos or runtime media options.",
    );
  if (input.messages !== undefined) {
    if (input.content !== undefined || input.images !== undefined)
      throw new ProviderInputError(
        "Use ordered messages or shared content/images, without combining them.",
      );
    if (!Array.isArray(input.messages) || !input.messages.length)
      throw new ProviderInputError("Provide at least one ordered message.");
    let imageCount = 0;
    const messages = input.messages.map((message) => {
      if (!Array.isArray(message.parts) || !message.parts.length)
        throw new ProviderInputError("Provide at least one part per message.");
      const content = message.parts.map((part) => {
        if (part.type === "text" && typeof part.text === "string")
          return { type: "input_text", text: part.text };
        if (part.type === "image") {
          imageCount++;
          return imagePart(part.image);
        }
        throw new ProviderInputError(
          "OpenAI Decisions accepts only text and inline image message parts.",
        );
      });
      return { role: "user", content };
    });
    if (imageCount > 128)
      throw new ProviderInputError(
        "OpenAI Decisions accepts at most 128 images across all messages.",
      );
    return messages;
  }
  if (input.content === undefined)
    throw new ProviderInputError("Provide shared content or ordered messages.");
  if ((input.images?.length ?? 0) > 128)
    throw new ProviderInputError(
      "OpenAI Decisions accepts at most 128 images.",
    );
  const inputText = text(input.content);
  return input.images?.length
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: inputText },
            ...input.images.map(imagePart),
          ],
        },
      ]
    : inputText;
}
const invalidResponse = (message: string): never => {
  throw new ResponseContractError(message);
};

export const openaiDecisionsAdapter: DecisionAdapter = {
  id: "openai-decisions",
  capabilities() {
    return {
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
    };
  },
  prepare(input, context) {
    const wireInput = encodeInput(input);
    if (
      input.safetyIdentifier !== undefined &&
      input.safetyIdentifier !== null &&
      (typeof input.safetyIdentifier !== "string" ||
        input.safetyIdentifier.length > 128)
    )
      throw new ProviderInputError(
        "OpenAI Decisions safety identifiers must be null or strings of at most 128 characters.",
      );
    const questions: Question[] = [];
    for (const item of input.classifications ?? []) {
      const options = optionEntries(item.options);
      if (options.length < 2 || options.length > 255)
        throw new ProviderInputError(
          "OpenAI Decisions requires 2 to 255 choices.",
        );
      if (
        new Set(options.map((option) => JSON.stringify(option.value))).size !==
        options.length
      )
        throw new ProviderInputError(
          "OpenAI Decisions requires unique typed choice values.",
        );
      questions.push({
        type: "choice",
        name: item.id,
        instructions: text(item.question),
        choices: options.map((option) => ({
          value: option.value,
          ...description(option.description),
        })),
      });
    }
    for (const item of input.scores ?? []) {
      if (!item.levels.length)
        throw new ProviderInputError("Provide at least one score level.");
      if (
        item.levelLabels !== undefined &&
        (item.levelLabels.length !== item.levels.length ||
          item.levelLabels.some((label) => typeof label !== "string"))
      )
        throw new ProviderInputError(
          "Score labels must be strings matching the number of levels.",
        );
      questions.push({
        type: "score",
        name: item.id,
        instructions: text(item.question),
        levels: item.levels.map((level, index) => ({
          label: item.levelLabels?.[index] ?? String(index),
          ...description(level),
        })),
      });
    }
    for (const item of input.checks ?? []) {
      const instructions =
        item.yes !== undefined || item.no !== undefined
          ? JSON.stringify({
              question: item.question,
              ...(item.yes !== undefined ? { yes: item.yes } : {}),
              ...(item.no !== undefined ? { no: item.no } : {}),
            })
          : text(item.question);
      questions.push({ type: "predicate", name: item.id, instructions });
    }
    if (
      !questions.length ||
      new Set(questions.map((question) => question.name)).size !==
        questions.length
    )
      throw new ProviderInputError("Provide judgments with unique names.");
    return {
      path: "/v1/decisions",
      body: {
        model: context.model,
        input: wireInput,
        questions,
        ...(input.safetyIdentifier !== undefined
          ? { safety_identifier: input.safetyIdentifier }
          : {}),
      },
      decode(raw) {
        const parsed = responseSchema.safeParse(raw);
        if (!parsed.success)
          return invalidResponse(
            "OpenAI Decisions returned an invalid response structure.",
          );
        const response = parsed.data;
        if (response.answers.length !== questions.length)
          return invalidResponse(
            "OpenAI Decisions returned an incorrect answer count.",
          );
        const results: AssessmentResult["results"] = response.answers.map(
          (answer, index) => {
            const question = questions[index]!;
            if (answer.name !== question.name)
              return invalidResponse(
                "OpenAI Decisions returned mismatched answer names or order.",
              );
            if (answer.type === "refusal") {
              const judgment =
                question.type === "choice"
                  ? "classification"
                  : question.type === "score"
                    ? "score"
                    : "check";
              return { id: question.name, kind: "refusal", judgment };
            }
            if (answer.type !== question.type)
              return invalidResponse(
                "OpenAI Decisions returned a mismatched answer type.",
              );
            if (answer.type === "choice" && question.type === "choice") {
              const permitted = new Set(
                question.choices.map((choice) => choice.value),
              );
              if (!permitted.has(answer.choice))
                return invalidResponse(
                  "OpenAI Decisions returned an unlisted typed choice.",
                );
              const seen = new Set<string | boolean>();
              for (const probability of answer.probabilities) {
                if (
                  !permitted.has(probability.value) ||
                  seen.has(probability.value)
                )
                  return invalidResponse(
                    "OpenAI Decisions returned invalid typed probability values.",
                  );
                seen.add(probability.value);
              }
              return {
                id: question.name,
                kind: "classification",
                value: answer.choice,
                confidence: answer.confidence,
                probabilities: answer.probabilities,
              };
            }
            if (answer.type === "score" && question.type === "score") {
              const seen = new Set<number>();
              for (const probability of answer.probabilities) {
                if (
                  probability.value < 0 ||
                  probability.value >= question.levels.length ||
                  seen.has(probability.value)
                )
                  return invalidResponse(
                    "OpenAI Decisions returned invalid score level indices.",
                  );
                seen.add(probability.value);
              }
              return {
                id: question.name,
                kind: "score",
                value: answer.score,
                confidence: answer.confidence,
                levelProbabilities: answer.probabilities,
              };
            }
            if (answer.type === "predicate")
              return {
                id: question.name,
                kind: "check",
                probability: answer.probability,
              };
            return invalidResponse(
              "OpenAI Decisions returned an unexpected answer.",
            );
          },
        );
        return {
          provider: context.provider,
          protocol: "openai-decisions",
          model: response.model,
          results,
          usage: {
            inputTokens: response.usage.input_tokens,
            cachedInputTokens:
              response.usage.input_tokens_details.cached_tokens,
            cacheWriteTokens:
              response.usage.input_tokens_details.cache_write_tokens,
            outputTokens: response.usage.output_tokens,
            reasoningTokens:
              response.usage.output_tokens_details.reasoning_tokens,
            totalTokens: response.usage.total_tokens,
          },
        };
      },
    };
  },
};
