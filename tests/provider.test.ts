import { expect, test } from "bun:test";
import { createProvider } from "../src/provider.ts";
import {
  ProviderInputError,
  ProviderHttpError,
  RequestCancelledError,
  RequestTimeoutError,
  ProviderConfigurationError,
} from "../src/failures.ts";
import type { DecisionAdapter, ProviderKind } from "../src/decision.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const input = {
  content: { evidence: [null, "ready"] },
  checks: [{ id: "q", question: "Ready?" }],
};
const response = {
  model: "actual-version",
  answers: { q: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};
const signal = () => new AbortController().signal;
test("Clef Python factory selects the local runtime before HTTP configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jevs-factory-clef-"));
  try {
    writeFileSync(
      join(dir, "joint_schema_model.py"),
      "# construction fixture; never imported\n",
    );
    let calls = 0;
    const provider = createProvider({
      kind: "clef-python",
      pythonModelDir: dir,
      pythonExecutable: "/nonexistent/python",
      baseURL: "not-an-http-url",
      apiKey: "fixture\nnot-http",
      fetch: async () => {
        calls++;
        throw Error("No HTTP expected");
      },
    });
    expect(provider.describe()).toMatchObject({
      provider: "clef-python",
      protocol: "clef-python",
      capabilities: { inputs: ["text", "json", "image", "video"] },
    });
    expect((await provider.listModels(signal())).source).toBe("configured");
    expect(calls).toBe(0);
    await provider.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unknown model admission is explicit, performs no HTTP by default and cannot bypass unsupported profiles", async () => {
  for (const kind of [
    "typesafe",
    "zen",
    "vercel",
    "cloudflare-gateway",
    "openrouter",
    "system-one",
    "custom",
  ] as const) {
    let calls = 0;
    const options = {
      kind,
      apiKey: "fixture",
      accountId: "fixture",
      ...(kind === "system-one" || kind === "custom"
        ? {
            baseURL: "http://localhost:8787",
            defaultModel: "local-fixture",
            ...(kind === "custom" ? { protocol: "system-one" } : {}),
          }
        : {}),
      fetch: async () => {
        calls++;
        return Response.json(response);
      },
    };
    const provider = createProvider(options);
    const model =
      kind === "openrouter"
        ? "typesafe/jev-999.1"
        : kind === "system-one" || kind === "custom"
          ? "local-fixture"
          : "jev-999.1";
    expect(provider.describe(model)).toMatchObject({
      availability: "unverified",
      unverifiedModelsAllowed: false,
      toolSupport: { check: "unverified" },
    });
    expect(provider.describe(model).reason).toContain("not verified");
    await expect(
      provider.evaluate({ ...input, model }, signal()),
    ).rejects.toBeInstanceOf(ProviderInputError);
    expect(calls).toBe(0);
    await provider.evaluate(
      { ...input, model, allowUnverifiedModel: true },
      signal(),
    );
    expect(calls).toBe(1);
    const hostAllowed = createProvider({
      ...options,
      allowUnverifiedModels: true,
    });
    expect(hostAllowed.describe(model).unverifiedModelsAllowed).toBe(true);
    await hostAllowed.evaluate({ ...input, model }, signal());
    expect(calls).toBe(2);
  }
  let calls = 0;
  const blocked = createProvider(
    {
      kind: "system-one",
      baseURL: "http://localhost:8787",
      defaultModel: "blocked",
      allowUnverifiedModels: true,
      fetch: async () => {
        calls++;
        return Response.json(response);
      },
    },
    {
      models: [
        {
          provider: "system-one",
          model: "blocked",
          protocol: "system-one",
          availability: "unsupported",
        },
      ],
    },
  );
  await expect(
    blocked.evaluate({ ...input, allowUnverifiedModel: true }, signal()),
  ).rejects.toBeInstanceOf(ProviderInputError);
  expect(blocked.describe().toolSupport?.check).toBe("unsupported");
  expect(calls).toBe(0);
});
test("OpenAI exposes the documented protocol and capabilities without credentials but requires authentication to dispatch", async () => {
  let calls = 0;
  const provider = createProvider({
    kind: "openai",
    fetch: async () => {
      calls++;
      throw Error("No dispatch expected");
    },
  });
  expect(provider.describe()).toMatchObject({
    provider: "openai",
    protocol: "openai-decisions",
    defaultModel: "gpt-6-luna",
    model: "gpt-6-luna",
    availability: "supported",
    capabilitySource: "model",
    capabilities: {
      judgments: ["classification", "score", "check"],
      inputs: ["text", "json", "image"],
      mixedQuestions: true,
      minOptions: 2,
      maxOptions: 255,
      maxImages: 128,
      typedChoices: true,
      refusals: true,
    },
  });
  await expect(provider.evaluate(input, signal())).rejects.toBeInstanceOf(
    ProviderConfigurationError,
  );
  await expect(provider.listModels(signal())).rejects.toBeInstanceOf(
    ProviderConfigurationError,
  );
  expect(calls).toBe(0);
});
test("OpenAI dispatches one authenticated native Decisions request and resolves explicit models", async () => {
  for (const selected of [undefined, "future-decider"]) {
    let calls = 0;
    const model = selected ?? "gpt-6-luna";
    const provider = createProvider({
      kind: "openai",
      apiKey: "fixture-openai",
      baseURL: "http://localhost:8787/api",
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe("http://localhost:8787/api/v1/decisions");
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture-openai",
        );
        expect(JSON.parse(init!.body as string)).toEqual({
          model,
          input: "ready",
          questions: [{ type: "predicate", name: "q", instructions: "Ready?" }],
        });
        return Response.json({
          model,
          answers: [{ type: "predicate", name: "q", probability: 0.95 }],
          usage: {
            input_tokens: 42,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 42,
          },
        });
      },
    });
    expect(
      await provider.evaluate(
        {
          content: "ready",
          checks: [{ id: "q", question: "Ready?" }],
          ...(selected ? { model: selected, allowUnverifiedModel: true } : {}),
        },
        signal(),
      ),
    ).toMatchObject({
      provider: "openai",
      model,
      protocol: "openai-decisions",
      results: [{ id: "q", kind: "check", probability: 0.95 }],
      usage: { inputTokens: 42, outputTokens: 0 },
    });
    expect(calls).toBe(1);
    expect(provider.describe().model).toBe("gpt-6-luna");
  }
});

