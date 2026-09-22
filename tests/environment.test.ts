import { expect, test } from "bun:test";
import {
  serverEnvironment,
  serverEnvironmentKeys,
} from "../src/environment.ts";
import config from "../packaging/codex/mcp.json";
import { providerDefaultModel } from "../src/provider.ts";
import { errorDetails } from "../src/errors.ts";

test("local MCP clients forward the plugin settings without unrelated secrets", async () => {
  const source = Object.fromEntries(
    serverEnvironmentKeys.map((key) => [key, `fixture-${key}`]),
  );
  const env = serverEnvironment({
    ...source,
    UNRELATED_SECRET: "private",
    TYPESAFE_DEFAULT_MODEL: "",
  });
  expect(config.mcpServers.jevs.env_vars).toEqual([...serverEnvironmentKeys]);
  expect(env.TYPESAFE_DEFAULT_MODEL).toBe("");
  expect(env.CLOUDFLARE_AI_GATEWAY_ID).toBe(source.CLOUDFLARE_AI_GATEWAY_ID);
  expect(env).not.toHaveProperty("UNRELATED_SECRET");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      "process.stdout.write(JSON.stringify([process.env.CLOUDFLARE_AI_GATEWAY_ID, process.env.TYPESAFE_API_KEY]))",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual([
    source.CLOUDFLARE_AI_GATEWAY_ID,
    source.TYPESAFE_API_KEY,
  ]);
});

test("endpoint configuration errors cannot be mistaken for invalid tool content", () => {
  try {
    providerDefaultModel("https://ai-gateway.vercel.sh/v1");
    throw Error("Expected configuration rejection");
  } catch (error) {
    expect(errorDetails(error)).toMatchObject({
      code: "NOT_CONFIGURED",
      retry: "never",
    });
    expect(errorDetails(error).action).toContain("TYPESAFE_BASE_URL");
  }
  expect(providerDefaultModel("https://opencode.ai/zen//")).toBe("jev-1.13");
});
