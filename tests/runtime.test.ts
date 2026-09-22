import { expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
const request = (id: string) => ({
  name: "check",
  arguments: { content: id, items: [{ id, question: "Is this present?" }] },
});
async function connect(sdk: TypeSafeClient) {
  const server = createServer(sdk),
    client = new Client({ name: "runtime", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
function response(id: string) {
  return Response.json({
    model: "mock",
    answers: { [id]: { type: "noul", noul: 0.7 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

test("cancelling one concurrent call aborts its SDK request without affecting another", async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let calls = 0;
  const ctx = await connect(
    new TypeSafeClient({
      baseURL: "https://api.typesafe.ai",
      defaultModel: "fixture",
      apiKey: "mock",
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: async (_, init) => {
        calls++;
        const id = JSON.parse(init!.body as string).state;
        if (id !== "cancel") return response(id);
        return new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new DOMException("abort", "AbortError"));
            },
            { once: true },
          );
          started.resolve();
        });
      },
    }),
  );
  const controller = new AbortController();
  try {
    const pending = ctx.client
      .callTool(request("cancel"), undefined, { signal: controller.signal })
      .then(
        () => "resolved",
        () => "cancelled",
      );
    await started.promise;
    const other = await ctx.client.callTool(request("other"));
    controller.abort();
    expect(await pending).toBe("cancelled");
    await aborted.promise;
    expect(other.isError).not.toBe(true);
    expect(JSON.stringify(other)).toContain('"id":"other"');
    expect(calls).toBe(2);
  } finally {
    await ctx.close();
  }
});

test("SDK timeout returns recoverable diagnostic and never retries automatically", async () => {
  let calls = 0,
    aborts = 0;
  const ctx = await connect(
    new TypeSafeClient({
      baseURL: "https://api.typesafe.ai",
      defaultModel: "fixture",
      apiKey: "mock",
      timeout: 15,
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: async (_, init) => {
        calls++;
        return new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => {
              aborts++;
              reject(new DOMException("abort", "AbortError"));
            },
            { once: true },
          ),
        );
      },
    }),
  );
  try {
    const result = await ctx.client.callTool(request("timeout"));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("TIMEOUT");
    expect(JSON.stringify(result)).toContain("caller_decision");
    expect(calls).toBe(1);
    expect(aborts).toBe(1);
  } finally {
    await ctx.close();
  }
});

test("rate limit preserves numeric retry delay without leaking upstream details", async () => {
  const ctx = await connect(
    new TypeSafeClient({
      baseURL: "https://api.typesafe.ai",
      defaultModel: "fixture",
      apiKey: "mock",
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: async () =>
        Response.json(
          { message: "SECRET_PAYLOAD" },
          { status: 429, headers: { "retry-after": "2" } },
        ),
    }),
  );
  try {
    const result = await ctx.client.callTool(request("limited"));
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain("RATE_LIMITED");
    expect(text).toContain("2000");
    expect(text).not.toContain("SECRET_PAYLOAD");
  } finally {
    await ctx.close();
  }
});

test("advertised schemas expose rubric bounds and reject extra model-list arguments", async () => {
  let calls = 0;
  const ctx = await connect(
    new TypeSafeClient({
      baseURL: "https://api.typesafe.ai",
      defaultModel: "fixture",
      apiKey: "mock",
      fetch: async () => {
        calls++;
        return response("q");
      },
    }),
  );
  try {
    const tools = (await ctx.client.listTools()).tools;
    const score = JSON.stringify(
      tools.find((t) => t.name === "score")!.inputSchema,
    );
    const classify = JSON.stringify(
      tools.find((t) => t.name === "classify")!.inputSchema,
    );
    expect(score).toContain('"minItems":2');
    expect(score).toContain('"maxItems":10');
    expect(classify).toContain('"minProperties":2');
    expect(classify).toContain('"maxProperties":255');
    expect(
      (
        await ctx.client.callTool({
          name: "jev_list_models",
          arguments: { model: "accidental" },
        })
      ).isError,
    ).toBe(true);
    expect(calls).toBe(0);
  } finally {
    await ctx.close();
  }
});
