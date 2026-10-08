// Server settings forwarded by the plugin and local MCP clients.
export const serverEnvironmentKeys = [
  "JEVS_PROVIDER",
  "JEVS_ALLOW_UNVERIFIED_MODELS",
  "JEVS_PYTHON_EXECUTABLE",
  "JEVS_PYTHON_MODEL_DIR",
  "JEVS_PROTOCOL",
  "JEVS_API_KEY",
  "JEVS_DEFAULT_MODEL",
  "JEVS_BASE_URL",
  "JEVS_REQUEST_TIMEOUT_MS",
  "CLOUDFLARE_ACCOUNT_ID",
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