test("all explicit routes preserve authentication, payload and actual provenance", async () => {
  const routes: [ProviderKind, string, string, boolean][] = [
    ["typesafe", "https://api.typesafe.ai/v1/systemone", "jev-latest", false],
    ["system-one", "http://localhost:8787/v1/systemone", "custom", false],
    [
      "openrouter",
      "https://openrouter.ai/api/alpha/decisions",
      "typesafe/jev-1.13",
      false,
    ],
    [
      "vercel",
      "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
      "typesafe-ai/jev",
      false,
    ],
    ["zen", "https://opencode.ai/zen/v1/systemone", "jev-1.13", false],
    [
      "cloudflare-gateway",
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai/run",
      "typesafe/jev",
      true,
    ],
    [
      "cloudflare-workers",
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai/run/@cf/cloudflare/clef",
      "clef",
      false,
    ],
  ];
  for (const [kind, url, model, wrapped] of routes) {
    let count = 0;
    const provider = createProvider({
      kind,
      apiKey: "fixture-key",
      accountId: "fixture",
      gatewayId: "gateway",
      ...(kind === "system-one"
        ? {
            baseURL: "http://localhost:8787",
            defaultModel: "custom",
            allowUnverifiedModels: true,
          }
        : {}),
      fetch: async (target, init) => {
        count++;
        expect(String(target)).toBe(url);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture-key",
        );
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeDefined();
        const payload = {
          state: input.content,
          questions: { q: { type: "noul", instructions: "Ready?" } },
        };
        expect(JSON.parse(init!.body as string)).toEqual(
          wrapped ? { model, input: payload } : { model, ...payload },
        );
        if (kind.startsWith("cloudflare"))
          expect(new Headers(init?.headers).get("cf-aig-gateway-id")).toBe(
            "gateway",
          );
        return Response.json(
          kind.startsWith("cloudflare")
            ? { success: true, result: response }
            : response,
        );
      },
    });
    expect(await provider.evaluate(input, signal())).toEqual({
      provider: kind,
      model: "actual-version",
      results: [{ id: "q", kind: "check", probability: 0.8 }],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(count).toBe(1);
  }
});

test("description does not require credentials but remote dispatch does", async () => {
  const provider = createProvider({
    kind: "typesafe",
    fetch: async () => {
      throw Error("must not dispatch");
    },
  });
  expect(provider.describe().provider).toBe("typesafe");
  await expect(provider.evaluate(input, signal())).rejects.toBeInstanceOf(
    ProviderConfigurationError,
  );
  const local = createProvider({
    kind: "system-one",
    baseURL: "http://localhost:8787",
    defaultModel: "custom",
    allowUnverifiedModels: true,
    fetch: async (_, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json(response);
    },
  });
  await local.evaluate(input, signal());
});

test("errors are sanitized, retain HTTP status/code/retry and never retry", async () => {
  let calls = 0;
  const provider = createProvider({
    kind: "typesafe",
    apiKey: "fixture",
    fetch: async () => {
      calls++;
      return Response.json(
        { error: { code: "limited", message: "PRIVATE" } },
        { status: 429, headers: { "retry-after": "2" } },
      );
    },
  });
  try {
    await provider.evaluate(input, signal());
    throw Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderHttpError);
    const e = error as ProviderHttpError;
    expect(e.status).toBe(429);
    expect(e.upstreamCode).toBe("limited");
    expect(e.headers.get("retry-after")).toBe("2");
    expect(e.message).not.toContain("PRIVATE");
  }
  expect(calls).toBe(1);
});

