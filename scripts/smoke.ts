import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
const client = new Client({ name: "jevs-bundle-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    process.argv[2]
      ? resolve(process.argv[2])
      : resolve(import.meta.dir, "../dist/index.js"),
  ],
  cwd: tmpdir(),
  env: { TYPESAFE_API_KEY: "" },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const pkg = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();
  if (client.getServerVersion()?.version !== pkg.version)
    throw Error("MCP version mismatch");
  const guide = await client.callTool({
    name: "jev_guide",
    arguments: { topic: "examples" },
  });
  const payload = guide.structuredContent as { text: string };
  if (guide.isError || JSON.parse(payload.text).length !== 5)
    throw Error("Bundled guide unavailable");
  const resources = (await client.listResources()).resources;
  if (resources.length !== 5) throw Error("Guide resources missing");
  for (const resource of resources)
    await client.readResource({ uri: resource.uri });
  const result = await client.callTool({
    name: "check",
    arguments: { content: null, items: [{ id: "q", question: null }] },
  });
  if (!result.isError || !JSON.stringify(result).includes("NOT_CONFIGURED"))
    throw Error("Missing key contract failed");
  console.log(
    "Bundled MCP smoke passed: offline discovery, examples, resources, configuration errors.",
  );
} finally {
  await client.close();
}

// Exercise bundled SDK networking against a local fixture, without real credentials.
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/systemone")
      return new Response("unexpected path", { status: 404 });
    const body = (await req.json()) as { questions: Record<string, unknown> };
    if (!Object.hasOwn(body.questions, "q"))
      return new Response("unexpected body", { status: 400 });
    return Response.json({
      model: "smoke-fixture",
      answers: { q: { type: "noul", noul: 0.7 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  },
});
const inference = new Client({ name: "jevs-package-inference", version: "1" });
try {
  await inference.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        process.argv[2]
          ? resolve(process.argv[2])
          : resolve(import.meta.dir, "../dist/index.js"),
      ],
      cwd: tmpdir(),
      env: { TYPESAFE_API_KEY: "mock", TYPESAFE_BASE_URL: api.url.origin },
      stderr: "pipe",
    }),
  );
  const result = await inference.callTool({
    name: "check",
    arguments: {
      content: "fixture",
      items: [{ id: "q", question: "Is this a fixture?" }],
    },
  });
  if (
    result.isError ||
    !JSON.stringify(result.structuredContent).includes('"probability":0.7')
  )
    throw Error("Bundled inference failed");
  const batch = await inference.callTool({
    name: "assess_batch",
    arguments: {
      records: [
        { id: "a", content: "fixture a" },
        { id: "b", content: "fixture b" },
      ],
      checks: [{ id: "q", question: "Is this a fixture?" }],
    },
  });
  const records = (batch.structuredContent as { records: { status: string }[] })
    .records;
  if (
    batch.isError ||
    records.length !== 2 ||
    records.some((r) => r.status !== "ok")
  )
    throw Error("Bundled batch failed");
  console.log(
    "Bundled SDK inference and batch smoke passed against local HTTP fixture.",
  );
} finally {
  await inference.close();
  api.stop(true);
}
