import { z } from "zod";
import type { DecisionAdapter, DecisionCapabilities } from "../decision.ts";
import { ProviderInputError, ResponseContractError } from "../failures.ts";
import { normalizeResponse, toWire } from "./system-one.ts";
import { validateWire } from "./validation.ts";
import { tev1ChatAdapter } from "./tev1-chat.ts";
import { openaiDecisionsAdapter } from "./openai-decisions.ts";

export const textCapabilities: DecisionCapabilities = {
  judgments: ["classification", "score", "check"],
  inputs: ["text", "json"],
  mixedQuestions: true,
  confidence: "provider-defined",
};
const boundedCapabilities: DecisionCapabilities = {
  ...textCapabilities,
  minOptions: 2,
  maxOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
};
const clefCapabilities: DecisionCapabilities = {
  ...boundedCapabilities,
  maxQuestions: 64,
  inputs: ["text", "json", "image"],
  maxImages: 4,
};
function unwrapCloudflare(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "success" in raw) {
    const envelope = z
      .object({ success: z.literal(true), result: z.unknown() })
      .safeParse(raw);
    if (!envelope.success)
      throw new ResponseContractError(
        "Cloudflare returned an unsuccessful response; no results were accepted.",
      );
    return envelope.data.result;
  }
  return raw;
}
const systemOneAdapter: DecisionAdapter = {
  id: "system-one",
  capabilities: ({ provider }) =>
    provider === "custom" || provider === "system-one"
      ? textCapabilities
      : boundedCapabilities,
  prepare(input, context) {
    const request = toWire(input, context.model);
    const kind =
      context.provider === "custom" ? "system-one" : context.provider;
    validateWire(kind, request);
    return {
      path: "/v1/systemone",
      body: request,
      decode: (raw) =>
        normalizeResponse(raw, request, context.provider, {
          requiredUsage: kind !== "system-one",
          requiredMetrics: kind !== "system-one" && kind !== "openrouter",
        }),
    };
  },
};
const openrouterAdapter: DecisionAdapter = {
  id: "openrouter-decisions",
  capabilities: () => textCapabilities,
  prepare(input, context) {
    const request = toWire(input, context.model);
    validateWire("openrouter", request);
    return {
      path: "/alpha/decisions",
      body: request,
      decode: (raw) =>
        normalizeResponse(raw, request, context.provider, {
          requiredUsage: true,
          requiredMetrics: false,
        }),
    };
  },
};
const clefAdapter: DecisionAdapter = {
  id: "cloudflare-clef",
  capabilities: () => clefCapabilities,
  prepare(input, context) {
    const model = context.model.replace(/^@cf\/cloudflare\//, "");
    if (model !== "clef" && model !== "clef-flash")
      throw new ProviderInputError(
        "The Clef protocol supports Clef and Clef Flash model selectors only.",
      );
    const request = toWire(input, model);
    validateWire("cloudflare-workers", request);
    return {
      path: `/run/@cf/cloudflare/${model}`,
      body: request,
      decode: (raw) =>
        normalizeResponse(unwrapCloudflare(raw), request, context.provider, {
          requiredUsage: true,
          requiredMetrics: true,
        }),
    };
  },
};
const cloudflareGatewayAdapter: DecisionAdapter = {
  id: "cloudflare-gateway-system-one",
  capabilities: () => boundedCapabilities,
  prepare(input, context) {
    const request = toWire(input, context.model);
    validateWire("cloudflare-gateway", request);
    return {
      path: "/run",
      body: {
        model: context.model,
        input: { state: request.state, questions: request.questions },
      },
      decode: (raw) =>
        normalizeResponse(unwrapCloudflare(raw), request, context.provider, {
          requiredUsage: true,
          requiredMetrics: true,
        }),
    };
  },
};
export const builtinAdapters: readonly DecisionAdapter[] = [
  systemOneAdapter,
  openrouterAdapter,
  clefAdapter,
  cloudflareGatewayAdapter,
  tev1ChatAdapter,
  openaiDecisionsAdapter,
];
