import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toResult } from "../src/tasks.ts";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { createServer } from "../src/server.ts";

const questions = {
  category: {
    type: "choice",
    instructions: "Which team?",
    criteria: { billing: null, support: { description: "Technical help" } },
  },
  urgency: {
    type: "noul",
    instructions: ["Is urgent?"],
    criteria: { true: "Time sensitive" },
  },
  severity: {
    type: "score",
    instructions: "Severity?",
    criteria: ["Low", "High"],
  },
};
const assessment = {
  classifications: [
    {
      id: "category",
      question: questions.category.instructions,
      options: questions.category.criteria,
    },
  ],
  checks: [
    {
      id: "urgency",
      question: questions.urgency.instructions,
      yes: "Time sensitive",
    },
  ],
  scores: [
    {
      id: "severity",
      question: questions.severity.instructions,
      levels: questions.severity.criteria,
    },
  ],
};
const answer = {
  model: "jev-test",
  answers: {
    category: {
      type: "choice",
      choice: "billing",
      confidence: 0.8,
      probabilities: { billing: 0.9, support: 0.1 },
    },
    urgency: { type: "noul", noul: 0.9 },
    severity: {
      type: "score",
      score: 0.7,
      confidence: 0.4,
      probabilities: { "0": 0.3, "1": 0.7 },
      legend: { "0": "Low", "1": "High" },
    },
  },
  usage: { input_tokens: 20, output_tokens: 10 },
};

test("stdio: handshake, discovery, official SDK HTTP, mixed questions, model list and validation", async () => {
  const requests: { path: string; body: unknown; auth: string | null }[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({
        path,
        body: req.method === "POST" ? await req.json() : null,
        auth: req.headers.get("authorization"),
      });
      if (path === "/v1/models")
        return Response.json({
          models: [
            {
              name: "jev-test",
              description: "Fixture",
              release_date: "2026-01-01",
            },
          ],
        });
      return Response.json(answer);
    },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.ts"],
    cwd: process.cwd(),
    env: {
      TYPESAFE_API_KEY: "test-key",
      TYPESAFE_BASE_URL: api.url.origin,
      TYPESAFE_DEFAULT_MODEL: "jev-test",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "assess_batch",
      "classify",
      "score",
      "check",
      "assess_structure",
      "jev_list_models",
      "jev_guide",
    ]);
    const result = await client.callTool({
      name: "assess_structure",
      arguments: { content: { ticket: "Refund ASAP" }, ...assessment },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(
      toResult(answer as SystemOneResult<Questions>),
    );
    expect(requests[0]).toEqual({
      path: "/v1/systemone",
      auth: "Bearer test-key",
      body: { state: { ticket: "Refund ASAP" }, questions, model: "jev-test" },
    });
    await client.callTool({
      name: "assess_structure",
      arguments: { content: null, ...assessment, model: "jev-override" },
    });
    expect((requests[1]!.body as { model: string }).model).toBe("jev-override");
    const models = await client.callTool({
      name: "jev_list_models",
      arguments: {},
    });
    expect(models.isError).not.toBe(true);
    expect(models.structuredContent).toHaveProperty("models");
    const before = requests.length;
    for (const args of [
      { content: "x" },
      {
        content: "x",
        scores: [{ id: "q", question: null, levels: ["Only one"] }],
      },
      {
        content: "x",
        classifications: [{ id: "q", question: null, options: {} }],
      },
      { content: 123, ...assessment },
      { ...assessment },
      { content: "x", ...assessment, extra: "rejected" },
      {
        content: "x",
        ...assessment,
        checks: [{ id: "category", question: "Duplicate" }],
      },
    ]) {
      const invalid = await client.callTool({
        name: "assess_structure",
        arguments: args,
      });
      expect(invalid.isError).toBe(true);
    }
    expect(requests.length).toBe(before);
  } finally {
    await client.close();
    api.stop(true);
  }
});

