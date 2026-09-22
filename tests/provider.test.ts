import { expect, test } from "bun:test";
import { TypeSafeClient, APIError } from "@typesafe-ai/sdk";
import {
  providerFetch,
  validateProviderRequest,
  ProviderInputError,
  ProviderConfigurationError,
} from "../src/provider.ts";
import { toolError } from "../src/errors.ts";
const baseURL = "https://opencode.ai/zen";

test("Zen catalog adapts through official SDK without inventing metadata", async () => {
  const abort = new AbortController();
  let calls = 0;
  const sdk = new TypeSafeClient({
    apiKey: "fixture",
    baseURL,
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: providerFetch(async (url, init) => {
      calls++;
      expect(url).toBe(`${baseURL}/v1/models`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture",
      );
      expect(init?.signal).toBeDefined();
      return Response.json({
        object: "list",
        data: [
          { id: "other-model" },
          { id: "jev-1.13-free", created: 123 },
          { id: "jev-1.13" },
        ],
      });
    }),
  });
  expect(await sdk.models.list({ signal: abort.signal })).toEqual([
    { name: "jev-1.13-free", description: "", release_date: "" },
    { name: "jev-1.13", description: "", release_date: "" },
  ]);
  expect(calls).toBe(1);
});

test("provider adapter preserves non-Zen, inference, malformed catalog and HTTP errors", async () => {
  for (const [url, method, status, body] of [
    ["https://api.typesafe.ai/v1/models", "GET", 200, { models: [] }],
    [`${baseURL}/v1/systemone`, "POST", 200, { answers: {} }],
    [`${baseURL}/v1/models`, "GET", 200, { object: "list", data: [{ id: 7 }] }],
    [`${baseURL}/v1/models`, "GET", 429, { error: "fixture" }],
  ] as const) {
    const original = Response.json(body, { status });
    const adapted = await providerFetch(async () => original)(url, { method });
    expect(adapted).toBe(original);
    expect(await adapted.json()).toEqual(body);
  }
  const sdk = new TypeSafeClient({
    apiKey: "fixture",
    baseURL,
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: providerFetch(async () =>
      Response.json({}, { status: 429, headers: { "retry-after": "2" } }),
    ),
  });
  try {
    await sdk.models.list();
    throw Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    expect(JSON.parse(toolError(error).content[0]!.text).error).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 2000,
    });
  }
});

test("Zen rejects observed unsupported null inputs locally but preserves structured and native inputs", () => {
  const invalid = [
    {
      state: null,
      questions: { q: { type: "noul", instructions: "Question" } },
    },
    {
      state: "text",
      questions: {
        q: {
          type: "score",
          instructions: "Question",
          criteria: [null, "high"],
        },
      },
    },
    {
      state: "text",
      questions: {
        q: {
          type: "noul",
          instructions: null,
          criteria: { true: null, false: null },
        },
      },
    },
  ] as const;
  for (const request of invalid) {
    // Mutable JSON payload matches the SDK's mutable arrays.
    const payload = JSON.parse(JSON.stringify(request));
    expect(() => validateProviderRequest(baseURL, payload)).toThrow(
      ProviderInputError,
    );
    expect(() =>
      validateProviderRequest("https://api.typesafe.ai", payload),
    ).not.toThrow();
  }
  expect(() =>
    validateProviderRequest(baseURL, {
      state: { missing: null },
      questions: {
        choice: {
          type: "choice",
          instructions: null,
          criteria: { yes: null, no: null },
        },
        score: {
          type: "score",
          instructions: ["Quality"],
          criteria: [{ value: null }, ["good"]],
        },
        check: {
          type: "noul",
          instructions: "Is evidence sufficient?",
          criteria: { true: null, false: null },
        },
      },
    }),
  ).not.toThrow();
});

test("observed rounded score is accepted only with bounded Zen rounding", async () => {
  const { validateResponse } = await import("../src/contracts.ts");
  const levels = [
    "Terrible",
    "Poor",
    "Below average",
    "Somewhat weak",
    "Average",
    "Somewhat good",
    "Good",
    "Very good",
    "Excellent",
    "Outstanding",
  ];
  const questions = {
    quality: {
      type: "score" as const,
      instructions: "Quality",
      criteria: levels as [string, string, ...string[]],
    },
  };
  const response = {
    model: "jev-1.13-free",
    answers: {
      quality: {
        type: "score" as const,
        score: 3.74,
        confidence: 0.7,
        legend: Object.fromEntries(levels.map((v, i) => [String(i), v])),
        probabilities: {
          "0": 0,
          "1": 0,
          "2": 0.01,
          "3": 0.46,
          "4": 0.32,
          "5": 0.21,
          "6": 0,
          "7": 0,
          "8": 0,
          "9": 0,
        },
      },
    },
    usage: { input_tokens: 367, output_tokens: 17 },
  };
  expect(() => validateResponse(response, questions)).toThrow();
  expect(validateResponse(response, questions, true)).toEqual(response);
  expect(() =>
    validateResponse(
      {
        ...response,
        answers: { quality: { ...response.answers.quality, score: 4.1 } },
      },
      questions,
      true,
    ),
  ).toThrow();
  expect(() =>
    validateResponse(
      {
        ...response,
        answers: {
          quality: {
            ...response.answers.quality,
            probabilities: {
              ...response.answers.quality.probabilities,
              "3": 0.8,
            },
          },
        },
      },
      questions,
      true,
    ),
  ).toThrow();
});

