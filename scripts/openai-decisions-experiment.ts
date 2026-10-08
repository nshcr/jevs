import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  experimentRoot as root,
  experimentSnapshot,
  pathArgument,
} from "./experiment-support.ts";
const model = "gpt-6-luna";
const protocol = "openai-decisions";
const image = "data:image/png;base64,YQ==";
const privatePayload = "fixture-private-upstream-payload-do-not-echo";
const typedOptions = [
  { value: true, description: { meaning: "boolean affirmative" } },
  { value: "true", description: "literal text" },
];
type JsonObject = Record<string, any>;
type Mode = "normal" | "bad-value" | "bad-name" | "bad-count" | "http-error";
type Trace = { method: string; path: string; mode: Mode; body?: JsonObject };

const snapshot = (entryPath: string) =>
  experimentSnapshot(entryPath, import.meta.path);

async function connect(baseURL: string, entryPath: string) {
  const client = new Client({
    name: "openai-decisions-experiment",
    version: "1",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--no-env-file", entryPath],
      cwd: tmpdir(),
      env: {
        JEVS_PROVIDER: "openai",
        JEVS_PROTOCOL: "",
        JEVS_API_KEY: "local-fixture-only",
        JEVS_BASE_URL: baseURL,
        JEVS_DEFAULT_MODEL: model,
        JEVS_ALLOW_UNVERIFIED_MODELS: "false",
        JEVS_REQUEST_TIMEOUT_MS: "5000",
        JEVS_MAX_CONCURRENCY: "2",
        JEVS_MAX_QUEUE: "8",
        JEVS_QUEUE_TIMEOUT_MS: "1000",
        CLOUDFLARE_ACCOUNT_ID: "",
        CLOUDFLARE_AI_GATEWAY_ID: "",
        TYPESAFE_API_KEY: "",
        TYPESAFE_BASE_URL: "",
        TYPESAFE_DEFAULT_MODEL: "",
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
      },
      stderr: "pipe",
    }),
  );
  return client;
}

function output(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert(result.structuredContent);
  return result.structuredContent as JsonObject;
}
function error(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.equal(result.isError, true);
  assert(!JSON.stringify(result).includes(privatePayload));
  const text = (result.content as { type: string; text?: string }[]).find(
    (item) => item.type === "text",
  )?.text;
  assert(text);
  return JSON.parse(text).error as JsonObject;
}
function inputText(body: JsonObject) {
  if (typeof body.input === "string") return body.input;
  return body.input
    .flatMap((message: JsonObject) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content
            .filter((part: JsonObject) => part.type === "input_text")
            .map((part: JsonObject) => part.text),
    )
    .join("\n") as string;
}

