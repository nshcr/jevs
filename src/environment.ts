// Server settings forwarded by the plugin and local MCP clients.
export const serverEnvironmentKeys = [
  "TYPESAFE_API_KEY",
  "TYPESAFE_DEFAULT_MODEL",
  "TYPESAFE_BASE_URL",
  "CLOUDFLARE_AI_GATEWAY_ID",
  "JEVS_MAX_CONCURRENCY",
  "JEVS_MAX_QUEUE",
  "JEVS_QUEUE_TIMEOUT_MS",
] as const;

export function serverEnvironment(env: Record<string, string | undefined>) {
  return Object.fromEntries(
    serverEnvironmentKeys.flatMap((key) =>
      env[key] === undefined ? [] : [[key, env[key]]],
    ),
  ) as Record<string, string>;
}
