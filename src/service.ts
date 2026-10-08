import { outputSchema, modelsSchema, safeJson } from "./contracts.ts";
import type { DecisionProvider } from "./decision.ts";
import { ProviderInputError, ResponseContractError } from "./failures.ts";
import { RequestScheduler, type SchedulerOptions } from "./scheduler.ts";
import type { Assessment } from "./tasks.ts";
import { validateAssessment, validateModelAdmission } from "./capabilities.ts";
import { optionEntries } from "./choices.ts";

export class DecisionService {
  readonly scheduler: RequestScheduler;
  private current?: DecisionProvider;
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private readonly source: DecisionProvider | (() => DecisionProvider),
    options: Partial<SchedulerOptions> = {},
  ) {
    this.scheduler = new RequestScheduler(options);
  }
  provider() {
    if (this.closed)
      throw new ProviderInputError("Decision service is closed.");
    return (this.current ??=
      typeof this.source === "function" ? this.source() : this.source);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const provider =
      this.current ??
      (typeof this.source === "function" ? undefined : this.source);
    return (this.closing = Promise.resolve().then(() => provider?.close?.()));
  }
  async evaluate(input: Assessment, signal: AbortSignal) {
    const provider = this.provider();
    const description = provider.describe(input.model);
    validateModelAdmission(input, description);
    validateAssessment(input, description.capabilities);
    const expected = [
      ...(input.classifications ?? []).map((q) => ({
        ...q,
        kind: "classification",
      })),
      ...(input.scores ?? []).map((q) => ({ ...q, kind: "score" })),
      ...(input.checks ?? []).map((q) => ({ ...q, kind: "check" })),
    ];
    const raw = await this.scheduler.run(
      () => provider.evaluate(input, signal),
      signal,
    );
    const parsed = safeJson(outputSchema).safeParse(raw);
    if (!parsed.success) throw new ResponseContractError();
    const result = parsed.data;
    if (
      result.provider !== description.provider ||
      (result.protocol !== undefined &&
        result.protocol !== description.protocol) ||
      result.results.length !== expected.length ||
      new Set(result.results.map((q) => q.id)).size !== expected.length
    )
      throw new ResponseContractError();
    for (const q of expected) {
      const answer = result.results.find((a) => a.id === q.id);
      if (!answer) throw new ResponseContractError();
      if (answer.kind === "refusal") {
        if (!description.capabilities.refusals || answer.judgment !== q.kind)
          throw new ResponseContractError();
        continue;
      }
      if (answer.kind !== q.kind) throw new ResponseContractError();
      if (answer.kind === "classification") {
        const question = input.classifications!.find(
          (item) => item.id === q.id,
        )!;
        if (
          !optionEntries(question.options).some(
            (option) => option.value === answer.value,
          )
        )
          throw new ResponseContractError();
      }
    }
    return { ...result, protocol: description.protocol };
  }
  async listModels(signal: AbortSignal) {
    const provider = this.provider();
    const raw = await this.scheduler.run(
      () => provider.listModels(signal),
      signal,
    );
    const parsed = safeJson(modelsSchema).safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.provider !== provider.describe().provider
    )
      throw new ResponseContractError();
    return parsed.data;
  }
}
