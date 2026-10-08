import type { z } from "zod";
import type { Assessment } from "./tasks.ts";
import type {
  outputSchema,
  modelsSchema,
  providerSchema,
  capabilitiesSchema,
} from "./contracts.ts";

// The application contract owns no SDK, HTTP endpoint or wire question type.
export type AssessmentResult = z.infer<typeof outputSchema>;
export type ModelCatalog = z.infer<typeof modelsSchema>;
export type ProviderDescription = z.infer<typeof providerSchema>;
export type DecisionCapabilities = z.infer<typeof capabilitiesSchema>;
// describe(model) and evaluate(input) must select the same protocol/capabilities.
// Evaluation may report a resolved model version; an explicit response protocol
// must match the description. Omitted protocol is filled by the service.
export interface DecisionProvider {
  close?(): Promise<void> | void;
  describe(model?: string): ProviderDescription;
  evaluate(input: Assessment, signal: AbortSignal): Promise<AssessmentResult>;
  listModels(signal: AbortSignal): Promise<ModelCatalog>;
}
export const providerKinds = [
  "typesafe",
  "clef-python",
  "openai",
  "system-one",
  "openrouter",
  "cloudflare-workers",
  "cloudflare-gateway",
  "vercel",
  "zen",
  "custom",
] as const;
export type ProviderKind = (typeof providerKinds)[number];
export interface ProviderOptions {
  kind: ProviderKind;
  protocol?: string;
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  accountId?: string;
  gatewayId?: string;
  timeoutMs?: number;
  allowUnverifiedModels?: boolean;
  pythonExecutable?: string;
  pythonModelDir?: string;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

// Adapters encode one semantic assessment as one HTTP request. They own no
// credentials, retries, scheduling or policy. Extension code is trusted host code.
export interface AdapterContext {
  provider: ProviderKind;
  model: string;
}
export interface PreparedDecision {
  path: string;
  body: unknown;
  decode(raw: unknown): AssessmentResult;
}
export interface DecisionAdapter {
  id: string;
  capabilities(context: AdapterContext): DecisionCapabilities;
  prepare(input: Assessment, context: AdapterContext): PreparedDecision;
}
export interface ModelProfile {
  provider: ProviderKind;
  model: string;
  protocol: string;
  capabilities?: DecisionCapabilities;
  availability?: "supported" | "unverified" | "unsupported";
  reason?: string;
}
export interface ProviderExtensions {
  adapters?: readonly DecisionAdapter[];
  models?: readonly ModelProfile[];
}
