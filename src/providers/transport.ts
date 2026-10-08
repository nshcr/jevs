import {
  ConnectionError,
  ProviderConfigurationError,
  ProviderHttpError,
  RequestCancelledError,
  RequestTimeoutError,
  ResponseContractError,
} from "../failures.ts";
import type { ProviderOptions } from "../decision.ts";
import { rejectPrototypeKeys } from "../json.ts";
export function createTransport(options: ProviderOptions) {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new ProviderConfigurationError("Set a positive request timeout.");
  return async (
    url: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> => {
    if (signal.aborted) throw new RequestCancelledError("Request cancelled.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let abort!: () => void;
    const interruption = new Promise<never>((_, reject) => {
      abort = () => {
        reject(new RequestCancelledError("Request cancelled."));
        controller.abort();
      };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        reject(new RequestTimeoutError("Model request timed out."));
        controller.abort();
      }, timeout);
    });
    const operation = async () => {
      const headers = new Headers({ accept: "application/json" });
      if (options.apiKey)
        headers.set("authorization", `Bearer ${options.apiKey}`);
      if (body !== undefined) headers.set("content-type", "application/json");
      if (options.kind.startsWith("cloudflare") && options.gatewayId)
        headers.set("cf-aig-gateway-id", options.gatewayId);
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(url, {
          method: body === undefined ? "GET" : "POST",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        throw new ConnectionError("Unable to connect to the model service.");
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new ConnectionError("Unable to read the model response.");
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        if (response.ok)
          throw new ResponseContractError(
            "Model service returned invalid JSON; no results were accepted.",
          );
      }
      if (!response.ok) {
        const v = value as
          | {
              error?: { code?: unknown };
              errors?: { code?: unknown }[];
              code?: unknown;
            }
          | undefined;
        const code = v?.error?.code ?? v?.errors?.[0]?.code ?? v?.code;
        const safeCode =
          (typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(code)) ||
          (typeof code === "number" && Number.isFinite(code))
            ? String(code)
            : undefined;
        throw new ProviderHttpError(
          response.status,
          response.headers,
          safeCode,
        );
      }
      rejectPrototypeKeys(value);
      return value;
    };
    try {
      return await Promise.race([operation(), interruption]);
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener("abort", abort);
    }
  };
}
