import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import overview from "../skills/jev-mcp/SKILL.md" with { type: "text" };
import patterns from "../skills/jev-mcp/references/patterns.md" with { type: "text" };
import limits from "../skills/jev-mcp/references/limits.md" with { type: "text" };
import sources from "../skills/jev-mcp/references/sources.md" with { type: "text" };
import examples from "../skills/jev-mcp/references/examples.json";

export const guidance = {
  overview,
  patterns,
  limits,
  sources,
  examples: JSON.stringify(examples, null, 2),
};
const topicSchema = z.enum([
  "overview",
  "patterns",
  "examples",
  "limits",
  "sources",
]);
export function registerGuidance(server: McpServer) {
  server.registerTool(
    "jev_guide",
    {
      description:
        "Read local Jev usage guidance without inference or token cost. Start with overview; examples contains ready-to-call tool payloads, patterns covers ranking/extraction/composition, limits explains boundaries. Use when unfamiliar with Jev.",
      inputSchema: z.strictObject({ topic: topicSchema.default("overview") }),
      outputSchema: z.object({ topic: topicSchema, text: z.string() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ topic }) => {
      const result = { topic, text: guidance[topic] };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
  for (const topic of topicSchema.options) {
    server.registerResource(
      `jev-guide-${topic}`,
      `jevs://guide/${topic}`,
      {
        description: `Jev MCP caller guidance: ${topic}`,
        mimeType: topic === "examples" ? "application/json" : "text/markdown",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType:
              topic === "examples" ? "application/json" : "text/markdown",
            text: guidance[topic],
          },
        ],
      }),
    );
  }
}
