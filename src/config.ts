import {
  providerKinds,
  type ProviderKind,
  type ProviderOptions,
} from "./decision.ts";
import { ProviderConfigurationError } from "./failures.ts";

export function providerOptions(
  env: Record<string, string | undefined>,
): ProviderOptions {
  const read = (key: string) => env[key]?.trim() || undefined;
  const kind = read("JEVS_PROVIDER") ?? "typesafe";
  if (!providerKinds.includes(kind as ProviderKind))
    throw new ProviderConfigurationError(
      "Set JEVS_PROVIDER to openai, typesafe, system-one, openrouter, cloudflare-workers, cloudflare-gateway, vercel, zen, clef-python or custom.",
    );
  const timeoutMs = Number(read("JEVS_REQUEST_TIMEOUT_MS") ?? 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new ProviderConfigurationError(
      "Set JEVS_REQUEST_TIMEOUT_MS to an integer from 1 to 300000.",
    );
  const allowUnverified = read("JEVS_ALLOW_UNVERIFIED_MODELS") ?? "false";
  if (allowUnverified !== "true" && allowUnverified !== "false")
    throw new ProviderConfigurationError(
      "Set JEVS_ALLOW_UNVERIFIED_MODELS to true or false.",
    );
  return {
    kind: kind as ProviderKind,
    protocol: read("JEVS_PROTOCOL"),
    apiKey: read("JEVS_API_KEY"),
    baseURL: read("JEVS_BASE_URL"),
    defaultModel: read("JEVS_DEFAULT_MODEL"),
    accountId: read("CLOUDFLARE_ACCOUNT_ID"),
    gatewayId: read("CLOUDFLARE_AI_GATEWAY_ID"),
    timeoutMs,
    allowUnverifiedModels: allowUnverified === "true",
    pythonExecutable: read("JEVS_PYTHON_EXECUTABLE"),
    pythonModelDir: read("JEVS_PYTHON_MODEL_DIR"),
  };
}
