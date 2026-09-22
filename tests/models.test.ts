import { expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { providerFetch } from "../src/provider.ts";

async function catalog(
  body: string,
  baseURL = "https://api.typesafe.ai",
  status = 200,
) {
  let calls = 0;
  const sdk = new TypeSafeClient({
    apiKey: "fixture",
    baseURL,
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: providerFetch(async () => {
      calls++;
      return new Response(body, {
        status,
        headers: { "content-type": "application/json", "retry-after": "2" },
      });
    }),
  });
  const server = createServer(sdk),
    client = new Client({ name: "models-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({
      name: "jev_list_models",
      arguments: {},
    });
    expect(calls).toBe(1);
    const text = JSON.parse((result.content as { text: string }[])[0]!.text);
    return { result, text };
  } finally {
    await client.close();
    await server.close();
  }
}

test("malformed successful catalogs consistently report INVALID_RESPONSE", async () => {
  for (const [baseURL, body] of [
    ["https://api.typesafe.ai", '{"models":"bad"}'],
    ["https://api.typesafe.ai", '{"models":[{"name":12}]}'],
    ["https://api.typesafe.ai", "{}"],
    ["https://api.typesafe.ai", "null"],
    ["https://api.typesafe.ai", "upstream-private-body"],
    ["https://api.typesafe.ai", ""],
    ["https://opencode.ai/zen", '{"object":"list","data":[{"id":7}]}'],
  ]) {
    const { result, text } = await catalog(body!, baseURL!);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text.error.code).toBe("INVALID_RESPONSE");
    expect(text.error.retry).toBe("never");
    expect(JSON.stringify(result)).not.toContain("upstream-private-body");
  }
});

test("catalog validation preserves native and Zen success and SDK HTTP failures", async () => {
  const card = {
    name: "jev-fixture",
    description: "Fixture",
    release_date: "2026-09-01",
  };
  for (const [baseURL, body, models] of [
    ["https://api.typesafe.ai", JSON.stringify({ models: [card] }), [card]],
    ["https://api.typesafe.ai", '{"models":[]}', []],
    [
      "https://opencode.ai/zen",
      '{"object":"list","data":[{"id":"jev-fixture"},{"id":"other"}]}',
      [{ name: "jev-fixture", description: "", release_date: "" }],
    ],
  ] as const) {
    const { result, text } = await catalog(body, baseURL);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ models });
    expect(text).toEqual(result.structuredContent);
  }
  for (const [status, code] of [
    [401, "ACCESS_DENIED"],
    [429, "RATE_LIMITED"],
    [500, "SERVICE_UNAVAILABLE"],
  ] as const) {
    const { result, text } = await catalog(
      '{"message":"upstream-private-body"}',
      "https://api.typesafe.ai",
      status,
    );
    expect(result.isError).toBe(true);
    expect(text.error.code).toBe(code);
    expect(text.error.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("upstream-private-body");
    if (status === 429) expect(text.error.retryAfterMs).toBe(2000);
  }
});
