import { RequestScheduler, type SchedulerOptions } from "./scheduler.ts";
import { batchOutputSchema, runBatch } from "./batch.ts";
import { isVercel, isZen, validateProviderRequest } from "./provider.ts";
import packageInfo from "../package.json";
import { z } from "zod";
import { toolError } from "./errors.ts";
import { registerGuidance } from "./guidance.ts";
import {
  validateResponse,
  outputSchema,
  modelsSchema,
  ResponseContractError,
} from "./contracts.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  batchSchema,
  classifySchema,
  scoreSchema,
  checkSchema,
  structureSchema,
  toRequest,
  toResult,
  type Assessment,
} from "./tasks.ts";

export function createServer(
  source: TypeSafeClient | (() => TypeSafeClient),
  options: Partial<SchedulerOptions> = {},
) {
  const scheduler = new RequestScheduler(options);
  const getClient = () => (typeof source === "function" ? source() : source);
  const server = new McpServer(
    { name: packageInfo.name, version: packageInfo.version },
    {
      instructions:
        "Read jev_guide for examples and capability guidance when unfamiliar with Jev. Use classify, score, or check for focused judgments; use assess_structure to batch mixed judgments sharing content. Questions, options, levels and yes/no definitions accept JSON structure. Use assess_batch for separate records sharing a rubric; inspect each record status. Results are independent; compose decisions in caller code. A check probability is not a boolean or confidence score.",
    },
  );
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  };
  async function evaluate(input: Assessment, signal: AbortSignal) {
    const request = toRequest(input);
    const client = getClient();
    validateProviderRequest(client.baseURL, request);
    const raw = await scheduler.run(
      () => client.systemOne(request, { signal }),
      signal,
    );
    const response = validateResponse(
      raw,
      request.questions,
      isZen(client.baseURL) || isVercel(client.baseURL),
    );
    return outputSchema.parse(toResult(response));
  }
  async function assess(input: Assessment, signal: AbortSignal) {
    try {
      const result = await evaluate(input, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  }
  server.registerTool(
    "assess_batch",
    {
      description:
        "Apply shared classifications, scores and checks independently to 1–32 records with separate content. Uses bounded concurrent upstream calls, one per record. For ONE shared context use assess_structure instead. Inspect each record status; an error is not a negative judgment. Retry failed records only when their error allows it.",
      inputSchema: batchSchema,
      outputSchema: batchOutputSchema,
      annotations,
    },
    async (input, extra) => {
      const result = await runBatch(
        input,
        scheduler.options.concurrency,
        extra.signal,
        evaluate,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
  server.registerTool(
    "classify",
    {
      description:
        "Classify content using named options (Choice). Batch multiple items. Questions and option descriptions may be structured JSON, including taxonomy subtrees. Sends content to TypeSafe AI.",
      inputSchema: classifySchema,
      outputSchema,
      annotations,
    },
    (input, extra) =>
      assess(
        {
          content: input.content,
          model: input.model,
          classifications: input.items,
        },
        extra.signal,
      ),
  );
  server.registerTool(
    "score",
    {
      description:
        "Score content against ordered levels (Score). Batch multiple dimensions. Questions and levels may be structured JSON. Returns fractional zero-based score and confidence. Sends content to TypeSafe AI.",
      inputSchema: scoreSchema,
      outputSchema,
      annotations,
    },
    (input, extra) =>
      assess(
        { content: input.content, model: input.model, scores: input.items },
        extra.signal,
      ),
  );
  server.registerTool(
    "check",
    {
      description:
        "Check conditions (Noul). Batch multiple items with optional structured yes/no definitions. Returns a yes probability, not a boolean; no separate confidence. Sends content to TypeSafe AI.",
      inputSchema: checkSchema,
      outputSchema,
      annotations,
    },
    (input, extra) =>
      assess(
        { content: input.content, model: input.model, checks: input.items },
        extra.signal,
      ),
  );
  server.registerTool(
    "assess_structure",
    {
      description:
        "Assess shared content with mixed classifications, scores and checks in ONE request. All questions and rubrics accept text or JSON objects/arrays/null. Use for structured field verification or multidimensional judgments. Does not generate arbitrary JSON or perform dependent steps. Sends content to TypeSafe AI.",
      inputSchema: structureSchema,
      outputSchema,
      annotations,
    },
    (input, extra) => assess(input, extra.signal),
  );
  server.registerTool(
    "jev_list_models",
    {
      description: "List models available to the configured TypeSafe account.",
      inputSchema: z.strictObject({}),
      outputSchema: modelsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (_, extra) => {
      try {
        // Keep SDK transport, authentication and HTTP errors, but validate the
        // full catalog here: SDK unwrapModels can throw before our schema runs.
        const raw = await scheduler.run(async () => {
          const response = await getClient()
            .models.list({ signal: extra.signal })
            .asResponse();
          try {
            return await response.json();
          } catch {
            throw new ResponseContractError();
          }
        }, extra.signal);
        const parsed = modelsSchema.safeParse(raw);
        if (!parsed.success) throw new ResponseContractError();
        const { models } = parsed.data;
        return {
          content: [{ type: "text", text: JSON.stringify({ models }) }],
          structuredContent: { models },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  registerGuidance(server);
  return server;
}