test("timeouts include body reads and aborts isolate concurrent requests", async () => {
  const timed = createProvider({
    kind: "typesafe",
    apiKey: "fixture",
    timeoutMs: 10,
    fetch: async () => new Response(new ReadableStream({ start() {} })),
  });
  await expect(timed.evaluate(input, signal())).rejects.toBeInstanceOf(
    RequestTimeoutError,
  );
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  let calls = 0;
  const provider = createProvider({
    kind: "typesafe",
    apiKey: "fixture",
    fetch: async () => {
      if (++calls === 1) {
        started();
        return new Promise<Response>(() => {});
      }
      return Response.json(response);
    },
  });
  const controller = new AbortController();
  const cancelled = provider.evaluate(input, controller.signal);
  await ready;
  controller.abort();
  await expect(cancelled).rejects.toBeInstanceOf(RequestCancelledError);
  expect((await provider.evaluate(input, signal())).results).toHaveLength(1);
});

test("provider constraints refuse unsupported/null requests before dispatch", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return Response.json(response);
  };
  const router = createProvider({
    kind: "openrouter",
    apiKey: "fixture",
    fetch: fetcher,
  });
  for (const request of [
    { ...input, content: null },
    { ...input, checks: [{ id: "q", question: null }] },
    { ...input, scores: [{ id: "s", question: "Quality?", levels: [null] }] },
    { ...input, checks: [{ id: "q", question: "Ready?", yes: "yes" }] },
    { ...input, images: ["data:image/png;base64,YQ=="] },
  ])
    await expect(router.evaluate(request, signal())).rejects.toBeInstanceOf(
      ProviderInputError,
    );
  const clef = createProvider({
    kind: "cloudflare-workers",
    accountId: "fixture",
    apiKey: "fixture",
    fetch: fetcher,
  });
  for (const request of [
    { ...input, model: "@cf/other/model" },
    { ...input, checks: [{ id: "q!", question: "Ready?" }] },
    {
      ...input,
      checks: Array.from({ length: 65 }, (_, i) => ({
        id: `q${i}`,
        question: "?",
      })),
    },
    { ...input, images: ["https://example.com/a.png"] },
    { ...input, images: ["data:image/png;base64,???"] },
    { ...input, images: Array(5).fill("data:image/png;base64,YQ==") },
  ])
    await expect(clef.evaluate(request, signal())).rejects.toBeInstanceOf(
      ProviderInputError,
    );
  expect(calls).toBe(0);
});

