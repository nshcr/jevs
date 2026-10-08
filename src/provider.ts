import { z } from "zod";
import type {
  DecisionProvider,
  ProviderOptions,
  ProviderDescription,
  ModelCatalog,
  ProviderExtensions,
} from "./decision.ts";
import {
  ProviderConfigurationError,
  ProviderInputError,
  ResponseContractError,
  RequestCancelledError,
} from "./failures.ts";
import { createTransport } from "./providers/transport.ts";
import { capabilitiesSchema } from "./contracts.ts";
import { providerKinds } from "./decision.ts";
import {
  validateAssessment,
  validateModelAdmission,
  assessmentToolSupport,
} from "./capabilities.ts";
import { createClefPythonProvider } from "./providers/clef-python.ts";
import {
  createRegistry,
  adapterEndpoint,
  knownOpenaiDecisionModels,
} from "./providers/registry.ts";
function baseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderConfigurationError(
      "Set a valid absolute HTTP(S) provider base URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ProviderConfigurationError(
      "Use an HTTP(S) base URL without query, fragment or embedded credentials.",
    );
  return url.href.replace(/\/+$/, "");
}
export function createProvider(
  options: ProviderOptions,
  extensions: ProviderExtensions = {},
): DecisionProvider {
  const kind = options.kind;
  if (!providerKinds.includes(kind))
    throw new ProviderConfigurationError("Select a supported provider kind.");
  if (options.protocol !== undefined && kind !== "custom")
    throw new ProviderConfigurationError(
      "An explicit protocol is supported only by the custom provider.",
    );
  if (kind === "clef-python") return createClefPythonProvider(options);
  const registry = createRegistry(extensions);
  if (options.apiKey && /[\r\n]/.test(options.apiKey))
    throw new ProviderConfigurationError(
      "Provide an API credential without line breaks.",
    );
  const cf = kind.startsWith("cloudflare");
  if (
    cf &&
    ((!options.baseURL && !options.accountId) ||
      (options.accountId !== undefined &&
        !/^[a-zA-Z0-9_-]+$/.test(options.accountId)))
  )
    throw new ProviderConfigurationError("Cloudflare requires an account ID.");
  if (options.gatewayId && !/^[a-zA-Z0-9_-]+$/.test(options.gatewayId))
    throw new ProviderConfigurationError("Set a valid Cloudflare gateway ID.");
  if (
    (kind === "system-one" || kind === "custom") &&
    (!options.baseURL ||
      !options.defaultModel?.trim() ||
      (kind === "custom" && !options.protocol?.trim()))
  )
    throw new ProviderConfigurationError(
      "Custom providers require an explicit base URL, default model and protocol (System One selects its own protocol).",
    );
  const defaults = {
    openai: ["https://api.openai.com", "gpt-6-luna"],
    typesafe: ["https://api.typesafe.ai", "jev-latest"],
    "system-one": [options.baseURL ?? "", options.defaultModel ?? ""],
    custom: [options.baseURL ?? "", options.defaultModel ?? ""],
    openrouter: ["https://openrouter.ai/api", "typesafe/jev-1.13"],
    "cloudflare-workers": [
      `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai`,
      "@cf/cloudflare/clef",
    ],
    "cloudflare-gateway": [
      `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai`,
      "typesafe/jev",
    ],
    vercel: ["https://ai-gateway.vercel.sh/typesafe", "typesafe-ai/jev"],
    zen: ["https://opencode.ai/zen", "jev-1.13"],
  } as const;
  const base = baseUrl(options.baseURL ?? defaults[kind][0]);
  const defaultModel = options.defaultModel?.trim() || defaults[kind][1];
  const clefModel = (model: string): string => {
    const value = model.replace(/^@cf\/cloudflare\//, "");
    if (value !== "clef" && value !== "clef-flash")
      throw new ProviderInputError(
        "Workers AI supports only the configured Clef and Clef Flash models.",
      );
    return value;
  };
  if (kind === "cloudflare-workers") {
    try {
      clefModel(defaultModel);
    } catch {
      throw new ProviderConfigurationError(
        "Configure a supported Clef or Clef Flash default model.",
      );
    }
  }
  const protocol =
    kind === "custom"
      ? options.protocol!
      : kind === "openai"
        ? "openai-decisions"
        : kind === "openrouter"
          ? "openrouter-decisions"
          : kind === "cloudflare-workers"
            ? "cloudflare-clef"
            : kind === "cloudflare-gateway"
              ? "cloudflare-gateway-system-one"
              : "system-one";
  if (!registry.adapters.has(protocol))
    throw new ProviderConfigurationError(
      "Select a registered decision protocol.",
    );
  const canonicalDefault =
    kind === "cloudflare-workers"
      ? `@cf/cloudflare/${clefModel(defaultModel)}`
      : defaultModel;
  function resolve(selected = canonicalDefault): ProviderDescription {
    const value = selected.trim();
    if (!value) throw new ProviderInputError("Provide a non-empty model ID.");
    const model =
      kind === "cloudflare-workers"
        ? `@cf/cloudflare/${clefModel(value)}`
        : value;
    const entry = registry.profiles.get(`${kind}\0${model}`);
    const selectedProtocol = entry?.profile.protocol ?? protocol;
    const adapter = registry.adapters.get(selectedProtocol)!;
    const capabilities =
      entry?.profile.capabilities ??
      adapter.capabilities({ provider: kind, model });
    if (!capabilitiesSchema.safeParse(capabilities).success)
      throw new ProviderConfigurationError(
        "The selected adapter must describe valid capabilities.",
      );
    const availability = entry?.profile.availability ?? "unverified";
    return structuredClone({
      provider: kind,
      protocol: selectedProtocol,
      defaultModel: canonicalDefault,
      model,
      availability,
      unverifiedModelsAllowed: options.allowUnverifiedModels === true,
      toolSupport: assessmentToolSupport(capabilities, availability),
      capabilitySource: entry
        ? entry.configured
          ? "configuration"
          : "model"
        : kind === "custom" || kind === "system-one"
          ? "configuration"
          : "protocol",
      capabilities,
      ...(entry?.profile.reason !== undefined
        ? { reason: entry.profile.reason }
        : availability === "unverified"
          ? {
              reason:
                "The protocol baseline is known, but this model's decision support is not verified. Explicitly allow an unverified model to attempt it.",
            }
          : {}),
    });
  }
  const description = resolve();
  const transport = createTransport(options);
  function requireCredentials() {
    if (kind !== "system-one" && kind !== "custom" && !options.apiKey?.trim())
      throw new ProviderConfigurationError(
        "Configure this provider's API credential before making requests.",
      );
  }
  const modelCard = (id: string, description?: string) => {
    const info = resolve(id);
    return {
      id: info.model,
      ...(description !== undefined ? { description } : {}),
      protocol: info.protocol,
      availability: info.availability,
      capabilitySource: info.capabilitySource,
      capabilities: info.capabilities,
      ...(info.reason !== undefined ? { reason: info.reason } : {}),
    };
  };
  return {
    describe: resolve,
    async evaluate(input, signal) {
      if (signal.aborted) throw new RequestCancelledError("Request cancelled.");
      const info = resolve(input.model);
      validateModelAdmission(input, info);
      validateAssessment(input, info.capabilities);
      const adapter = registry.adapters.get(info.protocol)!;
      const prepared = adapter.prepare(input, {
        provider: kind,
        model: info.model,
      });
      const endpoint = adapterEndpoint(base, prepared.path);
      requireCredentials();
      const raw = await transport(endpoint, signal, prepared.body);
      return prepared.decode(raw);
    },
    async listModels(signal): Promise<ModelCatalog> {
      if (signal.aborted) throw new RequestCancelledError("Request cancelled.");
      if (kind === "system-one" || kind === "custom" || cf)
        return {
          ...structuredClone(description),
          source: "configured",
          complete: false,
          models:
            kind === "cloudflare-workers"
              ? [
                  modelCard("@cf/cloudflare/clef"),
                  modelCard("@cf/cloudflare/clef-flash"),
                ]
              : [
                  ...new Set([
                    canonicalDefault,
                    ...[...registry.profiles.values()]
                      .filter((entry) => entry.profile.provider === kind)
                      .map((entry) => entry.profile.model),
                  ]),
                ].map((id) => modelCard(id)),
        };
      requireCredentials();
      const raw = await transport(
        kind === "openrouter"
          ? `${base}/v1/models?output_modalities=decisions`
          : `${base}/v1/models`,
        signal,
      );
      const fail = (): never => {
        throw new ResponseContractError(
          "Model service returned an invalid catalog.",
        );
      };
      let models: ModelCatalog["models"];
      if (kind === "openai") {
        const parsed = z
          .object({
            object: z.literal("list"),
            data: z.array(z.object({ id: z.string().min(1) })),
          })
          .safeParse(raw);
        if (!parsed.success) return fail();
        if (
          new Set(parsed.data.data.map((m) => m.id)).size !==
          parsed.data.data.length
        )
          return fail();
        models = parsed.data.data
          .filter((m) =>
            (knownOpenaiDecisionModels as readonly string[]).includes(m.id),
          )
          .map((m) => ({
            ...modelCard(m.id),
            reason:
              "This model is returned by the account model list; that does not prove Decisions endpoint access.",
          }));
        return {
          ...structuredClone(description),
          source: "remote",
          complete: false,
          models,
          reason: models.some((m) => m.id === canonicalDefault)
            ? "The default model is listed for this account; that does not prove Decisions endpoint access. Only documented Decisions model IDs are recognized."
            : "The configured default model was not returned among recognized Decisions models in the account model list. Static protocol support does not establish account access.",
        };
      } else if (kind === "openrouter") {
        const schema = z.object({
          data: z.array(
            z.object({
              id: z.string().min(1),
              description: z.string().optional(),
              architecture: z.object({
                output_modalities: z.array(z.string()),
              }),
            }),
          ),
        });
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return fail();
        models = parsed.data.data
          .filter((m) => m.architecture.output_modalities.includes("decisions"))
          .map((m) => modelCard(m.id, m.description));
      } else if (kind === "zen") {
        const parsed = z
          .object({
            object: z.literal("list"),
            data: z.array(
              z.object({
                id: z.string().min(1),
                description: z.string().optional(),
              }),
            ),
          })
          .safeParse(raw);
        if (!parsed.success) return fail();
        models = parsed.data.data
          .filter((m) => m.id.startsWith("jev-"))
          .map((m) => modelCard(m.id, m.description));
      } else {
        const parsed = z
          .object({
            models: z.array(
              z.object({
                name: z.string().min(1),
                description: z.string().optional(),
              }),
            ),
          })
          .safeParse(raw);
        if (!parsed.success) return fail();
        models = parsed.data.models.map((m) =>
          modelCard(m.name, m.description),
        );
      }
      if (new Set(models.map((m) => m.id)).size !== models.length)
        return fail();
      return {
        ...structuredClone(description),
        source: "remote",
        complete: true,
        models,
      };
    },
  };
}