for (const status of [401, 429, 500]) {
  test(`HTTP ${status} becomes sanitized MCP tool error without retries`, async () => {
    let calls = 0;
    const sdk = new TypeSafeClient({
      baseURL: "https://api.typesafe.ai",
      defaultModel: "fixture",
      apiKey: "test",
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: async () => {
        calls++;
        return Response.json({ message: "SECRET_INPUT" }, { status });
      },
    });
    const server = createServer(sdk);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: "assess_structure",
        arguments: { content: "x", ...assessment },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(String(status));
      expect(JSON.stringify(result)).not.toContain("SECRET_INPUT");
      expect(calls).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test("without key: discovery works and inference returns actionable configuration error", async () => {
  const client = new Client({ name: "offline", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.ts"],
    cwd: process.cwd(),
    env: { TYPESAFE_API_KEY: "" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(7);
    expect(
      (await client.callTool({ name: "jev_guide", arguments: {} })).isError,
    ).not.toBe(true);
    const result = await client.callTool({
      name: "check",
      arguments: { content: null, items: [{ id: "q", question: null }] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("NOT_CONFIGURED");
  } finally {
    await client.close();
  }
});

test("individual tools preserve all structured fields and normalize results", async () => {
  const requests: any[] = [];
  const sdk = new TypeSafeClient({
    baseURL: "https://api.typesafe.ai",
    defaultModel: "fixture",
    apiKey: "test",
    logLevel: "off",
    fetch: async (_, init) => {
      const req = JSON.parse(init!.body as string);
      requests.push(req);
      const [id, q] = Object.entries(req.questions)[0] as [string, any];
      const result =
        q.type === "choice"
          ? {
              type: "choice",
              choice: "a",
              probabilities: { a: 0.8, b: 0.2 },
              confidence: 0.6,
            }
          : q.type === "score"
            ? {
                type: "score",
                score: 0.8,
                probabilities: { "0": 0.2, "1": 0.8 },
                confidence: 0.6,
                legend: { "0": q.criteria[0], "1": q.criteria[1] },
              }
            : { type: "noul", noul: 0.8 };
      return Response.json({
        model: "fixture",
        answers: { [id]: result },
        usage: { input_tokens: 1, output_tokens: 2 },
      });
    },
  });
  const server = createServer(sdk);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const question = {
    question: "Verify field",
    field: { name: "invoice", nullable: true, examples: [1, null] },
  };
  const content = { invoice: { number: 123, tags: ["paid"] } };
  const options = { a: { taxonomy: ["A", { leaf: "B" }] }, b: null };
  const levels = [{ summary: "Low", signals: ["one"] }, ["High", { min: 2 }]];
  const yes = { definition: "Matches", examples: [true] };
  try {
    const classified = await client.callTool({
      name: "classify",
      arguments: { content, items: [{ id: "q", question, options }] },
    });
    expect(classified.structuredContent).toHaveProperty("results", [
      {
        id: "q",
        kind: "classification",
        value: "a",
        probabilities: { a: 0.8, b: 0.2 },
        confidence: 0.6,
      },
    ]);
    await client.callTool({
      name: "score",
      arguments: {
        content,
        items: [{ id: "q", question: [question], levels }],
      },
    });
    const checked = await client.callTool({
      name: "check",
      arguments: {
        content,
        items: [{ id: "q", question: null, yes, no: ["Mismatch", null] }],
      },
    });
    expect(checked.structuredContent).toHaveProperty("results", [
      { id: "q", kind: "check", probability: 0.8 },
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[0].state).toEqual(content);
    expect(requests[0].questions.q).toEqual({
      type: "choice",
      instructions: question,
      criteria: options,
    });
    expect(requests[1].questions.q).toEqual({
      type: "score",
      instructions: [question],
      criteria: levels,
    });
    expect(requests[2].questions.q).toEqual({
      type: "noul",
      instructions: null,
      criteria: { true: yes, false: ["Mismatch", null] },
    });
    for (const name of ["classify", "score", "check"]) {
      const item =
        name === "classify"
          ? { id: "q", question, options }
          : name === "score"
            ? { id: "q", question, levels }
            : { id: "q", question };
      const invalid = await client.callTool({
        name,
        arguments: { content, items: [item, item] },
      });
      expect(invalid.isError).toBe(true);
    }
    expect(requests).toHaveLength(3);
  } finally {
    await client.close();
    await server.close();
  }
});