export async function runOpenAIExperiment(
  reportPath = resolve(root, `.local/openai-decisions-${randomUUID()}.json`),
  entryPath = resolve(root, "src/index.ts"),
) {
  const before = await snapshot(entryPath);
  let mode: Mode = "normal";
  let accountHasLuna = true;
  const traces: Trace[] = [];
  const scenarios: { name: string; verdict: "passed"; calls: number }[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body =
        request.method === "POST"
          ? ((await request.json()) as JsonObject)
          : undefined;
      traces.push({
        method: request.method,
        path,
        mode,
        ...(body ? { body } : {}),
      });
      if (request.method === "GET" && path === "/v1/models")
        return Response.json({
          object: "list",
          data: [
            ...(accountHasLuna ? [model] : []),
            "gpt-6-sol",
            "gpt-4.1",
            "fixture-unknown-model",
          ].map((id) => ({
            id,
            object: "model",
            created: 1,
            owned_by: "openai",
          })),
        });
      if (request.method !== "POST" || path !== "/v1/decisions" || !body)
        return new Response("Unknown local fixture route", { status: 404 });
      if (mode === "http-error")
        return Response.json(
          { error: { message: privatePayload, code: "rate_limit_exceeded" } },
          { status: 429, headers: { "retry-after": "1" } },
        );
      const answers = body.questions.map((question: JsonObject) => {
        const name = question.name;
        if (name === "refused") return { type: "refusal", name };
        if (question.type === "predicate")
          return { type: "predicate", name, probability: 0.73 };
        if (question.type === "score")
          return {
            type: "score",
            name,
            score: 0.7,
            confidence: 0.81,
            probabilities: question.levels.map(
              (level: JsonObject, index: number) => ({
                value: index,
                label: level.label,
                probability: index === 0 ? 0.3 : 0.7,
              }),
            ),
          };
        const values = question.choices.map(
          (choice: JsonObject) => choice.value,
        );
        const choice = name === "typed-string" ? values[1] : values[0];
        return {
          type: "choice",
          name,
          choice,
          confidence: 0.8,
          probabilities: values.map((value: string | boolean) => ({
            value,
            probability: value === choice ? 0.8 : 0.2 / (values.length - 1),
          })),
        };
      });
      if (mode === "bad-value" || inputText(body) === "batch-bad")
        answers[0].choice = privatePayload;
      if (mode === "bad-name") answers[0].name = privatePayload;
      if (mode === "bad-count") answers.pop();
      return Response.json({
        model: body.model,
        answers,
        usage: {
          input_tokens: 40,
          input_tokens_details: { cached_tokens: 12, cache_write_tokens: 4 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 48,
        },
      });
    },
  });
  let client: Client | undefined;
  let failure: unknown;
  async function scenario(name: string, action: () => Promise<void>) {
    const start = traces.length;
    await action();
    scenarios.push({ name, verdict: "passed", calls: traces.length - start });
  }
  try {
    client = await connect(api.url.origin, entryPath);
    const mcp = client;
    const item = {
      id: "typed-bool",
      question: "Choose a typed value.",
      options: typedOptions,
    };
    await scenario(
      "catalog-intersects-documented-model-with-account",
      async () => {
        const info = output(
          await mcp.callTool({ name: "provider_info", arguments: { model } }),
        );
        assert.equal(info.provider, "openai");
        assert.equal(info.protocol, protocol);
        assert.equal(info.availability, "supported");
        assert.equal(info.unverifiedModelsAllowed, false);
        assert.equal(info.capabilities.minOptions, 2);
        assert.equal(info.capabilities.maxOptions, 255);
        assert.equal(info.capabilities.maxImages, 128);
        assert.equal(info.capabilities.messages, true);
        assert.equal(info.capabilities.imageDetail, true);
        assert.equal(info.capabilities.labeledScores, true);
        assert.equal(info.capabilities.safetyIdentifier, true);
        const unknown = output(
          await mcp.callTool({
            name: "provider_info",
            arguments: { model: "gpt-6-sol" },
          }),
        );
        assert.notEqual(unknown.availability, "supported");
        const available = output(
          await mcp.callTool({ name: "list_models", arguments: {} }),
        );
        assert.deepEqual(
          available.models.map((card: JsonObject) => card.id),
          [model],
        );
        assert.equal(available.models[0].protocol, info.protocol);
        assert.deepEqual(available.models[0].capabilities, info.capabilities);
        accountHasLuna = false;
        const unavailable = output(
          await mcp.callTool({ name: "list_models", arguments: {} }),
        );
        assert.deepEqual(unavailable.models, []);
        accountHasLuna = true;
      },
    );
    await scenario("typed-mixed-image-usage-and-partial-refusal", async () => {
      const content = {
        report: { status: "complete" },
        values: [true, "true"],
      };
      const result = output(
        await mcp.callTool({
          name: "assess_structure",
          arguments: {
            content,
            images: [image, { content_type: "image/png", base64: "Yg==" }],
            classifications: [
              item,
              { ...item, id: "typed-string" },
              { ...item, id: "refused" },
            ],
            scores: [
              {
                id: "score",
                question: { evaluate: "progress" },
                levels: [{ progress: "low" }, { progress: "high" }],
              },
            ],
            checks: [{ id: "predicate", question: "Is the report complete?" }],
          },
        }),
      );
      assert.equal(result.provider, "openai");
      assert.equal(result.protocol, protocol);
      assert.equal(result.model, model);
      assert.equal(result.results.length, 5);
      const results = Object.fromEntries(
        result.results.map((answer: JsonObject) => [answer.id, answer]),
      );
      assert.equal(results["typed-bool"].value, true);
      assert.equal(results["typed-string"].value, "true");
      assert.deepEqual(results["typed-bool"].probabilities, [
        { value: true, probability: 0.8 },
        { value: "true", probability: 0.2 },
      ]);
      assert.deepEqual(results.refused, {
        id: "refused",
        kind: "refusal",
        judgment: "classification",
      });
      assert.equal(results.score.value, 0.7);
      assert.equal(results.predicate.probability, 0.73);
      assert.deepEqual(result.usage, {
        inputTokens: 40,
        cachedInputTokens: 12,
        cacheWriteTokens: 4,
        outputTokens: 8,
        reasoningTokens: 3,
        totalTokens: 48,
      });
      const request = traces.at(-1)!;
      assert.equal(request.path, "/v1/decisions");
      assert(request.body);
      assert.equal(request.body.model, model);
      assert.equal(request.body.input.length, 1);
      assert.equal(request.body.input[0].role, "user");
      const parts = request.body.input[0].content;
      assert.equal(parts[0].type, "input_text");
      assert.deepEqual(JSON.parse(parts[0].text), content);
      assert.deepEqual(
        parts.slice(1).map((part: JsonObject) => ({
          type: part.type,
          image_url: part.image_url,
        })),
        [
          { type: "input_image", image_url: image },
          { type: "input_image", image_url: "data:image/png;base64,Yg==" },
        ],
      );
      const questions = request.body.questions;
      assert(Array.isArray(questions));
      assert.deepEqual(
        questions[0].choices.map((choice: JsonObject) => choice.value),
        [true, "true"],
      );
      assert.deepEqual(
        JSON.parse(questions[0].choices[0].description),
        typedOptions[0]!.description,
      );
      const score = questions.find(
        (question: JsonObject) => question.type === "score",
      );
      assert(score);
      assert.deepEqual(
        score.levels.map((level: JsonObject) => level.label),
        ["0", "1"],
      );
      assert.deepEqual(JSON.parse(score.instructions), {
        evaluate: "progress",
      });
      assert.deepEqual(
        score.levels.map((level: JsonObject) => JSON.parse(level.description)),
        [{ progress: "low" }, { progress: "high" }],
      );
      assert.deepEqual(
        results.score.levelProbabilities,
        score.levels.map((level: JsonObject, index: number) => ({
          value: index,
          label: level.label,
          probability: index === 0 ? 0.3 : 0.7,
        })),
      );
      assert(
        questions.some(
          (question: JsonObject) =>
            question.name === "predicate" && question.type === "predicate",
        ),
      );
    });
    await scenario(
      "ordered-user-messages-image-detail-labels-and-safety",
      async () => {
        const messages = [
          {
            parts: [
              { type: "text", text: "First message before image." },
              {
                type: "image",
                image: {
                  content_type: "image/png",
                  base64: "YQ==",
                  detail: "low",
                },
              },
              { type: "text", text: "First message between images." },
              {
                type: "image",
                image: {
                  content_type: "image/png",
                  base64: "Yg==",
                  detail: "high",
                },
              },
            ],
          },
          {
            parts: [
              {
                type: "image",
                image: {
                  content_type: "image/png",
                  base64: "Yw==",
                  detail: "auto",
                },
              },
              { type: "text", text: "Second message after image." },
              {
                type: "image",
                image: {
                  content_type: "image/png",
                  base64: "ZA==",
                  detail: null,
                },
              },
              { type: "text", text: "Second message before original image." },
              {
                type: "image",
                image: {
                  content_type: "image/png",
                  base64: "ZQ==",
                  detail: "original",
                },
              },
            ],
          },
        ];
        const labels = ["Low 进展", "High 完成"];
        const result = output(
          await mcp.callTool({
            name: "assess_structure",
            arguments: {
              messages,
              safetyIdentifier: "fixture-end-user",
              classifications: [item, { ...item, id: "refused" }],
              scores: [
                {
                  id: "score",
                  question: "Progress?",
                  levels: ["Beginning", "Finished"],
                  levelLabels: labels,
                },
              ],
              checks: [{ id: "predicate", question: "Finished?" }],
            },
          }),
        );
        assert.equal(result.results.length, 4);
        assert.deepEqual(result.results[1], {
          id: "refused",
          kind: "refusal",
          judgment: "classification",
        });
        const score = result.results.find(
          (answer: JsonObject) => answer.id === "score",
        );
        assert.deepEqual(score.levelProbabilities, [
          { value: 0, label: labels[0], probability: 0.3 },
          { value: 1, label: labels[1], probability: 0.7 },
        ]);
        const body = traces.at(-1)!.body!;
        assert.equal(body.safety_identifier, "fixture-end-user");
        assert.deepEqual(body.input, [
          {
            role: "user",
            content: [
              { type: "input_text", text: "First message before image." },
              {
                type: "input_image",
                image_url: "data:image/png;base64,YQ==",
                detail: "low",
              },
              { type: "input_text", text: "First message between images." },
              {
                type: "input_image",
                image_url: "data:image/png;base64,Yg==",
                detail: "high",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "data:image/png;base64,Yw==",
                detail: "auto",
              },
              { type: "input_text", text: "Second message after image." },
              {
                type: "input_image",
                image_url: "data:image/png;base64,ZA==",
                detail: null,
              },
              {
                type: "input_text",
                text: "Second message before original image.",
              },
              {
                type: "input_image",
                image_url: "data:image/png;base64,ZQ==",
                detail: "original",
              },
            ],
          },
        ]);
        assert.deepEqual(
          body.questions.find(
            (question: JsonObject) => question.type === "score",
          ).levels,
          [
            { label: labels[0], description: "Beginning" },
            { label: labels[1], description: "Finished" },
          ],
        );
      },
    );
    await scenario(
      "unverified-model-requires-explicit-call-admission",
      async () => {
        const start = traces.length;
        const selected = "gpt-other-unverified";
        const info = output(
          await mcp.callTool({
            name: "provider_info",
            arguments: { model: selected },
          }),
        );
        assert.equal(info.availability, "unverified");
        assert.equal(info.unverifiedModelsAllowed, false);
        assert.equal(info.toolSupport.classify, "unverified");
        const arguments_ = {
          model: selected,
          content: "fixture",
          items: [item],
        };
        assert.equal(
          error(await mcp.callTool({ name: "classify", arguments: arguments_ }))
            .code,
          "INVALID_REQUEST",
        );
        assert.equal(traces.length, start);
        const result = output(
          await mcp.callTool({
            name: "classify",
            arguments: { ...arguments_, allowUnverifiedModel: true },
          }),
        );
        assert.equal(result.model, selected);
        assert.equal(result.results[0].value, true);
        assert.equal(traces.at(-1)!.body!.model, selected);
        assert.equal(traces.length - start, 1);
      },
    );
    await scenario(
      "raw-parameters-url-media-and-conflicting-inputs-rejected-locally",
      async () => {
        const start = traces.length;
        const base = { content: "fixture", items: [item] };
        const invalid = [
          { ...base, raw: { temperature: 0 } },
          { ...base, temperature: 0 },
          { ...base, images: ["https://example.invalid/image.png"] },
          {
            items: [item],
            messages: [
              {
                parts: [
                  { type: "image", image: "https://example.invalid/image.png" },
                ],
              },
            ],
          },
          {
            ...base,
            messages: [
              { parts: [{ type: "text", text: "Conflicting context." }] },
            ],
          },
          {
            items: [item],
            images: [image],
            messages: [
              { parts: [{ type: "text", text: "Conflicting image." }] },
            ],
          },
          {
            items: [item],
            videos: [{ frames: [image] }],
            messages: [
              { parts: [{ type: "text", text: "Conflicting video." }] },
            ],
          },
        ];
        for (const arguments_ of invalid) {
          const result = await mcp.callTool({
            name: "classify",
            arguments: arguments_,
          });
          assert.equal(result.isError, true);
          assert(!JSON.stringify(result).includes(privatePayload));
        }
        assert.equal(traces.length, start);
      },
    );
    await scenario(
      "malformed-answer-values-names-counts-sanitized",
      async () => {
        const start = traces.length;
        for (const invalid of ["bad-value", "bad-name", "bad-count"] as const) {
          mode = invalid;
          const result = error(
            await mcp.callTool({
              name: "classify",
              arguments: { content: "fixture", items: [item] },
            }),
          );
          assert.equal(result.code, "INVALID_RESPONSE");
          assert.equal(result.retry, "never");
        }
        mode = "normal";
        assert.equal(traces.length - start, 3);
      },
    );
    await scenario(
      "native-choice-image-boundaries-and-local-rejection",
      async () => {
        const start = traces.length;
        for (const count of [1, 256]) {
          const options = Array.from({ length: count }, (_, index) => ({
            value: `option-${index}`,
          }));
          assert.equal(
            error(
              await mcp.callTool({
                name: "classify",
                arguments: {
                  content: "fixture",
                  items: [{ ...item, options }],
                },
              }),
            ).code,
            "INVALID_REQUEST",
          );
        }
        assert.equal(
          error(
            await mcp.callTool({
              name: "classify",
              arguments: {
                content: "fixture",
                images: Array(129).fill(image),
                items: [item],
              },
            }),
          ).code,
          "INVALID_REQUEST",
        );
        assert.equal(
          error(
            await mcp.callTool({
              name: "classify",
              arguments: {
                messages: [
                  {
                    parts: Array.from({ length: 64 }, () => ({
                      type: "image",
                      image,
                    })),
                  },
                  {
                    parts: Array.from({ length: 65 }, () => ({
                      type: "image",
                      image,
                    })),
                  },
                ],
                items: [item],
              },
            }),
          ).code,
          "INVALID_REQUEST",
        );
        assert.equal(traces.length, start);
        for (const count of [2, 255]) {
          const options = Array.from({ length: count }, (_, index) => ({
            value: `option-${index}`,
          }));
          const result = output(
            await mcp.callTool({
              name: "classify",
              arguments: { content: "fixture", items: [{ ...item, options }] },
            }),
          );
          assert.equal(result.results[0].value, "option-0");
          assert.equal(traces.at(-1)!.body!.questions[0].choices.length, count);
        }
        output(
          await mcp.callTool({
            name: "classify",
            arguments: {
              content: "fixture",
              images: Array(128).fill(image),
              items: [item],
            },
          }),
        );
        assert.equal(
          traces
            .at(-1)!
            .body!.input[0].content.filter(
              (part: JsonObject) => part.type === "input_image",
            ).length,
          128,
        );
        assert.equal(traces.length - start, 3);
      },
    );
    await scenario("http-failure-sanitized-no-automatic-retry", async () => {
      const start = traces.length;
      mode = "http-error";
      const result = error(
        await mcp.callTool({
          name: "classify",
          arguments: { content: "fixture", items: [item] },
        }),
      );
      assert.equal(result.code, "RATE_LIMITED");
      assert.equal(result.status, 429);
      assert.equal(result.upstreamCode, "rate_limit_exceeded");
      assert.equal(result.retryAfterMs, 1000);
      assert.equal(traces.length - start, 1);
      mode = "normal";
    });
    await scenario(
      "batch-malformed-record-isolated-one-http-per-record",
      async () => {
        const start = traces.length;
        const result = output(
          await mcp.callTool({
            name: "assess_batch",
            arguments: {
              classifications: [item],
              records: [
                { id: "good", content: "batch-good" },
                { id: "bad", content: "batch-bad" },
              ],
            },
          }),
        );
        assert.equal(result.records.length, 2);
        assert.equal(result.records[0].id, "good");
        assert.equal(result.records[0].status, "ok");
        assert.equal(result.records[0].result.results[0].value, true);
        assert.equal(result.records[1].id, "bad");
        assert.equal(result.records[1].status, "error");
        assert.equal(result.records[1].error.code, "INVALID_RESPONSE");
        assert(!JSON.stringify(result).includes(privatePayload));
        assert.equal(traces.length - start, 2);
      },
    );
    await scenario(
      "focused-score-forwards-ordered-evidence-and-call-metadata",
      async () => {
        const start = traces.length;
        const selected = "gpt-focused-metadata-unverified";
        const labels = ["focused-low", "focused-high"];
        const result = output(
          await mcp.callTool({
            name: "score",
            arguments: {
              model: selected,
              allowUnverifiedModel: true,
              safetyIdentifier: "",
              messages: [
                {
                  parts: [
                    { type: "text", text: "Focused tool evidence." },
                    {
                      type: "image",
                      image: {
                        content_type: "image/png",
                        base64: "YQ==",
                        detail: "original",
                      },
                    },
                  ],
                },
              ],
              items: [
                {
                  id: "focused-score",
                  question: "Progress?",
                  levels: ["Beginning", "Finished"],
                  levelLabels: labels,
                },
              ],
            },
          }),
        );
        assert.equal(result.model, selected);
        assert.equal(result.results[0].value, 0.7);
        assert.deepEqual(result.results[0].levelProbabilities, [
          { value: 0, label: labels[0], probability: 0.3 },
          { value: 1, label: labels[1], probability: 0.7 },
        ]);
        const body = traces.at(-1)!.body!;
        assert.equal(body.model, selected);
        assert.equal(body.safety_identifier, "");
        assert.deepEqual(body.input, [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Focused tool evidence." },
              { type: "input_image", image_url: image, detail: "original" },
            ],
          },
        ]);
        assert.deepEqual(body.questions, [
          {
            type: "score",
            name: "focused-score",
            instructions: "Progress?",
            levels: [
              { label: labels[0], description: "Beginning" },
              { label: labels[1], description: "Finished" },
            ],
          },
        ]);
        assert.equal(traces.length - start, 1);
      },
    );
    await scenario(
      "batch-preserves-record-messages-and-shared-rubric-metadata",
      async () => {
        const start = traces.length;
        const selected = "gpt-batch-metadata-unverified";
        const labels = ["未完成", "已完成"];
        const result = output(
          await mcp.callTool({
            name: "assess_batch",
            arguments: {
              model: selected,
              allowUnverifiedModel: true,
              safetyIdentifier: null,
              scores: [
                {
                  id: "shared-score",
                  question: "Progress?",
                  levels: ["Unfinished", "Completed"],
                  levelLabels: labels,
                },
              ],
              records: [
                {
                  id: "alpha",
                  messages: [
                    {
                      parts: [
                        { type: "text", text: "record-alpha" },
                        {
                          type: "image",
                          image: {
                            content_type: "image/png",
                            base64: "YQ==",
                            detail: "high",
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "beta",
                  messages: [
                    {
                      parts: [
                        {
                          type: "image",
                          image: {
                            content_type: "image/png",
                            base64: "Yg==",
                            detail: null,
                          },
                        },
                        { type: "text", text: "record-beta" },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );
        assert.deepEqual(
          result.records.map((record: JsonObject) => [
            record.id,
            record.status,
          ]),
          [
            ["alpha", "ok"],
            ["beta", "ok"],
          ],
        );
        for (const record of result.records) {
          assert.equal(record.result.model, selected);
          assert.deepEqual(record.result.results[0].levelProbabilities, [
            { value: 0, label: labels[0], probability: 0.3 },
            { value: 1, label: labels[1], probability: 0.7 },
          ]);
        }
        const requests = traces.slice(start);
        assert.equal(requests.length, 2);
        for (const request of requests) {
          assert.equal(request.path, "/v1/decisions");
          assert.equal(request.body!.model, selected);
          assert.equal(request.body!.safety_identifier, null);
          assert.deepEqual(request.body!.questions, [
            {
              type: "score",
              name: "shared-score",
              instructions: "Progress?",
              levels: [
                { label: labels[0], description: "Unfinished" },
                { label: labels[1], description: "Completed" },
              ],
            },
          ]);
        }
        const byRecord = new Map(
          requests.map((request) => [inputText(request.body!), request.body!]),
        );
        assert.deepEqual(byRecord.get("record-alpha")?.input, [
          {
            role: "user",
            content: [
              { type: "input_text", text: "record-alpha" },
              { type: "input_image", image_url: image, detail: "high" },
            ],
          },
        ]);
        assert.deepEqual(byRecord.get("record-beta")?.input, [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "data:image/png;base64,Yg==",
                detail: null,
              },
              { type: "input_text", text: "record-beta" },
            ],
          },
        ]);
      },
    );
    assert.deepEqual(
      scenarios.map((scenario) => scenario.calls),
      [2, 1, 1, 1, 0, 3, 3, 1, 2, 1, 2],
    );
  } catch (error) {
    failure = error;
  } finally {
    await client?.close();
    api.stop(true);
  }
  const after = await snapshot(entryPath);
  let snapshotStable = true;
  try {
    assert.equal(
      after.sourceSha256,
      before.sourceSha256,
      "Source changed during the experiment.",
    );
    assert.equal(
      after.head,
      before.head,
      "HEAD changed during the experiment.",
    );
    assert.deepEqual(
      after.entry,
      before.entry,
      "MCP entry changed during the experiment.",
    );
    assert.equal(after.packageVersion, before.packageVersion);
    assert.equal(after.bun, before.bun);
  } catch (error) {
    snapshotStable = false;
    failure ??= error;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const report = {
    evidence: "local-fixture",
    verdict: failure ? "failed" : "passed",
    generatedAt: new Date().toISOString(),
    contract:
      "https://developers.openai.com/api/reference/resources/decisions/methods/create",
    reproduction: `bun --no-env-file scripts/openai-decisions-experiment.ts --entry ${quote(relative(root, entryPath))} --output ${quote(relative(root, reportPath))}`,
    limitations: [
      "Real MCP stdio and local HTTP were exercised with synthetic API replies.",
      "No real OpenAI inference, preview entitlement, or account access was tested.",
      "Source, dist, and plugin bundles require separate runs and entry hashes.",
    ],
    before,
    after,
    snapshotStable,
    scenarios,
    totalHttpCalls: traces.length,
    traces,
    ...(failure
      ? {
          failure: failure instanceof Error ? failure.message : String(failure),
        }
      : {}),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (failure) throw failure;
  console.log(
    `OpenAI Decisions experiment passed: ${scenarios.length} scenarios, ${traces.length} local HTTP calls. Report: ${reportPath}`,
  );
  return report;
}

if (import.meta.main) {
  await runOpenAIExperiment(pathArgument("--output"), pathArgument("--entry"));
}
