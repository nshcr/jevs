import type { SchedulerOptions } from "./scheduler.ts";
import { DecisionService } from "./service.ts";
import type { DecisionProvider } from "./decision.ts";
import { batchOutputSchema, runBatch } from "./batch.ts";
import packageInfo from "../package.json";
import { z } from "zod";
import { toolError } from "./errors.ts";
import { registerGuidance } from "./guidance.ts";
import { outputSchema, modelsSchema, providerSchema } from "./contracts.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  batchSchema,
  classifySchema,
  scoreSchema,
  checkSchema,
  structureSchema,
  type Assessment,
} from "./tasks.ts";

export function createServer(
  source: DecisionProvider | (() => DecisionProvider),
  options: Partial<SchedulerOptions> = {},
) {
  const service = new DecisionService(source, options);
  const server = new McpServer(
    { name: packageInfo.name, version: packageInfo.version },
    {
      instructions:
        "Read decision_guide for examples and provider_info with the selected model for availability, toolSupport and evidence capabilities. Unverified models require explicit allowUnverifiedModel or host configuration. Unsupported capabilities are always rejected. Use classify, score, or check for focused judgments; use assess_structure to batch mixed judgments sharing content. Questions, options, levels and yes/no definitions accept JSON structure. Typed options and per-question refusals depend on provider capabilities; inspect each result kind. Use assess_batch for separate records sharing a rubric; inspect each record status. Results are independent; compose decisions in caller code. A check probability is not a boolean or confidence score.",
    },
  );
  const sdkClose = server.close.bind(server);
  server.close = async () => {
    await sdkClose();
    await service.close();
  };
  server.server.onclose = () => {
    void service.close().catch(() => {});
  };
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  };
  const evaluate = (input: Assessment, signal: AbortSignal) =>
    service.evaluate(input, signal);
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
        service.scheduler.options.concurrency,
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
        "Classify content using named options or typed {value,description?} choices. Boolean values require typedChoices capability and remain distinct from strings. Batch multiple items. Questions and option descriptions may be structured JSON, including taxonomy subtrees. Inspect result kind for per-question refusal. Sends content to the configured provider.",
      inputSchema: classifySchema,
      outputSchema,
      annotations,
    },
    ({ items, ...context }, extra) =>
      assess({ ...context, classifications: items }, extra.signal),
  );
  server.registerTool(
    "score",
    {
      description:
        "Score content against ordered levels (Score). Batch multiple dimensions. Questions and levels may be structured JSON. Returns a zero-based rubric position; confidence and distributions are present only if supplied by the provider. Sends content to the configured provider.",
      inputSchema: scoreSchema,
      outputSchema,
      annotations,
    },
    ({ items, ...context }, extra) =>
      assess({ ...context, scores: items }, extra.signal),
  );
  server.registerTool(
    "check",
    {
      description:
        "Check conditions with optional structured yes/no definitions. Returns a provider-reported yes probability or boolean value; missing measurements stay absent. Never treat a probability as a boolean or authorization. Sends content to the configured provider.",
      inputSchema: checkSchema,
      outputSchema,
      annotations,
    },
    ({ items, ...context }, extra) =>
      assess({ ...context, checks: items }, extra.signal),
  );
  server.registerTool(
    "assess_structure",
    {
      description:
        "Assess shared content with mixed classifications, scores and checks in ONE request. All questions and rubrics accept text or JSON objects/arrays/null. Use for structured field verification or multidimensional judgments. Does not generate arbitrary JSON or perform dependent steps. Sends content to the configured provider.",
      inputSchema: structureSchema,
      outputSchema,
      annotations,
    },
    (input, extra) => assess(input, extra.signal),
  );
  server.registerTool(
    "list_models",
    {
      description:
        "Discover decision models for the configured provider. Inspect availability, protocol, capabilities, source and completeness; catalog membership is not proof of account access or compatible inference.",
      inputSchema: z.strictObject({}),
      outputSchema: modelsSchema,
      annotations: { ...annotations, idempotentHint: true },
    },
    async (_, extra) => {
      try {
        const result = await service.listModels(extra.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "provider_info",
    {
      description:
        "Resolve a selected model's protocol and capabilities locally, without inference or an API key. Omit model for the configured default. Inspect availability and capabilitySource: a protocol baseline is not verified model support. Confidence semantics are model-defined.",
      inputSchema: z.strictObject({
        model: z.string().trim().min(1).optional(),
      }),
      outputSchema: providerSchema,
      annotations: {
        ...annotations,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const result = providerSchema.parse(
          service.provider().describe(input.model),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  registerGuidance(server);
  return server;
}
