import { z } from "zod";
import { APIUserAbortError } from "@typesafe-ai/sdk";
import { errorDetails, errorSchema } from "./errors.ts";
import { outputSchema } from "./contracts.ts";
import { batchSchema, type Assessment } from "./tasks.ts";

const recordResultSchema = z.discriminatedUnion("status", [
  z.object({ id: z.string(), status: z.literal("ok"), result: outputSchema }),
  z.object({ id: z.string(), status: z.literal("error"), error: errorSchema }),
]);
export const batchOutputSchema = z.object({
  records: z.array(recordResultSchema),
});
export async function runBatch(
  input: z.infer<typeof batchSchema>,
  concurrency: number,
  signal: AbortSignal,
  evaluate: (
    input: Assessment,
    signal: AbortSignal,
  ) => Promise<z.infer<typeof outputSchema>>,
) {
  const { records, ...questions } = input;
  const results: z.infer<typeof recordResultSchema>[] = new Array(
    records.length,
  );
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      const record = records[index];
      if (!record) return;
      try {
        if (signal.aborted) throw new APIUserAbortError();
        const result = await evaluate(
          { ...questions, content: record.content },
          signal,
        );
        results[index] = { id: record.id, status: "ok", result };
      } catch (error) {
        results[index] = {
          id: record.id,
          status: "error",
          error: errorDetails(error),
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, records.length) }, worker),
  );
  return { records: results };
}