test("custom adapters are single-request semantic extensions with isolated model capabilities", async () => {
  const adapter: DecisionAdapter = {
    id: "fixture-decision",
    capabilities: () => ({
      judgments: ["check"],
      inputs: ["json", "text"],
      mixedQuestions: false,
      maxQuestions: 1,
      confidence: "unavailable",
    }),
    prepare: (assessment, context) => ({
      path: "/judge",
      body: {
        candidate: assessment.content,
        question: assessment.checks![0]!.question,
        selected: context.model,
      },
      decode: (raw) => ({
        provider: context.provider,
        model: context.model,
        results: [
          {
            id: assessment.checks![0]!.id,
            kind: "check",
            value: (raw as { accepted: boolean }).accepted,
          },
        ],
      }),
    }),
  };
  let calls = 0;
  const provider = createProvider(
    {
      kind: "custom",
      allowUnverifiedModels: true,
      protocol: adapter.id,
      baseURL: "http://localhost:8787/service",
      defaultModel: "small",
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe("http://localhost:8787/service/judge");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(JSON.parse(init!.body as string).selected).toBe("large");
        return Response.json({ accepted: true });
      },
    },
    {
      adapters: [adapter],
      models: [
        {
          provider: "custom",
          model: "large",
          protocol: adapter.id,
          availability: "supported",
          capabilities: {
            ...adapter.capabilities({ provider: "custom", model: "large" }),
            maxQuestions: 2,
          },
        },
      ],
    },
  );
  expect(provider.describe().capabilities.maxQuestions).toBe(1);
  expect(provider.describe("large")).toMatchObject({
    model: "large",
    capabilitySource: "configuration",
    capabilities: { maxQuestions: 2 },
  });
  expect((await provider.listModels(signal())).models.map((m) => m.id)).toEqual(
    ["small", "large"],
  );
  await expect(
    provider.evaluate(
      {
        ...input,
        checks: [
          { id: "a", question: "?" },
          { id: "b", question: "?" },
        ],
      },
      signal(),
    ),
  ).rejects.toBeInstanceOf(ProviderInputError);
  expect(
    (await provider.evaluate({ ...input, model: "large" }, signal())).results,
  ).toEqual([{ id: "q", kind: "check", value: true }]);
  expect(calls).toBe(1);
});

