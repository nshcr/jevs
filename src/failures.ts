export class ProviderConfigurationError extends Error {}
export class ProviderInputError extends Error {}
export class ResponseContractError extends Error {}
export class RequestCancelledError extends Error {}
export class RequestTimeoutError extends Error {}
export class ConnectionError extends Error {}
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly upstreamCode?: string,
  ) {
    super(`Model service returned HTTP ${status}.`);
  }
}
