#!/usr/bin/env bun
import { schedulerOptions } from "./scheduler.ts";
import { ConfigurationError } from "./errors.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { providerFetch, providerDefaultModel } from "./provider.ts";
import { createServer } from "./server.ts";

try {
  let client: TypeSafeClient | undefined;
  const server = createServer(() => {
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new ConfigurationError();
    const defaultModel = providerDefaultModel(process.env.TYPESAFE_BASE_URL);
    return (client ??= new TypeSafeClient({
      defaultModel: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || defaultModel,
      logLevel: "off",
      fetch: providerFetch(undefined, {
        cloudflareGatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID,
      }),
      timeout: 30_000,
    }));
  }, schedulerOptions(process.env));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close().finally(() => process.exit(0));
    });
  }
  await server.connect(new StdioServerTransport());
} catch {
  console.error(
    "jevs failed to start. Check model service credentials, endpoint and JEVS scheduler configuration.",
  );
  process.exitCode = 1;
}