test("runtime model overrides select the same profile as discovery and enforce only its own limits", async () => {
  let calls = 0;
  const provider = createProvider({
    kind: "openrouter",
    apiKey: "fixture",
    fetch: async (_, init) => {
      calls++;
      const body = JSON.parse(init!.body as string);
      return Response.json({
        model: body.model,
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            { type: "noul", noul: 0.9 },
          ]),
        ),
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  expect(provider.describe().protocol).toBe("openrouter-decisions");
  expect(
    provider.describe("togethercomputer/tev1-4b-experimental"),
  ).toMatchObject({
    protocol: "tev1-chat",
    capabilitySource: "model",
    capabilities: { maxQuestions: 1, maxOptions: 24 },
  });
  const request = {
    content: "ready",
    model: "perplexity/pplx-decider-v1-27b",
    checks: Array.from({ length: 129 }, (_, i) => ({
      id: `q${i}`,
      question: "Ready?",
    })),
  };
  await expect(provider.evaluate(request, signal())).rejects.toBeInstanceOf(
    ProviderInputError,
  );
  expect(calls).toBe(0);
  expect(
    (
      await provider.evaluate(
        { ...request, checks: request.checks.slice(0, 128) },
        signal(),
      )
    ).results,
  ).toHaveLength(128);
  expect(
    (
      await provider.evaluate(
        { ...request, model: "future/decision", allowUnverifiedModel: true },
        signal(),
      )
    ).results,
  ).toHaveLength(129);
  expect(provider.describe("future/decision")).toMatchObject({
    availability: "unverified",
    capabilitySource: "protocol",
  });
  expect(provider.describe().capabilities.maxQuestions).toBeUndefined();
  expect(calls).toBe(2);
});

test("registry configuration and adapter routes reject ambiguity before network dispatch", async () => {
  const adapter: DecisionAdapter = {
    id: "fixture",
    capabilities: () => ({
      judgments: ["check"],
      inputs: ["text", "json"],
      mixedQuestions: true,
      confidence: "unavailable",
    }),
    prepare: () => ({
      path: "/judge",
      body: {},
      decode: () => ({ provider: "custom", model: "fixture", results: [] }),
    }),
  };
  const options = {
    kind: "custom" as const,
    allowUnverifiedModels: true,
    protocol: adapter.id,
    baseURL: "http://localhost:8787/service",
    defaultModel: "fixture",
  };
  for (const invalid of [
    { ...options, protocol: "unknown" },
    { ...options, defaultModel: undefined },
    { ...options, baseURL: undefined },
    { kind: "typesafe" as const, protocol: "system-one" },
  ])
    expect(() => createProvider(invalid, { adapters: [adapter] })).toThrow(
      ProviderConfigurationError,
    );
  expect(() =>
    createProvider(options, { adapters: [adapter, adapter] }),
  ).toThrow(ProviderConfigurationError);
  const profile = {
    provider: "custom" as const,
    model: "fixture",
    protocol: adapter.id,
  };
  expect(() =>
    createProvider(options, {
      adapters: [adapter],
      models: [profile, profile],
    }),
  ).toThrow(ProviderConfigurationError);
  expect(() =>
    createProvider(options, {
      adapters: [adapter],
      models: [{ ...profile, protocol: "unknown" }],
    }),
  ).toThrow(ProviderConfigurationError);
  for (const path of [
    "https://evil.test/judge",
    "//evil.test/judge",
    "/../judge",
    "/a/%2e%2e/judge",
    "/judge?key=secret",
    "/judge#fragment",
    "/a\\judge",
    "/a/%2fjudge",
  ]) {
    const provider = createProvider(
      {
        ...options,
        fetch: async () => {
          throw Error("No dispatch expected");
        },
      },
      {
        adapters: [
          {
            ...adapter,
            prepare: () => ({
              ...adapter.prepare(input, {
                provider: "custom",
                model: "fixture",
              }),
              path,
            }),
          },
        ],
      },
    );
    await expect(provider.evaluate(input, signal())).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
  }
});

test("Clef sends flash and multiple embedded image representations without data loss", async () => {
  const images = [
    "DATA:image/png;base64,YQ==",
    { content_type: "image/jpeg" as const, base64: "Yg==" },
  ];
  const provider = createProvider({
    kind: "cloudflare-workers",
    accountId: "fixture",
    apiKey: "fixture",
    defaultModel: "@cf/cloudflare/clef-flash",
    fetch: async (url, init) => {
      expect(String(url)).toEndWith("/ai/run/@cf/cloudflare/clef-flash");
      expect(JSON.parse(init!.body as string).model).toBe("clef-flash");
      expect(JSON.parse(init!.body as string).images).toEqual(images);
      return Response.json(response);
    },
  });
  await provider.evaluate({ ...input, images }, signal());
});

test("Clef ID, option labels and cardinality follow its own schema", async () => {
  let calls = 0;
  const clef = createProvider({
    kind: "cloudflare-workers",
    baseURL: "http://localhost:8787/ai",
    fetch: async (_, init) => {
      calls++;
      const body = JSON.parse(init!.body as string);
      return Response.json({
        model: "clef",
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([id, q]) => [
            id,
            (q as { type: string }).type === "choice"
              ? {
                  type: "choice",
                  choice: "中文",
                  confidence: 0.8,
                  probabilities: { 中文: 0.8, "other option": 0.2 },
                }
              : { type: "noul", noul: 0.8 },
          ]),
        ),
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
    apiKey: "fixture",
  });
  const request = {
    content: "ready",
    classifications: [
      {
        id: "q.dot",
        question: "Label?",
        options: { 中文: null, "other option": null },
      },
    ],
    checks: [{ id: "q".repeat(100), question: "Ready?" }],
  };
  expect((await clef.evaluate(request, signal())).results[0]).toMatchObject({
    id: "q.dot",
    value: "中文",
  });
  for (const invalid of [
    { ...input, checks: [{ id: "q".repeat(101), question: "Ready?" }] },
    { ...input, checks: [{ id: "q", question: "" }] },
    {
      content: "ready",
      scores: [{ id: "s", question: "Quality?", levels: ["one"] }],
    },
    {
      content: "ready",
      classifications: [
        {
          id: "c",
          question: "Label?",
          options: Object.fromEntries(
            Array.from({ length: 256 }, (_, i) => [`c${i}`, null]),
          ),
        },
      ],
    },
  ])
    await expect(clef.evaluate(invalid, signal())).rejects.toBeInstanceOf(
      ProviderInputError,
    );
  expect(calls).toBe(1);
});

test("Clef enforces decoded per-image/aggregate and whole-body limits before HTTP", async () => {
  let calls = 0;
  const clef = createProvider({
    kind: "cloudflare-workers",
    accountId: "fixture",
    apiKey: "fixture",
    fetch: async () => {
      calls++;
      return Response.json(response);
    },
  });
  const image = (bytes: number) => ({
    content_type: "image/png" as const,
    base64: Buffer.alloc(bytes).toString("base64"),
  });
  for (const invalid of [
    { ...input, images: [image(4 * 1024 * 1024 + 1)] },
    {
      ...input,
      images: [
        image(3 * 1024 * 1024),
        image(3 * 1024 * 1024),
        image(3 * 1024 * 1024),
      ],
    },
    {
      ...input,
      content: "a".repeat(3 * 1024 * 1024),
      images: [image(4 * 1024 * 1024), image(4 * 1024 * 1024)],
    },
  ])
    await expect(clef.evaluate(invalid, signal())).rejects.toBeInstanceOf(
      ProviderInputError,
    );
  expect(calls).toBe(0);
});

test("OpenRouter and custom profiles admit one score level and generic unbounded option counts", async () => {
  for (const kind of ["openrouter", "system-one"] as const) {
    const provider = createProvider({
      kind,
      apiKey: "fixture",
      ...(kind === "system-one"
        ? {
            baseURL: "http://localhost:8787",
            defaultModel: "custom",
            allowUnverifiedModels: true,
          }
        : {}),
      fetch: async () =>
        Response.json({
          model: "actual",
          answers: { s: { type: "score", score: 0 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    expect(
      (
        await provider.evaluate(
          {
            content: "ready",
            scores: [{ id: "s", question: "Quality?", levels: ["one"] }],
          },
          signal(),
        )
      ).results,
    ).toEqual([{ id: "s", kind: "score", value: 0 }]);
  }
});

test("configuration validates URLs and keeps provider selection explicit", async () => {
  for (const baseURL of [
    "not-a-url",
    "https://example.com?token=private",
    "https://user:private@example.com",
    "ftp://example.com",
    "https://example.com/#fragment",
  ])
    expect(() =>
      createProvider({ kind: "system-one", defaultModel: "custom", baseURL }),
    ).toThrow(ProviderConfigurationError);
  expect(() => createProvider({ kind: "system-one" })).toThrow(
    ProviderConfigurationError,
  );
  expect(() => createProvider({ kind: "cloudflare-workers" })).toThrow(
    ProviderConfigurationError,
  );
  const provider = createProvider({
    kind: "openrouter",
    baseURL: "http://localhost:8787/api",
    apiKey: "fixture",
    fetch: async (url) => {
      expect(String(url)).toBe("http://localhost:8787/api/alpha/decisions");
      return Response.json(response);
    },
  });
  await provider.evaluate(input, signal());
});

test("OpenRouter allows one choice and Clef accepts single-side check definitions", async () => {
  const router = createProvider({
    kind: "openrouter",
    apiKey: "fixture",
    fetch: async () =>
      Response.json({
        model: "actual",
        answers: { c: { type: "choice", choice: "only" } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
  });
  expect(
    (
      await router.evaluate(
        {
          content: "ready",
          classifications: [
            { id: "c", question: "Label?", options: { only: null } },
          ],
        },
        signal(),
      )
    ).results,
  ).toEqual([{ id: "c", kind: "classification", value: "only" }]);
  const clef = createProvider({
    kind: "cloudflare-workers",
    accountId: "fixture",
    apiKey: "fixture",
    fetch: async (_, init) => {
      expect(JSON.parse(init!.body as string).questions.q.criteria).toEqual({
        true: "supported",
      });
      return Response.json(response);
    },
  });
  await clef.evaluate(
    {
      content: "ready",
      checks: [{ id: "q", question: "Ready?", yes: "supported" }],
    },
    signal(),
  );
});

test("generic protocols do not inherit native cardinality limits", async () => {
  for (const kind of ["openrouter", "system-one"] as const) {
    const provider = createProvider({
      kind,
      apiKey: "fixture",
      ...(kind === "system-one"
        ? {
            baseURL: "http://localhost:8787",
            defaultModel: "custom",
            allowUnverifiedModels: true,
          }
        : {}),
      fetch: async (_, init) => {
        const body = JSON.parse(init!.body as string);
        return Response.json({
          model: "actual",
          answers: Object.fromEntries(
            Object.entries(body.questions).map(([id, q]) => [
              id,
              (q as { type: string }).type === "choice"
                ? { type: "choice", choice: "c0" }
                : { type: "score", score: 0 },
            ]),
          ),
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const request = {
      content: "ready",
      classifications: [
        {
          id: "c",
          question: "Label?",
          options: Object.fromEntries(
            Array.from({ length: 256 }, (_, i) => [`c${i}`, null]),
          ),
        },
      ],
      scores: Array.from({ length: 65 }, (_, i) => ({
        id: `s${i}`,
        question: "Quality?",
        levels: Array(11).fill("level"),
      })),
    };
    expect((await provider.evaluate(request, signal())).results).toHaveLength(
      66,
    );
  }
});

test("native Jev protocols admit 65 questions while Clef alone advertises and enforces 64", async () => {
  const checks = Array.from({ length: 65 }, (_, i) => ({
    id: `q${i}`,
    question: "Ready?",
  }));
  const provider = createProvider({
    kind: "typesafe",
    apiKey: "fixture",
    fetch: async () =>
      Response.json({
        model: "actual",
        answers: Object.fromEntries(
          checks.map((q) => [q.id, { type: "noul", noul: 0.8 }]),
        ),
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
  });
  expect(provider.describe().capabilities.maxQuestions).toBeUndefined();
  expect(
    (await provider.evaluate({ content: "ready", checks }, signal())).results,
  ).toHaveLength(65);
  const clef = createProvider({
    kind: "cloudflare-workers",
    accountId: "fixture",
    apiKey: "fixture",
    fetch: async () => {
      throw Error("No dispatch expected");
    },
  });
  expect(clef.describe().capabilities.maxQuestions).toBe(64);
  await expect(
    clef.evaluate({ content: "ready", checks }, signal()),
  ).rejects.toBeInstanceOf(ProviderInputError);
});

test("Clef schema preserves nullable optional yes/no definitions", async () => {
  for (const no of ["unsupported", null]) {
    const clef = createProvider({
      kind: "cloudflare-workers",
      accountId: "fixture",
      apiKey: "fixture",
      fetch: async (_, init) => {
        expect(JSON.parse(init!.body as string).questions.q.criteria).toEqual({
          true: null,
          false: no,
        });
        return Response.json(response);
      },
    });
    await clef.evaluate(
      { content: "", checks: [{ id: "q", question: "Ready?", yes: null, no }] },
      signal(),
    );
  }
});
