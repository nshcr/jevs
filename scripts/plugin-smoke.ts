import { serverEnvironmentKeys } from "../src/environment.ts";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pkg from "../package.json";
const root = resolve(process.argv[2] ?? "");
const manifest = await Bun.file(
  resolve(root, ".codex-plugin/plugin.json"),
).json();
const config = (await Bun.file(resolve(root, ".mcp.json")).json()).mcpServers
  .jevs;
if (
  manifest.name !== pkg.name ||
  manifest.version !== pkg.version ||
  manifest.mcpServers !== "./.mcp.json" ||
  manifest.skills !== "./skills/"
)
  throw Error("Plugin identity/component mismatch");
if (
  config.command !== "bun" ||
  config.cwd !== "." ||
  config.args.length !== 1 ||
  config.args[0] !== "dist/index.js"
)
  throw Error("Plugin launch contract mismatch");
if (
  config.env ||
  JSON.stringify(config.env_vars) !== JSON.stringify(serverEnvironmentKeys)
)
  throw Error("Plugin credential forwarding mismatch");
const skill = await Bun.file(resolve(root, "skills/jev-mcp/SKILL.md")).text();
if (!skill.startsWith("---\nname: jev-mcp\n"))
  throw Error("Missing caller skill");
const client = new Client({ name: "plugin-config-smoke", version: "1" });
try {
  await client.connect(
    new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: resolve(root, config.cwd),
      env: { TYPESAFE_API_KEY: "" },
      stderr: "pipe",
    }),
  );
  if (client.getServerVersion()?.version !== manifest.version)
    throw Error("Plugin/MCP version mismatch");
  if ((await client.listTools()).tools.length !== 7)
    throw Error("Missing plugin tools");
  if (
    (
      await client.callTool({
        name: "jev_guide",
        arguments: { topic: "overview" },
      })
    ).isError
  )
    throw Error("Guide unavailable");
  console.log(
    "Plugin config launch passed; Codex installation was not performed.",
  );
} finally {
  await client.close();
}
