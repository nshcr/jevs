import { capabilitiesSchema } from "../contracts.ts";
import { providerKinds } from "../decision.ts";
import type {
  DecisionAdapter,
  ModelProfile,
  ProviderExtensions,
} from "../decision.ts";
import { ProviderConfigurationError } from "../failures.ts";
import { builtinAdapters, textCapabilities } from "./adapters.ts";

// This is protocol support verified from the official Decisions guide, not
// an account availability assertion or a list of all OpenAI model families.
export const knownOpenaiDecisionModels = ["gpt-6-luna"] as const;
// Exact model IDs and aliases used by the documented provider integrations.
// A family-shaped model name never establishes support for future releases.
const documentedNativeModels = [
  ["typesafe", "system-one", ["jev-latest", "jev-1.13.0"]],
  ["zen", "system-one", ["jev-1.13", "jev-1.13-free"]],
  ["vercel", "system-one", ["typesafe-ai/jev"]],
  ["cloudflare-gateway", "cloudflare-gateway-system-one", ["typesafe/jev"]],
  [
    "cloudflare-workers",
    "cloudflare-clef",
    ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"],
  ],
  [
    "openrouter",
    "openrouter-decisions",
    [
      "typesafe/jev-1.13",
      "cloudflare/clef",
      "cloudflare/clef-flash",
      "liquid/d1",
    ],
  ],
] as const;
const builtinProfiles: readonly ModelProfile[] = [
  ...documentedNativeModels.flatMap(([provider, protocol, models]) =>
    models.map((model) => ({
      provider,
      protocol,
      model,
      availability: "supported" as const,
    })),
  ),
  ...knownOpenaiDecisionModels.map((model) => ({
    provider: "openai" as const,
    model,
    protocol: "openai-decisions",
    availability: "supported" as const,
    reason:
      "Official Decisions protocol support; account access is not established by this static model profile.",
  })),
  {
    provider: "openrouter",
    model: "togethercomputer/tev1-4b-experimental",
    protocol: "tev1-chat",
    availability: "supported",
  },
  {
    provider: "openrouter",
    model: "perplexity/pplx-decider-v1-27b",
    protocol: "openrouter-decisions",
    capabilities: { ...textCapabilities, maxQuestions: 128 },
    availability: "supported",
  },
];
export function createRegistry(extensions: ProviderExtensions) {
  const adapters = new Map<string, DecisionAdapter>();
  for (const adapter of [...builtinAdapters, ...(extensions.adapters ?? [])]) {
    if (
      !adapter.id.trim() ||
      adapters.has(adapter.id) ||
      typeof adapter.capabilities !== "function" ||
      typeof adapter.prepare !== "function"
    )
      throw new ProviderConfigurationError(
        "Register each non-empty protocol ID exactly once with capabilities and preparation functions.",
      );
    adapters.set(adapter.id, adapter);
  }
  const profiles = new Map<
    string,
    { profile: ModelProfile; configured: boolean }
  >();
  for (const [entries, configured] of [
    [builtinProfiles, false],
    [extensions.models ?? [], true],
  ] as const) {
    for (const original of entries) {
      const profile = structuredClone(original);
      const key = `${profile.provider}\0${profile.model}`;
      if (
        !providerKinds.includes(profile.provider) ||
        !profile.model.trim() ||
        profile.model !== profile.model.trim() ||
        profiles.has(key)
      )
        throw new ProviderConfigurationError(
          "Register each provider and non-empty model ID exactly once.",
        );
      if (!adapters.has(profile.protocol))
        throw new ProviderConfigurationError(
          "Model profiles must select a registered protocol.",
        );
      if (
        profile.capabilities &&
        !capabilitiesSchema.safeParse(profile.capabilities).success
      )
        throw new ProviderConfigurationError(
          "Model profiles must provide valid capabilities.",
        );
      if (
        profile.availability !== undefined &&
        !["supported", "unverified", "unsupported"].includes(
          profile.availability,
        )
      )
        throw new ProviderConfigurationError(
          "Model profiles must provide valid availability.",
        );
      profiles.set(key, { profile, configured });
    }
  }
  return { adapters, profiles };
}

export function adapterEndpoint(base: string, path: string): string {
  // Paths append to the configured API prefix. URL resolution from the origin
  // would discard prefixes such as /api or /accounts/<id>/ai.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new ProviderConfigurationError(
      "Adapters must provide a valid encoded request path.",
    );
  }
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\?#\s\u0000-\u001f]/.test(path) ||
    /[\\?#\s\u0000-\u001f]/.test(decoded) ||
    /%2f|%5c|%25/i.test(path) ||
    decoded.split("/").some((part) => part === "." || part === "..")
  )
    throw new ProviderConfigurationError(
      "Adapters must use an absolute path within the configured API prefix, without query, fragment or traversal.",
    );
  return `${base}${path}`;
}
