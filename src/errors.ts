import { z } from "zod";
import { AdmissionError } from "./scheduler.ts";
import { ProviderInputError, ProviderConfigurationError } from "./provider.ts";
import {
  APIError,
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
} from "@typesafe-ai/sdk";
import { ResponseContractError } from "./contracts.ts";
export class ConfigurationError extends Error {}

// A retry hint is caller guidance, never an automatic retry or a guarantee of no charge.
function retryDelay(headers: Headers) {
  const ms = headers.get("retry-after-ms");
  const seconds = headers.get("retry-after");
  let value: number | undefined;
  if (ms !== null && ms.trim() !== "") value = Number(ms);
  else if (seconds !== null && seconds.trim() !== "") {
    value = /^\d+(\.\d+)?$/.test(seconds.trim())
      ? Number(seconds) * 1000
      : Date.parse(seconds) - Date.now();
  }
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : undefined;
}
export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  action: z.string(),
  retry: z.enum(["never", "after_backoff", "caller_decision"]),
  status: z.number().int().optional(),
  retryAfterMs: z.number().nonnegative().optional(),
});
export function errorDetails(error: unknown): z.infer<typeof errorSchema> {
  let code = "INTERNAL_ERROR";
  let message = "Model service request failed.";
  let action =
    "Inspect server configuration or report this failure; do not retry blindly.";
  let retry: z.infer<typeof errorSchema>["retry"] = "never";
  let status: number | undefined;
  let retryAfterMs: number | undefined;
  if (error instanceof AdmissionError) {
    code = error.reason === "full" ? "LOCAL_OVERLOAD" : "QUEUE_TIMEOUT";
    message = "The local MCP request was not sent upstream.";
    action =
      "Reduce concurrent calls or batch size, then retry within the caller's latency budget. The server did not submit this request.";
    retry = "after_backoff";
  } else if (error instanceof ProviderConfigurationError) {
    code = "NOT_CONFIGURED";
    message = "Model service endpoint is not configured correctly.";
    action = error.message;
  } else if (error instanceof ProviderInputError) {
    code = "INVALID_REQUEST";
    message = "Input is not supported by the configured provider.";
    action = error.message;
  } else if (error instanceof ConfigurationError) {
    code = "NOT_CONFIGURED";
    message = "Model service credentials are not configured.";
    action =
      "Set TYPESAFE_API_KEY in the server environment and restart the server. Never pass credentials in tool arguments.";
  } else if (error instanceof ResponseContractError) {
    code = "INVALID_RESPONSE";
    message =
      "Model service returned an invalid response; no results were accepted.";
    action =
      "Report the contract failure; do not use partial results or repeat the request automatically.";
  } else if (error instanceof APIError) {
    status = error.status;
    message = `Model service returned HTTP ${status}.`;
    if (status === 401 || status === 403) {
      code = "ACCESS_DENIED";
      action = "Check the server API key and account permissions.";
    } else if (status === 400 || status === 422 || status === 404) {
      code = "INVALID_REQUEST";
      action =
        "Check model, options, rubric and context size; read jev_guide limits before revising the request.";
    } else if (status === 429 || status === 529 || status >= 500) {
      code = status === 429 ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE";
      retry = "after_backoff";
      retryAfterMs = retryDelay(error.headers);
      action =
        "Wait for retryAfterMs when provided, otherwise use bounded exponential backoff; retry only within the caller's request and cost budget.";
    } else {
      code = "UPSTREAM_ERROR";
      action =
        "Inspect the HTTP status before deciding whether to change the request.";
    }
  } else if (
    error instanceof APITimeoutError ||
    error instanceof APIConnectionError
  ) {
    code = error instanceof APITimeoutError ? "TIMEOUT" : "CONNECTION_ERROR";
    message =
      error instanceof APITimeoutError
        ? "Model service request timed out."
        : "Unable to complete model service connection.";
    retry = "caller_decision";
    action =
      "Upstream completion is unknown; repeat only if the caller accepts possible duplicate work and cost.";
  } else if (error instanceof APIUserAbortError) {
    code = "CANCELLED";
    message = "Model service request cancelled.";
    action =
      "Do not retry a cancelled task. Cancellation is not proof that upstream work was never performed.";
  }
  return {
    code,
    message,
    action,
    retry,
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}
export function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: errorDetails(error) }),
      },
    ],
  };
}
