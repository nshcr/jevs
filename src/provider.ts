import type { Fetch, SystemOneRequest, Questions } from "@typesafe-ai/sdk";
import { z } from "zod";

export function isZen(baseURL: string) {
  const url = new URL(baseURL);
  return (
    url.origin === "https://opencode.ai" &&
    url.pathname.replace(/\/$/, "") === "/zen"
  );
}

function isOpenRouter(url: URL) {
  return url.origin === "https://openrouter.ai";
}
function cloudflareRoot(url: URL) {
  return url.origin === "https://api.cloudflare.com"
    ? url.pathname.match(
        /^\/client\/v4\/accounts\/[a-zA-Z0-9_-]+\/ai(?=\/|$)/,
      )?.[0]
    : undefined;
}

// Official SDK retains authentication, timeout, cancellation and HTTP error handling.
// Rewrites are restricted to known origins and exact SDK operation paths.
export function providerFetch(
  fetcher: Fetch = fetch,
  config: { cloudflareGatewayId?: string } = {},
): Fetch {
  return async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const cfRoot = cloudflareRoot(url);
    let target = input;
    let options = init;
    let catalog = false;
    let cloudflareInference = false;
    if (
      isOpenRouter(url) &&
      url.pathname === "/api/v1/systemone" &&
      method === "POST"
    ) {
      target = `${url.origin}/api/alpha/decisions`;
    } else if (
      cfRoot &&
      url.pathname === `${cfRoot}/v1/systemone` &&
      method === "POST"
    ) {
      const { model, ...payload } = JSON.parse(init!.body as string);
      target = `${url.origin}${cfRoot}/run`;
      const headers = new Headers(init?.headers);
      if (config.cloudflareGatewayId?.trim()) {
        headers.set("cf-aig-gateway-id", config.cloudflareGatewayId.trim());
      }
      options = {
        ...init,
        headers,
        body: JSON.stringify({ model, input: payload }),
      };
      cloudflareInference = true;
    }
    if (method === "GET") {
      catalog =
        (url.origin === "https://opencode.ai" &&
          url.pathname === "/zen/v1/models") ||
        (isOpenRouter(url) && url.pathname === "/api/v1/models");
      if (cfRoot && url.pathname === `${cfRoot}/v1/models`) {
        target = `${url.origin}${cfRoot}/models/search?search=typesafe%2Fjev&per_page=100&format=openrouter`;
        catalog = true;
      }
    }
    const response = await fetcher(target, options);
    if (!response.ok || (!catalog && !cloudflareInference)) return response;
    const raw: unknown = await response
      .clone()
      .json()
      .catch(() => undefined);
    function rewrite(body: unknown) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return Response.json(body, { status: response.status, headers });
    }
    if (cloudflareInference) {
      // Accept documented direct output or the standard Cloudflare REST envelope.
      if (raw && typeof raw === "object" && "success" in raw) {
        const envelope = z
          .object({
            success: z.literal(true),
            result: z.record(z.string(), z.unknown()),
          })
          .safeParse(raw);
        return envelope.success ? rewrite(envelope.data.result) : response;
      }
      return response;
    }
    if (
      url.origin === "https://opencode.ai" &&
      !z.object({ object: z.literal("list") }).safeParse(raw).success
    )
      return response;
    const parsed = z
      .object({
        data: z.array(
          z.object({
            id: z.string().min(1),
            description: z.string().optional(),
          }),
        ),
      })
      .safeParse(raw);
    if (!parsed.success || (cfRoot && parsed.data.data.length >= 100))
      return response;
    const prefix = cfRoot
      ? "typesafe/jev"
      : isOpenRouter(url)
        ? "typesafe/jev-"
        : "jev-";
    return rewrite({
      models: parsed.data.data
        .filter(({ id }) => (cfRoot ? id === prefix : id.startsWith(prefix)))
        .map(({ id, description }) => ({
          name: id,
          description: description ?? "",
          release_date: "",
        })),
    });
  };
}

// Defaults apply only to known configured endpoints; explicit model IDs always win.
export function providerDefaultModel(baseURL: string | undefined) {
  if (!baseURL) return "jev-latest";
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new ProviderConfigurationError(
      "Set TYPESAFE_BASE_URL to a valid absolute HTTP(S) base URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new ProviderConfigurationError(
      "Use an HTTP(S) base URL without query, fragment or embedded credentials.",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (url.origin === "https://api.typesafe.ai" && path !== "") {
    throw new ProviderConfigurationError(
      "Set TYPESAFE_BASE_URL to https://api.typesafe.ai without an API operation suffix.",
    );
  }
  if (url.origin === "https://opencode.ai" && path !== "/zen") {
    throw new ProviderConfigurationError(
      "Set TYPESAFE_BASE_URL to https://opencode.ai/zen without an API operation suffix.",
    );
  }
  if (url.origin === "https://ai-gateway.vercel.sh") {
    if (path !== "/typesafe")
      throw new ProviderConfigurationError(
        "Set TYPESAFE_BASE_URL to https://ai-gateway.vercel.sh/typesafe for the TypeSafe-compatible API.",
      );
    return "typesafe-ai/jev";
  }
  if (isOpenRouter(url)) {
    if (path !== "/api")
      throw new ProviderConfigurationError(
        "Set TYPESAFE_BASE_URL to https://openrouter.ai/api; the adapter selects the Decisions endpoint.",
      );
    return "typesafe/jev-1.13";
  }
  if (url.origin === "https://api.cloudflare.com") {
    if (cloudflareRoot(url) !== path)
      throw new ProviderConfigurationError(
        "Set TYPESAFE_BASE_URL to https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai.",
      );
    return "typesafe/jev";
  }
  return url.origin === "https://opencode.ai" && path === "/zen"
    ? "jev-1.13"
    : "jev-latest";
}

export class ProviderConfigurationError extends Error {}
export class ProviderInputError extends Error {}
export function validateProviderRequest(
  baseURL: string,
  request: SystemOneRequest<Questions>,
) {
  if (isOpenRouter(new URL(baseURL))) {
    if (request.state === null)
      throw new ProviderInputError(
        "Provide non-null content for this endpoint.",
      );
    for (const q of Object.values(request.questions)) {
      if (q.instructions === null)
        throw new ProviderInputError(
          "Provide a non-null question for every judgment on this endpoint.",
        );
      if (q.type === "score" && q.criteria.some((v) => v === null))
        throw new ProviderInputError(
          "Describe every score level with a non-null value.",
        );
      if (
        q.type === "noul" &&
        q.criteria &&
        (q.criteria.true == null || q.criteria.false == null)
      )
        throw new ProviderInputError(
          "Supply both non-null yes and no definitions, or omit both on this endpoint.",
        );
    }
  }
  if (!isZen(baseURL)) return;
  if (request.state === null)
    throw new ProviderInputError(
      "OpenCode Zen requires non-null content; provide text, an object or an array.",
    );
  for (const q of Object.values(request.questions)) {
    if (q.type === "score" && q.criteria.some((level) => level === null))
      throw new ProviderInputError(
        "OpenCode Zen requires non-null score levels; describe every level using text, an object or an array.",
      );
    if (
      q.type === "noul" &&
      q.instructions === null &&
      q.criteria?.true == null &&
      q.criteria?.false == null
    )
      throw new ProviderInputError(
        "OpenCode Zen requires a check question or at least one non-null yes/no definition.",
      );
  }
}
