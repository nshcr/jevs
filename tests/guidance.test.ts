import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createServer } from "../src/server.ts";
import examples from "../skills/jev-mcp/references/examples.json";

test("guide discovery is local and every published example is callable", async () => {
  let calls = 0;
  const sdk = new TypeSafeClient({
    baseURL: "https://api.typesafe.ai",
    defaultModel: "fixture",
    apiKey: "mock",
    logLevel: "off",
    fetch: async (_, init) => {
      calls++;
      const request = JSON.parse(init!.body as string);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, raw]) => {
          const q = raw as {
            type: string;
            criteria?: Record<string, unknown> | unknown[];
          };
          if (q.type === "noul") return [id, { type: "noul", noul: 0.8 }];
          const keys = Object.keys(q.criteria!);
          const probabilities = Object.fromEntries(
            keys.map((k, i) => [k, i === 0 ? 1 : 0]),
          );
          return [
            id,
            q.type === "choice"
              ? {
                  type: "choice",
                  choice: keys[0],
                  probabilities,
                  confidence: 1,
                }
              : {
                  type: "score",
                  score: 0,
                  probabilities,
                  confidence: 1,
                  legend: Object.fromEntries(Object.entries(q.criteria!)),
                },
          ];
        }),
      );
      return Response.json({
        model: "mock",
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const server = createServer(sdk),
    client = new Client({ name: "guide-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const defaultGuide = await client.callTool({
      name: "jev_guide",
      arguments: {},
    });
    expect((defaultGuide.structuredContent as { topic: string }).topic).toBe(
      "overview",
    );
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(5);
    for (const resource of resources.resources) {
      const topic = resource.uri.split("/").at(-1)!;
      const guide = await client.callTool({
        name: "jev_guide",
        arguments: { topic },
      });
      const read = await client.readResource({ uri: resource.uri });
      expect(read.contents[0]).toHaveProperty(
        "text",
        (guide.structuredContent as { text: string }).text,
      );
    }
    expect(calls).toBe(0);
    const published = await client.callTool({
      name: "jev_guide",
      arguments: { topic: "examples" },
    });
    expect(
      JSON.parse((published.structuredContent as { text: string }).text),
    ).toEqual(examples);
    for (const example of examples) {
      const result = await client.callTool({
        name: example.tool,
        arguments: example.arguments,
      });
      expect(result.isError).not.toBe(true);
      const args = example.arguments;
      if (example.tool === "assess_batch") {
        const batch = result.structuredContent as {
          records: {
            id: string;
            status: string;
            result: { results: { id: string }[] };
          }[];
        };
        expect(batch.records.map((r) => r.id)).toEqual(
          args.records!.map((r) => r.id),
        );
        for (const record of batch.records) {
          expect(record.status).toBe("ok");
          expect(record.result.results.map((r) => r.id)).toEqual(
            args.checks!.map((r) => r.id),
          );
        }
        continue;
      }
      const expectedIds = [
        ...(args.items ?? []),
        ...(args.classifications ?? []),
        ...(args.scores ?? []),
        ...(args.checks ?? []),
      ]
        .map((i) => i.id)
        .sort();
      expect(
        (result.structuredContent as { results: { id: string }[] }).results
          .map((r) => r.id)
          .sort(),
      ).toEqual(expectedIds);
    }
    expect(calls).toBe(
      examples.reduce((sum, e) => sum + (e.arguments.records?.length ?? 1), 0),
    );
  } finally {
    await client.close();
    await server.close();
  }
});
