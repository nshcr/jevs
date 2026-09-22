import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TypeSafeClient, APIUserAbortError } from "@typesafe-ai/sdk";
import { createServer } from "../src/server.ts";
import { batchSchema } from "../src/tasks.ts";
import { batchOutputSchema, runBatch } from "../src/batch.ts";
import { RequestScheduler } from "../src/scheduler.ts";
const input = {
  records: Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    content: { index: i },
  })),
  checks: [{ id: "valid", question: "Is this valid?" }],
};

test("MCP multi-record batch preserves correlation, isolates failures and limits concurrency", async () => {
  let active = 0,
    peak = 0;
  const seen: number[] = [];
  const sdk = new TypeSafeClient({
    apiKey: "fixture",
    baseURL: "https://api.typesafe.ai",
    defaultModel: "fixture",
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: async (_, init) => {
      const request = JSON.parse(init!.body as string);
      const i = request.state.index;
      seen.push(i);
      active++;
      peak = Math.max(active, peak);
      try {
        await Bun.sleep(i === 0 ? 15 : 1);
        if (i === 1)
          return Response.json(
            { secret: "do not echo" },
            { status: 429, headers: { "retry-after": "1" } },
          );
        return Response.json({
          model: "fixture",
          answers: { valid: { type: "noul", noul: i / 10 } },
          usage: { input_tokens: 3, output_tokens: 1 },
        });
      } finally {
        active--;
      }
    },
  });
  const server = createServer(sdk, { concurrency: 2 }),
    client = new Client({ name: "batch-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const response = await client.callTool({
      name: "assess_batch",
      arguments: input,
    });
    expect(response.isError).not.toBe(true);
    const result = batchOutputSchema.parse(response.structuredContent);
    expect(result.records.map((r) => r.id)).toEqual(
      input.records.map((r) => r.id),
    );
    expect(result.records[1]).toMatchObject({
      id: "r1",
      status: "error",
      error: { code: "RATE_LIMITED", retryAfterMs: 1000 },
    });
    for (const [i, r] of result.records.entries())
      if (r.status === "ok")
        expect(r.result.results[0]).toEqual({
          id: "valid",
          kind: "check",
          probability: i / 10,
        });
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(JSON.stringify(response)).not.toContain("do not echo");
    for (const invalid of [
      { ...input, records: [input.records[0], input.records[0]] },
      { ...input, content: "accidental shared context" },
      {
        ...input,
        records: Array.from({ length: 33 }, (_, i) => ({
          id: String(i),
          content: "x",
        })),
      },
    ]) {
      expect(
        (await client.callTool({ name: "assess_batch", arguments: invalid }))
          .isError,
      ).toBe(true);
    }
    expect(seen.length).toBe(5);
  } finally {
    await client.close();
    await server.close();
  }
});

test("batch cancellation aborts active requests and leaves remaining records unsubmitted", async () => {
  const abort = new AbortController(),
    started = Promise.withResolvers<void>();
  let calls = 0;
  const pending = runBatch(
    batchSchema.parse(input),
    2,
    abort.signal,
    async (_, signal) => {
      calls++;
      if (calls === 2) started.resolve();
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new APIUserAbortError()),
          { once: true },
        ),
      );
    },
  );
  await started.promise;
  abort.abort();
  const result = await pending;
  expect(calls).toBe(2);
  expect(result.records).toHaveLength(5);
  expect(
    result.records.every(
      (r) => r.status === "error" && r.error.code === "CANCELLED",
    ),
  ).toBe(true);
});

test("a large batch yields slots to a waiting realtime request", async () => {
  const scheduler = new RequestScheduler({ concurrency: 2 });
  const order: string[] = [];
  const first = Promise.withResolvers<void>();
  let calls = 0;
  const signal = new AbortController().signal;
  const pending = runBatch(
    batchSchema.parse(input),
    2,
    signal,
    async (record, s) =>
      scheduler.run(async () => {
        const id = String((record.content as { index: number }).index);
        order.push(id);
        calls++;
        if (calls <= 2) await first.promise;
        return {
          results: [{ id: "valid", kind: "check" as const, probability: 1 }],
          model: "fixture",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }, s),
  );
  const realtime = scheduler.run(async () => {
    order.push("realtime");
  }, signal);
  first.resolve();
  await Promise.all([pending, realtime]);
  expect(order.indexOf("realtime")).toBe(2);
});
