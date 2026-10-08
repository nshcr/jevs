import { expect, test } from "bun:test";
import { createProvider } from "../src/provider.ts";
import { ResponseContractError } from "../src/failures.ts";
const signal = () => new AbortController().signal;
test("only exact verified model profiles declare support and remote discovery does not promote unknown IDs", async () => {
  const profiles = [
    ["typesafe", ["jev-latest", "jev-1.13.0"]],
    ["zen", ["jev-1.13", "jev-1.13-free"]],
    ["vercel", ["typesafe-ai/jev"]],
    ["cloudflare-gateway", ["typesafe/jev"]],
    [
      "cloudflare-workers",
      ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"],
    ],
    [
      "openrouter",
      [
        "typesafe/jev-1.13",
        "cloudflare/clef",
        "cloudflare/clef-flash",
        "liquid/d1",
      ],
    ],
  ] as const;
  for (const [kind, models] of profiles) {
    const provider = createProvider({ kind, accountId: "fixture" });
    for (const model of models)
      expect(provider.describe(model)).toMatchObject({
        availability: "supported",
        capabilitySource: "model",
      });
    if (kind !== "cloudflare-workers")
      expect(
        provider.describe(
          kind === "openrouter" ? "cloudflare/clef-999" : "jev-999.1",
        ).availability,
      ).toBe("unverified");
  }
  for (const kind of ["typesafe", "zen", "openrouter"] as const) {
    const id = kind === "openrouter" ? "typesafe/jev-999.1" : "jev-999.1";
    const provider = createProvider({
      kind,
      apiKey: "fixture",
      fetch: async () =>
        Response.json(
          kind === "typesafe"
            ? { models: [{ name: id }] }
            : kind === "zen"
              ? { object: "list", data: [{ id }] }
              : {
                  data: [
                    { id, architecture: { output_modalities: ["decisions"] } },
                  ],
                },
        ),
    });
    expect((await provider.listModels(signal())).models[0]).toMatchObject({
      id,
      availability: "unverified",
      capabilitySource: "protocol",
    });
  }
  expect(
    createProvider({ kind: "typesafe" }).describe("jev-1.13").availability,
  ).toBe("unverified");
});
test("OpenAI discovery intersects documented Decisions models with the authenticated model list", async () => {
  for (const listed of [
    ["gpt-6-luna", "gpt-4.1", "future-decider"],
    ["gpt-4.1"],
  ]) {
    const provider = createProvider({
      kind: "openai",
      apiKey: "fixture",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/models");
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture",
        );
        return Response.json({
          object: "list",
          data: listed.map((id) => ({
            id,
            object: "model",
            created: 1,
            owned_by: "openai",
          })),
        });
      },
    });
    expect(provider.describe()).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      protocol: "openai-decisions",
      availability: "supported",
      capabilitySource: "model",
    });
    expect(provider.describe("gpt-4.1")).toMatchObject({
      availability: "unverified",
      capabilitySource: "protocol",
    });
    const catalog = await provider.listModels(signal());
    expect(catalog.source).toBe("remote");
    expect(catalog.complete).toBe(false);
    expect(catalog.models.map((model) => model.id)).toEqual(
      listed.includes("gpt-6-luna") ? ["gpt-6-luna"] : [],
    );
    expect(catalog.reason).toContain(
      listed.includes("gpt-6-luna") ? "does not prove" : "not returned",
    );
    for (const card of catalog.models)
      expect(card).toMatchObject({
        capabilitySource: "model",
        availability: "supported",
        protocol: "openai-decisions",
      });
  }
});
test("OpenAI discovery does not accept malformed or duplicate model catalogs", async () => {
  for (const raw of [
    {},
    { object: "list", data: [{ id: 12 }] },
    { object: "list", data: [{ id: "gpt-6-luna" }, { id: "gpt-6-luna" }] },
  ]) {
    const provider = createProvider({
      kind: "openai",
      apiKey: "fixture",
      fetch: async () => Response.json(raw),
    });
    await expect(provider.listModels(signal())).rejects.toBeInstanceOf(
      ResponseContractError,
    );
  }
});
test("OpenRouter discovers decisions models and resolves model-specific protocols and limits", async () => {
  const provider = createProvider({
    kind: "openrouter",
    apiKey: "fixture",
    fetch: async (url) => {
      expect(String(url)).toBe(
        "https://openrouter.ai/api/v1/models?output_modalities=decisions",
      );
      return Response.json({
        data: [
          {
            id: "typesafe/jev-1.13",
            architecture: { output_modalities: ["decisions"] },
          },
          {
            id: "cloudflare/clef",
            architecture: { output_modalities: ["decisions"] },
          },
          {
            id: "perplexity/pplx-decider-v1-27b",
            architecture: { output_modalities: ["decisions"] },
          },
          {
            id: "liquid/d1",
            architecture: { output_modalities: ["decisions"] },
          },
          {
            id: "future/decision",
            architecture: { output_modalities: ["decisions"] },
          },
          {
            id: "togethercomputer/tev1-4b-experimental",
            architecture: { output_modalities: ["decisions"] },
          },
          { id: "other/chat", architecture: { output_modalities: ["text"] } },
        ],
      });
    },
  });
  const catalog = await provider.listModels(signal());
  expect(catalog.source).toBe("remote");
  expect(catalog.models.map((m) => m.id)).toEqual([
    "typesafe/jev-1.13",
    "cloudflare/clef",
    "perplexity/pplx-decider-v1-27b",
    "liquid/d1",
    "future/decision",
    "togethercomputer/tev1-4b-experimental",
  ]);
  expect(catalog.models.at(-1)).toMatchObject({
    availability: "supported",
    protocol: "tev1-chat",
    capabilitySource: "model",
    capabilities: {
      maxQuestions: 1,
      maxOptions: 24,
      confidence: "unavailable",
    },
  });
  expect(
    catalog.models.find((m) => m.id === "perplexity/pplx-decider-v1-27b")
      ?.capabilities?.maxQuestions,
  ).toBe(128);
  expect(
    catalog.models.find((m) => m.id === "cloudflare/clef")?.capabilities
      ?.inputs,
  ).not.toContain("image");
  expect(
    catalog.models.find((m) => m.id === "future/decision")?.availability,
  ).toBe("unverified");
});
test("configured model catalogs are explicit about incompleteness and perform no request", async () => {
  for (const kind of [
    "system-one",
    "cloudflare-workers",
    "cloudflare-gateway",
  ] as const) {
    const provider = createProvider({
      kind,
      accountId: "fixture",
      ...(kind === "system-one"
        ? { baseURL: "http://localhost:8787", defaultModel: "custom" }
        : {}),
      fetch: async () => {
        throw Error("No request expected");
      },
    });
    const catalog = await provider.listModels(signal());
    expect(catalog.source).toBe("configured");
    expect(catalog.complete).toBe(false);
    expect(catalog.models.map((m) => m.id)).toEqual(
      kind === "cloudflare-workers"
        ? ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"]
        : [provider.describe().defaultModel],
    );
  }
});
test("native and Zen catalog protocols preserve descriptions without inventing release dates", async () => {
  for (const kind of ["typesafe", "vercel", "zen"] as const) {
    const provider = createProvider({
      kind,
      apiKey: "fixture",
      fetch: async () =>
        Response.json(
          kind === "zen"
            ? {
                object: "list",
                data: [
                  { id: "jev-fixture", description: "Fixture", created: 123 },
                  { id: "chat-model" },
                ],
              }
            : {
                models: [
                  {
                    name: "jev-fixture",
                    description: "Fixture",
                    release_date: "unknown",
                  },
                ],
              },
        ),
    });
    expect((await provider.listModels(signal())).models).toEqual([
      {
        id: "jev-fixture",
        description: "Fixture",
        protocol: "system-one",
        availability: "unverified",
        capabilitySource: "protocol",
        capabilities: provider.describe().capabilities,
        reason: provider.describe("jev-fixture").reason,
      },
    ]);
  }
});
test("supplier identity does not certify an arbitrary model as a decision model", async () => {
  for (const kind of [
    "typesafe",
    "vercel",
    "zen",
    "cloudflare-gateway",
  ] as const) {
    const provider = createProvider({
      kind,
      accountId: "fixture",
      apiKey: "fixture",
      fetch: async () => {
        return Response.json(
          kind === "zen"
            ? {
                object: "list",
                data: [{ id: "jev-fixture" }, { id: "jev-1.13" }],
              }
            : {
                models: [
                  { name: "gpt-4.1" },
                  { name: provider.describe().defaultModel },
                ],
              },
        );
      },
    });
    expect(provider.describe().availability).toBe("supported");
    expect(provider.describe("gpt-4.1")).toMatchObject({
      availability: "unverified",
      capabilitySource: "protocol",
    });
    const catalog = await provider.listModels(signal());
    for (const card of catalog.models)
      expect(card).toMatchObject({
        availability: provider.describe(card.id).availability,
        capabilitySource: provider.describe(card.id).capabilitySource,
      });
    expect(
      catalog.models.find(
        (card) => card.id === provider.describe().defaultModel,
      )?.availability,
    ).toBe("supported");
    const unknown = kind === "zen" ? "jev-fixture" : "gpt-4.1";
    if (kind !== "cloudflare-gateway")
      expect(
        catalog.models.find((card) => card.id === unknown)?.availability,
      ).toBe("unverified");
    const arbitraryDefault = createProvider({
      kind,
      accountId: "fixture",
      defaultModel: "gpt-4.1",
    });
    expect(arbitraryDefault.describe().availability).toBe("unverified");
  }
});
test("malformed successful catalogs are sanitized response contract failures", async () => {
  for (const body of ["PRIVATE", "null", "{}", '{"models":[{"name":12}]}']) {
    const provider = createProvider({
      kind: "typesafe",
      apiKey: "fixture",
      fetch: async () => new Response(body),
    });
    await expect(provider.listModels(signal())).rejects.toBeInstanceOf(
      ResponseContractError,
    );
  }
});
