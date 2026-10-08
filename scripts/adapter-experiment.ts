import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProvider } from "../src/provider.ts";
import { createServer } from "../src/server.ts";
import { ResponseContractError } from "../src/failures.ts";
import type { DecisionAdapter } from "../src/decision.ts";

import {
  experimentRoot as root,
  experimentSnapshot,
  pathArgument,
} from "./experiment-support.ts";
const tev = "togethercomputer/tev1-4b-experimental";
const native = "perplexity/pplx-decider-v1-27b";
// This protocol is an invented local fixture, not a supplier API.
const booleanAdapter: DecisionAdapter = {
  id: "fixture-boolean-v1",
  capabilities: () => ({
    judgments: ["check"],
    inputs: ["text", "json"],
    mixedQuestions: false,
    maxQuestions: 1,
    confidence: "unavailable",
  }),
  prepare(input, context) {
    const item = input.checks?.[0];
    assert(item);
    return {
      path: "/decide",
      body: {
        engine: context.model,
        subject: input.content,
        predicate: item.question,
        correlation: item.id,
      },
      decode(raw) {
        if (
          !raw ||
          typeof raw !== "object" ||
          !("allow" in raw) ||
          typeof raw.allow !== "boolean" ||
          !("correlation" in raw) ||
          raw.correlation !== item.id
        )
          throw new ResponseContractError("Invalid boolean fixture reply.");
        return {
          provider: context.provider,
          protocol: "fixture-boolean-v1",
          model: context.model,
          results: [{ id: item.id, kind: "check", value: raw.allow }],
        };
      },
    };
  },
};

async function fixtureHost(baseURL: string) {
  const server = createServer(
    createProvider(
      {
        kind: "custom",
        baseURL,
        defaultModel: "fixture/boolean",
        protocol: booleanAdapter.id,
      },
      {
        adapters: [booleanAdapter],
        models: [
          {
            provider: "custom",
            model: "fixture/boolean",
            protocol: booleanAdapter.id,
            availability: "supported",
          },
        ],
      },
    ),
  );
  await server.connect(new StdioServerTransport());
}

type Trace = {
  method: string;
  path: string;
  protocol: string;
  body?: Record<string, unknown>;
};
type Scenario = {
  name: string;
  verdict: "passed";
  calls: number;
  protocols: string[];
};

async function snapshot(entryPath: string) {
  const { entry, ...source } = await experimentSnapshot(
    entryPath,
    import.meta.path,
  );
  return {
    ...source,
    primaryEntry: entry,
    customFixtureHost: {
      path: "scripts/adapter-experiment.ts",
      mode: "source",
      sha256: createHash("sha256")
        .update(await Bun.file(import.meta.path).bytes())
        .digest("hex"),
      command: [
        "bun",
        "--no-env-file",
        "scripts/adapter-experiment.ts",
        "--fixture-host",
        "<loopback-base-url>",
      ],
    },
  };
}

async function connect(
  baseURL: string,
  entryPath: string,
  custom = false,
  defaultModel = native,
) {
  const client = new Client({ name: "jevs-adapter-experiment", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: custom
        ? ["--no-env-file", import.meta.path, "--fixture-host", baseURL]
        : ["--no-env-file", entryPath],
      cwd: tmpdir(),
      // Do not inherit the caller's provider configuration or load .env.
      env: {
        JEVS_PROVIDER: "openrouter",
        JEVS_PROTOCOL: "",
        JEVS_API_KEY: "local-fixture-only",
        JEVS_BASE_URL: baseURL,
        JEVS_DEFAULT_MODEL: defaultModel,
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
      },
      stderr: "pipe",
    }),
  );
  return client;
}

function output(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}
function errorCode(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.equal(result.isError, true);
  const text = (result.content as { type: string; text?: string }[]).find(
    (item) => item.type === "text",
  )?.text;
  assert(text);
  return JSON.parse(text).error.code as string;
}

