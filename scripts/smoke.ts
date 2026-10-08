import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const bundle = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(import.meta.dir, "../dist/index.js");
async function connect(env: Record<string, string>) {
  const client = new Client({ name: "jevs-bundle-smoke", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--no-env-file", bundle],
      cwd: tmpdir(),
      env: {
        JEVS_PROVIDER: "typesafe",
        JEVS_ALLOW_UNVERIFIED_MODELS: "false",
        JEVS_PYTHON_EXECUTABLE: "",
        JEVS_PYTHON_MODEL_DIR: "",
        JEVS_API_KEY: "",
        JEVS_BASE_URL: "",
        JEVS_DEFAULT_MODEL: "",
        CLOUDFLARE_ACCOUNT_ID: "",
        CLOUDFLARE_AI_GATEWAY_ID: "",
        ...env,
      },
      stderr: "pipe",
    }),
  );
  return client;
}
const client = await connect({});
try {
  const pkg = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();
  if (client.getServerVersion()?.version !== pkg.version)
    throw Error("MCP version mismatch");
  if ((await client.listTools()).tools.length !== 8)
    throw Error("Missing decision tools");
  const guide = await client.callTool({
    name: "decision_guide",
    arguments: { topic: "examples" },
  });
  if (
    guide.isError ||
    JSON.parse((guide.structuredContent as { text: string }).text).length !== 5
  )
    throw Error("Bundled guide unavailable");
  const resources = (await client.listResources()).resources;
  if (resources.length !== 5) throw Error("Guide resources missing");
  for (const resource of resources)
    await client.readResource({ uri: resource.uri });
  const info = await client.callTool({ name: "provider_info", arguments: {} });
  if (
    info.isError ||
    (info.structuredContent as { provider?: string } | undefined)?.provider !==
      "typesafe"
  )
    throw Error("Offline provider description unavailable");
  const result = await client.callTool({
    name: "check",
    arguments: { content: null, items: [{ id: "q", question: null }] },
  });
  if (!result.isError || !JSON.stringify(result).includes("NOT_CONFIGURED"))
    throw Error("Missing key contract failed");
  console.log(
    "Bundled MCP smoke passed: offline discovery, provider description, examples, resources, configuration errors.",
  );
} finally {
  await client.close();
}

// Exercise both wire protocols without paid services or real credentials.
for (const kind of ["system-one", "cloudflare-workers"] as const) {
  const requests: {
    path: string;
    body: Record<string, unknown>;
    auth: string | null;
  }[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({ path, body, auth: req.headers.get("authorization") });
      if (
        path !==
        (kind === "system-one"
          ? "/v1/systemone"
          : "/client/v4/accounts/fixture/ai/run/@cf/cloudflare/clef-flash")
      )
        return new Response("Unexpected path", { status: 404 });
      if (!Object.hasOwn(body.questions as object, "q"))
        return new Response("Unexpected rubric", { status: 400 });
      const result = {
        model: "smoke-actual",
        answers: { q: { type: "noul", noul: 0.7 } },
        ...(kind === "cloudflare-workers"
          ? { usage: { input_tokens: 1, output_tokens: 1 } }
          : {}),
      };
      return Response.json(
        kind === "cloudflare-workers" ? { success: true, result } : result,
      );
    },
  });
  const inference = await connect({
    JEVS_PROVIDER: kind,
    JEVS_ALLOW_UNVERIFIED_MODELS: kind === "system-one" ? "true" : "false",
    JEVS_API_KEY: "mock",
    CLOUDFLARE_ACCOUNT_ID: kind === "cloudflare-workers" ? "fixture" : "",
    JEVS_BASE_URL:
      kind === "system-one"
        ? api.url.origin
        : `${api.url.origin}/client/v4/accounts/fixture/ai`,
    JEVS_DEFAULT_MODEL:
      kind === "system-one" ? "custom-decision" : "@cf/cloudflare/clef-flash",
  });
  try {
    const images = ["data:image/png;base64,YQ=="];
    const result = await inference.callTool({
      name: "check",
      arguments: {
        content: "fixture",
        ...(kind === "cloudflare-workers" ? { images } : {}),
        items: [{ id: "q", question: "Is this a fixture?" }],
      },
    });
    const output = result.structuredContent as Record<string, unknown>;
    if (
      result.isError ||
      output.provider !== kind ||
      output.model !== "smoke-actual" ||
      (kind === "system-one" && Object.hasOwn(output, "usage")) ||
      !JSON.stringify(output).includes('"probability":0.7')
    )
      throw Error(
        `${kind} bundled inference failed: ${JSON.stringify(result)}`,
      );
    if (
      requests[0]!.auth !== "Bearer mock" ||
      requests[0]!.body.model !==
        (kind === "system-one" ? "custom-decision" : "clef-flash")
    )
      throw Error("Bundled provider configuration failed");
    if (
      kind === "cloudflare-workers" &&
      JSON.stringify(requests[0]!.body.images) !== JSON.stringify(images)
    )
      throw Error("Bundled multimodal input lost");
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
    const records = (
      batch.structuredContent as { records: { status: string }[] }
    ).records;
    if (
      batch.isError ||
      records.length !== 2 ||
      records.some((r) => r.status !== "ok") ||
      requests.length !== 3
    )
      throw Error(`${kind} bundled batch failed`);
    console.log(
      `Bundled ${kind} inference and batch smoke passed against local HTTP fixture.`,
    );
  } finally {
    await inference.close();
    api.stop(true);
  }
}
