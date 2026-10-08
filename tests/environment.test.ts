import { expect, test } from "bun:test";
import {
  serverEnvironment,
  serverEnvironmentKeys,
} from "../src/environment.ts";
import config from "../packaging/codex/mcp.json";
import { providerOptions } from "../src/config.ts";
import { errorDetails } from "../src/errors.ts";

test("local MCP clients forward the plugin settings without unrelated secrets", async () => {
  const source = Object.fromEntries(
    serverEnvironmentKeys.map((key) => [key, `fixture-${key}`]),
  );
  const env = serverEnvironment({
    ...source,
    UNRELATED_SECRET: "private",
    JEVS_DEFAULT_MODEL: "",
  });
  expect(config.mcpServers.jevs.env_vars).toEqual([...serverEnvironmentKeys]);
  expect(env.JEVS_DEFAULT_MODEL).toBe("");
  expect(env.CLOUDFLARE_AI_GATEWAY_ID).toBe(source.CLOUDFLARE_AI_GATEWAY_ID);
  expect(env).not.toHaveProperty("UNRELATED_SECRET");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      "process.stdout.write(JSON.stringify([process.env.CLOUDFLARE_AI_GATEWAY_ID, process.env.JEVS_API_KEY]))",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual([
    source.CLOUDFLARE_AI_GATEWAY_ID,
    source.JEVS_API_KEY,
  ]);
});

test("configuration selects provider protocols explicitly including native OpenAI Decisions", () => {
  expect(providerOptions({})).toMatchObject({
    kind: "typesafe",
    timeoutMs: 30000,
  });
  expect(
    providerOptions({
      JEVS_PROVIDER: "openai",
      JEVS_API_KEY: "fixture-openai-key",
    }),
  ).toMatchObject({ kind: "openai", apiKey: "fixture-openai-key" });
  expect(
    providerOptions({
      JEVS_PROVIDER: "cloudflare-workers",
      CLOUDFLARE_ACCOUNT_ID: "fixture",
    }),
  ).toMatchObject({ kind: "cloudflare-workers", accountId: "fixture" });
  expect(
    providerOptions({
      JEVS_PROVIDER: "custom",
      JEVS_PROTOCOL: "tev1-chat",
      JEVS_BASE_URL: "http://localhost:8080",
      JEVS_DEFAULT_MODEL: "local/tev1",
    }),
  ).toMatchObject({
    kind: "custom",
    protocol: "tev1-chat",
    baseURL: "http://localhost:8080",
    defaultModel: "local/tev1",
  });
  for (const env of [
    { JEVS_PROVIDER: "unknown" },
    { JEVS_PROVIDER: "openai-decisions" },
    { JEVS_REQUEST_TIMEOUT_MS: "NaN" },
    { JEVS_REQUEST_TIMEOUT_MS: "0" },
  ]) {
    try {
      providerOptions(env);
      throw Error("Expected configuration rejection");
    } catch (error) {
      expect(errorDetails(error)).toMatchObject({
        code: "NOT_CONFIGURED",
        retry: "never",
      });
    }
  }
  expect(
    providerOptions({ TYPESAFE_API_KEY: "obsolete-secret" }).apiKey,
  ).toBeUndefined();
});

test("model admission is explicit and local Python configuration is forwarded", () => {
  expect(providerOptions({}).allowUnverifiedModels).toBe(false);
  expect(
    providerOptions({ JEVS_ALLOW_UNVERIFIED_MODELS: "true" })
      .allowUnverifiedModels,
  ).toBe(true);
  for (const value of ["yes", "1", "TRUE"])
    expect(() =>
      providerOptions({ JEVS_ALLOW_UNVERIFIED_MODELS: value }),
    ).toThrow();
  expect(
    providerOptions({
      JEVS_PROVIDER: "clef-python",
      JEVS_PYTHON_EXECUTABLE: "python3",
      JEVS_PYTHON_MODEL_DIR: "trusted-release",
    }),
  ).toMatchObject({
    kind: "clef-python",
    pythonExecutable: "python3",
    pythonModelDir: "trusted-release",
  });
});
