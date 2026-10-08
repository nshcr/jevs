#!/usr/bin/env bun
import { schedulerOptions } from "./scheduler.ts";
import { providerOptions } from "./config.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProvider } from "./provider.ts";
import { createServer } from "./server.ts";

try {
  const server = createServer(
    () => createProvider(providerOptions(process.env)),
    schedulerOptions(process.env),
  );
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