export async function runExperiment(
  reportPath = resolve(root, `.local/adapter-experiment-${randomUUID()}.json`),
  entryPath = resolve(root, "src/index.ts"),
) {
  const before = await snapshot(entryPath);
  const traces: Trace[] = [];
  const scenarios: Scenario[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body =
        request.method === "POST"
          ? ((await request.json()) as Record<string, any>)
          : undefined;
      const protocol =
        path === "/alpha/decisions"
          ? "openrouter-decisions"
          : path === "/v1/chat/completions"
            ? "tev1-chat"
            : path === "/decide"
              ? booleanAdapter.id
              : "catalog";
      traces.push({
        method: request.method,
        path,
        protocol,
        ...(body ? { body } : {}),
      });
      if (path === "/v1/models")
        return Response.json({
          data: [native, tev].map((id) => ({
            id,
            architecture: { output_modalities: ["decisions"] },
          })),
        });
      if (path === "/alpha/decisions" && body) {
        const answers = Object.fromEntries(
          Object.entries(body.questions).map(([id, question]) => {
            const q = question as Record<string, any>;
            return [
              id,
              q.type === "choice"
                ? { type: "choice", choice: Object.keys(q.criteria)[1] }
                : q.type === "score"
                  ? { type: "score", score: 0.6 }
                  : { type: "noul", noul: 0.74 },
            ];
          }),
        );
        return Response.json({
          model: body.model,
          answers,
          usage: { input_tokens: 12, output_tokens: 3 },
        });
      }
      if (path === "/v1/chat/completions" && body) {
        const task = JSON.parse(body.messages[1].content);
        return Response.json({
          model: body.model,
          choices: [
            {
              finish_reason: task.state === "truncated" ? "length" : "stop",
              message: {
                role: "assistant",
                content:
                  task.state === "explanation"
                    ? "B because this is the right option."
                    : task.state === "batch-bad"
                      ? "Z"
                      : "B",
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 1 },
        });
      }
      if (path === "/decide" && body)
        return Response.json({ allow: true, correlation: body.correlation });
      return new Response("Unknown fixture route", { status: 404 });
    },
  });
  const clients: Client[] = [];
  let failure: unknown;
  async function scenario(name: string, action: () => Promise<void>) {
    const start = traces.length;
    await action();
    const calls = traces.slice(start);
    scenarios.push({
      name,
      verdict: "passed",
      calls: calls.length,
      protocols: [...new Set(calls.map((call) => call.protocol))],
    });
  }
  try {
    const client = await connect(api.url.origin, entryPath);
    clients.push(client);
    const rubric = {
      id: "decision",
      question: "Select the matching option.",
      options: { 待处理: "Needs work", 已完成: "Completed" },
    };
    await scenario("catalog-info-inference-share-model-protocol", async () => {
      const catalog = output(
        await client.callTool({ name: "list_models", arguments: {} }),
      );
      for (const [model, protocol] of [
        [native, "openrouter-decisions"],
        [tev, "tev1-chat"],
      ]) {
        const info = output(
          await client.callTool({
            name: "provider_info",
            arguments: { model },
          }),
        );
        const card = catalog.models.find(
          (item: { id: string }) => item.id === model,
        );
        assert(card);
        assert.equal(info.protocol, protocol);
        assert.equal(card.protocol, info.protocol);
        assert.deepEqual(card.capabilities, info.capabilities);
        assert.equal(card.availability, info.availability);
      }
      const info = output(
        await client.callTool({
          name: "provider_info",
          arguments: { model: native },
        }),
      );
      assert.equal(info.capabilities.maxQuestions, 128);
    });
    await scenario(
      "model-tool-support-keeps-override-tools-discoverable",
      async () => {
        const start = traces.length;
        const tevDefault = await connect(api.url.origin, entryPath, false, tev);
        clients.push(tevDefault);
        const info = output(
          await tevDefault.callTool({
            name: "provider_info",
            arguments: {},
          }),
        );
        assert.equal(info.defaultModel, tev);
        assert.equal(info.unverifiedModelsAllowed, false);
        assert.equal(info.toolSupport.classify, "supported");
        assert.equal(info.toolSupport.score, "unsupported");
        assert.equal(info.toolSupport.check, "unsupported");
        const tools = (await tevDefault.listTools()).tools;
        for (const name of ["classify", "score", "check", "assess_structure"])
          assert(tools.some((tool) => tool.name === name));
        assert.equal(traces.length, start);
        const override = output(
          await tevDefault.callTool({
            name: "score",
            arguments: {
              model: native,
              content: "fixture model override",
              items: [
                {
                  id: "override-score",
                  question: "Progress?",
                  levels: ["Beginning", "Finished"],
                },
              ],
            },
          }),
        );
        assert.equal(override.protocol, "openrouter-decisions");
        assert.deepEqual(override.results, [
          { id: "override-score", kind: "score", value: 0.6 },
        ]);
        assert.equal(traces.length - start, 1);
      },
    );
    await scenario("native-mixed-judgments-one-http-request", async () => {
      const result = output(
        await client.callTool({
          name: "assess_structure",
          arguments: {
            model: native,
            content: { status: "done" },
            classifications: [rubric],
            scores: [
              {
                id: "score",
                question: "Progress?",
                levels: ["Beginning", "Finished"],
              },
            ],
            checks: [{ id: "check", question: "Complete?" }],
          },
        }),
      );
      assert.equal(result.protocol, "openrouter-decisions");
      assert.deepEqual(result.results, [
        { id: "decision", kind: "classification", value: "已完成" },
        { id: "score", kind: "score", value: 0.6 },
        { id: "check", kind: "check", probability: 0.74 },
      ]);
      assert.equal(traces.at(-1)?.protocol, result.protocol);
      assert.equal(
        Object.keys(traces.at(-1)!.body!.questions as object).length,
        3,
      );
    });
    await scenario(
      "tev-letter-remaps-original-key-without-confidence",
      async () => {
        const result = output(
          await client.callTool({
            name: "classify",
            arguments: { model: tev, content: "done", items: [rubric] },
          }),
        );
        assert.equal(result.protocol, "tev1-chat");
        assert.deepEqual(result.results, [
          { id: "decision", kind: "classification", value: "已完成" },
        ]);
        assert.equal(traces.at(-1)?.protocol, result.protocol);
      },
    );
    await scenario("unsupported-tev-shapes-rejected-before-http", async () => {
      const start = traces.length;
      const invalid = [
        {
          name: "check",
          arguments: {
            model: tev,
            content: "done",
            items: [{ id: "check", question: "Done?" }],
          },
        },
        {
          name: "score",
          arguments: {
            model: tev,
            allowUnverifiedModel: true,
            content: "done",
            items: [
              {
                id: "score",
                question: "Progress?",
                levels: ["Beginning", "Finished"],
              },
            ],
          },
        },
        {
          name: "classify",
          arguments: {
            model: tev,
            content: "done",
            items: [rubric, { ...rubric, id: "other" }],
          },
        },
        {
          name: "classify",
          arguments: {
            model: tev,
            content: "done",
            images: ["data:image/png;base64,YQ=="],
            items: [rubric],
          },
        },
      ];
      for (const call of invalid)
        assert.equal(errorCode(await client.callTool(call)), "INVALID_REQUEST");
      assert.equal(traces.length, start);
    });
    await scenario("truncation-and-explanation-rejected-no-retry", async () => {
      const start = traces.length;
      for (const content of ["truncated", "explanation"])
        assert.equal(
          errorCode(
            await client.callTool({
              name: "classify",
              arguments: { model: tev, content, items: [rubric] },
            }),
          ),
          "INVALID_RESPONSE",
        );
      assert.equal(traces.length - start, 2);
      assert(
        traces.slice(start).every((trace) => trace.protocol === "tev1-chat"),
      );
    });
    await scenario(
      "batch-record-failure-isolated-one-request-per-record",
      async () => {
        const start = traces.length;
        const result = output(
          await client.callTool({
            name: "assess_batch",
            arguments: {
              model: tev,
              classifications: [rubric],
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
        assert.equal(result.records[0].result.results[0].value, "已完成");
        assert.equal(result.records[1].id, "bad");
        assert.equal(result.records[1].status, "error");
        assert.equal(result.records[1].error.code, "INVALID_RESPONSE");
        assert.equal(traces.length - start, 2);
        assert(
          traces.slice(start).every((trace) => trace.protocol === "tev1-chat"),
        );
      },
    );
    const custom = await connect(api.url.origin, entryPath, true);
    clients.push(custom);
    await scenario(
      "new-boolean-protocol-through-unchanged-mcp-check",
      async () => {
        const start = traces.length;
        const info = output(
          await custom.callTool({ name: "provider_info", arguments: {} }),
        );
        assert.equal(info.protocol, booleanAdapter.id);
        assert.equal(info.capabilitySource, "configuration");
        assert.equal(info.availability, "supported");
        assert.equal(info.unverifiedModelsAllowed, false);
        const catalog = output(
          await custom.callTool({ name: "list_models", arguments: {} }),
        );
        assert.equal(catalog.models[0].protocol, info.protocol);
        assert.equal(traces.length, start);
        const result = output(
          await custom.callTool({
            name: "check",
            arguments: {
              content: { fixture: true },
              items: [
                { id: "boolean", question: "Is this local fixture data?" },
              ],
            },
          }),
        );
        assert.equal(result.protocol, info.protocol);
        assert.deepEqual(result.results, [
          { id: "boolean", kind: "check", value: true },
        ]);
        const request = traces.at(-1)!;
        assert.equal(request.path, "/decide");
        assert.deepEqual(request.body, {
          engine: "fixture/boolean",
          subject: { fixture: true },
          predicate: "Is this local fixture data?",
          correlation: "boolean",
        });
      },
    );
    assert.deepEqual(
      scenarios.map((scenario) => scenario.calls),
      [1, 1, 1, 1, 0, 2, 2, 1],
    );
  } catch (error) {
    failure = error;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    api.stop(true);
  }
  const after = await snapshot(entryPath);
  let snapshotStable = true;
  try {
    assert.equal(
      after.sourceSha256,
      before.sourceSha256,
      "Source files changed during the experiment.",
    );
    assert.equal(
      after.head,
      before.head,
      "Git HEAD changed during the experiment.",
    );
    assert.deepEqual(
      after.primaryEntry,
      before.primaryEntry,
      "Primary MCP entry changed during the experiment.",
    );
    assert.deepEqual(
      after.customFixtureHost,
      before.customFixtureHost,
      "Custom fixture host changed during the experiment.",
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
    reproduction: `bun --no-env-file scripts/adapter-experiment.ts --entry ${quote(relative(root, entryPath))} --output ${quote(relative(root, reportPath))}`,
    limitations: [
      "No real supplier inference or account access was tested.",
      "fixture-boolean-v1 is an invented test protocol.",
      "Native and Tev scenarios use primaryEntry; the custom boolean scenario always uses the source fixture host.",
      "Future or undocumented APIs are not proven compatible.",
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
    `Adapter experiment passed: ${scenarios.length} scenarios, ${traces.length} local HTTP calls. Report: ${reportPath}`,
  );
  return report;
}

if (import.meta.main) {
  if (process.argv[2] === "--fixture-host") {
    assert(process.argv[3]);
    await fixtureHost(process.argv[3]);
  } else {
    await runExperiment(pathArgument("--output"), pathArgument("--entry"));
  }
}