test("MCP reports Zen admission errors before issuing HTTP requests", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createServer } = await import("../src/server.ts");
  let calls = 0;
  const sdk = new TypeSafeClient({
    apiKey: "fixture",
    baseURL,
    logLevel: "off",
    fetch: async () => {
      calls++;
      throw Error("No request expected");
    },
  });
  const server = createServer(sdk),
    client = new Client({ name: "provider-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    for (const args of [
      { content: null, checks: [{ id: "x", question: "Is valid?" }] },
      {
        content: "test",
        scores: [{ id: "x", question: "Quality?", levels: [null, "high"] }],
      },
      {
        content: "test",
        checks: [{ id: "x", question: null, yes: null, no: null }],
      },
    ]) {
      const result = await client.callTool({
        name: "assess_structure",
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result.content)).toContain("INVALID_REQUEST");
      expect(JSON.stringify(result.content)).toContain("OpenCode Zen requires");
    }
    expect(calls).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("gateway inference keeps SDK auth, payload meaning and response contract", async () => {
  const request = {
    state: { evidence: ["ready", null] },
    questions: { ready: { type: "noul" as const, instructions: "Ready?" } },
  };
  const answer = {
    model: "jev-1.13.0",
    answers: { ready: { type: "noul" as const, noul: 0.8 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  for (const [baseURL, endpoint, model, wrapped] of [
    [
      "https://openrouter.ai/api",
      "https://openrouter.ai/api/alpha/decisions",
      "typesafe/jev-1.13",
      false,
    ],
    [
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai",
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai/run",
      "typesafe/jev",
      true,
    ],
    [
      "https://ai-gateway.vercel.sh/typesafe",
      "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
      "typesafe-ai/jev",
      false,
    ],
  ] as const) {
    let calls = 0;
    const sdk = new TypeSafeClient({
      apiKey: "fixture",
      baseURL,
      defaultModel: model,
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: providerFetch(async (url, init) => {
        calls++;
        expect(url).toBe(endpoint);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture",
        );
        expect(init?.signal).toBeDefined();
        expect(JSON.parse(init!.body as string)).toEqual(
          wrapped ? { model, input: request } : { model, ...request },
        );
        return Response.json(
          wrapped
            ? { success: true, result: answer, errors: [], messages: [] }
            : answer,
        );
      }),
    });
    expect(await sdk.systemOne(request)).toEqual(answer);
    expect(calls).toBe(1);
  }
});

test("gateway catalogs filter Jev and preserve unknown metadata", async () => {
  for (const [baseURL, endpoint, id] of [
    [
      "https://openrouter.ai/api",
      "https://openrouter.ai/api/v1/models",
      "typesafe/jev-1.13",
    ],
    [
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai",
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai/models/search?search=typesafe%2Fjev&per_page=100&format=openrouter",
      "typesafe/jev",
    ],
  ] as const) {
    const sdk = new TypeSafeClient({
      apiKey: "fixture",
      baseURL,
      logLevel: "off",
      fetch: providerFetch(async (url) => {
        expect(url).toBe(endpoint);
        return Response.json({
          data: [
            { id, description: "Jev", created: 123 },
            { id: "other/chat" },
          ],
        });
      }),
    });
    expect(await sdk.models.list()).toEqual([
      { name: id, description: "Jev", release_date: "" },
    ]);
  }
});

test("documented endpoint defaults and OpenRouter input limits reject before dispatch", async () => {
  const { providerDefaultModel } = await import("../src/provider.ts");
  expect(providerDefaultModel(undefined)).toBe("jev-latest");
  expect(providerDefaultModel("https://opencode.ai/zen")).toBe("jev-1.13");
  expect(providerDefaultModel("https://ai-gateway.vercel.sh/typesafe/")).toBe(
    "typesafe-ai/jev",
  );
  expect(providerDefaultModel("https://openrouter.ai/api")).toBe(
    "typesafe/jev-1.13",
  );
  expect(
    providerDefaultModel(
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai",
    ),
  ).toBe("typesafe/jev");
  for (const url of [
    "https://ai-gateway.vercel.sh/v1",
    "https://api.typesafe.ai/v1",
    "https://opencode.ai/zen/v1",
    "not-a-url",
    "https://openrouter.ai/api?token=fixture",
    "https://openrouter.ai/api/v1",
    "https://api.cloudflare.com/client/v4/accounts/fixture/ai/run",
  ])
    expect(() => providerDefaultModel(url)).toThrow(ProviderConfigurationError);
  const base = "https://openrouter.ai/api";
  const good = {
    state: { value: null },
    questions: { q: { type: "noul" as const, instructions: "Ready?" } },
  };
  expect(() => validateProviderRequest(base, good)).not.toThrow();
  for (const request of [
    { ...good, state: null },
    {
      ...good,
      questions: {
        q: {
          type: "choice",
          instructions: null,
          criteria: { a: null, b: null },
        },
      },
    },
    {
      ...good,
      questions: {
        q: {
          type: "score",
          instructions: "Quality?",
          criteria: [null, "good"],
        },
      },
    },
    {
      ...good,
      questions: {
        q: { type: "noul", instructions: "Ready?", criteria: { true: "yes" } },
      },
    },
  ])
    expect(() =>
      validateProviderRequest(base, JSON.parse(JSON.stringify(request))),
    ).toThrow(ProviderInputError);
});

test("adapted gateways preserve errors, cancellation and malformed successful bodies", async () => {
  const baseURL = "https://api.cloudflare.com/client/v4/accounts/fixture/ai";
  const payload = {
    state: "ready",
    questions: { q: { type: "noul" as const, instructions: "Ready?" } },
  };
  for (const status of [401, 429, 503]) {
    let calls = 0;
    const sdk = new TypeSafeClient({
      apiKey: "fixture",
      baseURL,
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: providerFetch(async () => {
        calls++;
        return Response.json({ errors: [{ message: "private" }] }, { status });
      }),
    });
    await expect(
      sdk.systemOne(payload).then((value) => value),
    ).rejects.toBeInstanceOf(APIError);
    expect(calls).toBe(1);
  }
  for (const body of [
    { success: false, result: {} },
    { success: true },
    { data: [{ id: 7 }] },
  ]) {
    const original = Response.json(body);
    const response = await providerFetch(async () => original)(
      `${baseURL}/v1/systemone`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    expect(response).toBe(original);
  }
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sdk = new TypeSafeClient({
    apiKey: "fixture",
    baseURL,
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: providerFetch(async (_, init) => {
      started();
      return new Promise<Response>((_, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    }),
  });
  const outcome = sdk
    .systemOne(payload, { signal: abort.signal })
    .catch((e) => e);
  await ready;
  abort.abort();
  expect(JSON.stringify(toolError(await outcome).content)).toContain(
    "CANCELLED",
  );
});

test("gateway rewrites stay scoped and catalog truncation is not hidden", async () => {
  for (const url of [
    "https://example.com/api/v1/systemone",
    "https://openrouter.ai/unrelated/v1/systemone",
    "https://api.cloudflare.com/unrelated/v1/systemone",
  ]) {
    const original = Response.json({ unchanged: true });
    const init = { method: "POST", body: "{}" };
    expect(
      await providerFetch(async (target, options) => {
        expect(target).toBe(url);
        expect(options).toBe(init);
        return original;
      })(url, init),
    ).toBe(original);
  }
  const original = Response.json({
    data: Array.from({ length: 100 }, () => ({ id: "typesafe/jev" })),
  });
  expect(
    await providerFetch(async () => original)(
      "https://api.cloudflare.com/client/v4/accounts/fixture/ai/v1/models",
    ),
  ).toBe(original);
});

test("MCP rejects failed Cloudflare envelopes and unsupported OpenRouter inputs", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createServer } = await import("../src/server.ts");
  for (const cloudflare of [true, false]) {
    let calls = 0;
    const sdk = new TypeSafeClient({
      apiKey: "fixture",
      baseURL: cloudflare
        ? "https://api.cloudflare.com/client/v4/accounts/fixture/ai"
        : "https://openrouter.ai/api",
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: providerFetch(async () => {
        calls++;
        return Response.json({
          success: false,
          errors: [{ message: "private" }],
          result: {
            model: "jev",
            answers: { q: { type: "noul", noul: 1 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
      }),
    });
    const server = createServer(sdk),
      client = new Client({ name: "gateway-contract", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: "check",
        arguments: {
          content: cloudflare ? "ready" : null,
          items: [{ id: "q", question: "Ready?" }],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result.content)).toContain(
        cloudflare ? "INVALID_RESPONSE" : "INVALID_REQUEST",
      );
      expect(JSON.stringify(result.content)).not.toContain("private");
      expect(calls).toBe(cloudflare ? 1 : 0);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("Cloudflare AI Gateway selection is scoped to its inference route", async () => {
  const body = JSON.stringify({
    model: "typesafe/jev",
    state: "ready",
    questions: {},
  });
  for (const gatewayId of [undefined, "selected-gateway"]) {
    for (const cloudflare of [true, false]) {
      const init = {
        method: "POST",
        headers: { authorization: "Bearer fixture" },
        body,
      };
      await providerFetch(
        async (_, options) => {
          const headers = new Headers(options?.headers);
          expect(headers.get("authorization")).toBe("Bearer fixture");
          expect(headers.get("cf-aig-gateway-id")).toBe(
            cloudflare ? (gatewayId ?? null) : null,
          );
          return Response.json({
            model: "jev",
            answers: {},
            usage: { input_tokens: 0, output_tokens: 0 },
          });
        },
        { cloudflareGatewayId: gatewayId },
      )(
        cloudflare
          ? "https://api.cloudflare.com/client/v4/accounts/fixture/ai/v1/systemone"
          : "https://openrouter.ai/api/v1/systemone",
        init,
      );
    }
  }
});
