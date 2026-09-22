# Capability boundaries and operation

## Inputs and model selection

The MCP covers Choice (`classify`), Score (`score`), Noul (`check`), mixed judgments and independent records. Workflow composition stays with the caller. Jev consumes text/JSON; convert images, audio, video or binaries before calling. A URL alone does not cause retrieval.

- Choice requires 2–255 options; Score requires 2–10 ordered levels. Each evaluation needs at least one judgment. IDs must be nonblank and unique across judgment groups. The JSON key and ID `__proto__` are rejected; ordinary `constructor` keys are allowed.
- Content, questions and criterion descriptions accept strings, objects, arrays or null; nested JSON supports numbers and booleans. `question` is required even when null. No raw SDK envelope is needed.
- Use the same MCP arguments for every configured backend. The server handles compatibility checks and response adaptation. If an input cannot be accepted, follow `error.action`; do not invent a replacement value or silently change its meaning.
- Model context limits and language support may vary; this guidance does not promise a fixed context budget. The MCP has no official tokenizer or exact local token admission. Reduce or partition evidence deliberately after context errors; do not truncate silently. Test judgment quality on representative content and languages.
- Model aliases can move. Preserve the returned `model`; pass a version explicitly for reproducible evaluations. `jev_list_models` may list aliases without every accepted versioned ID, so an absent version is not automatically invalid. Model descriptions and release dates may be empty when unavailable.

## Results and validation

Contract validation checks response shapes, ID/type matching, probabilities, choices and scores; it does not guarantee truth or accuracy. A contract failure rejects all judgments for the affected record. Other successful records in `assess_batch` remain usable.

Returned probabilities and scores may be rounded. Their displayed sum or weighted mean may differ slightly; preserve original values instead of normalizing them or claiming extra precision. A score is an expected rubric position; a check is a probability, not intensity. Confidence is not authorization to act.

## Scheduling, deadlines and cancellation

`assess_batch` accepts 1–32 independent records with shared judgment definitions. Record IDs and question IDs are separate namespaces. Each record has `status: "ok"` with `result`, or `status: "error"` with `error`. Inspect each record even when the top-level call succeeds; every record can fail within a successful batch envelope. Results arrive after the whole batch settles, not as a stream.

The local scheduler defaults to 4 in-flight upstream requests, 32 queued requests and a 1000ms queue wait. Server configuration may change these limits; they do not guarantee remote capacity. `LOCAL_OVERLOAD` and `QUEUE_TIMEOUT` mean no upstream request was sent for the affected record.

The SDK timeout is 30 seconds per dispatched HTTP request, excluding queue time. It is not a deadline for an entire batch. Choose smaller batches or a suitable MCP host deadline. Cancellation stops unsent work and propagates to active requests. A timeout or cancellation does not prove upstream work was never performed or billed. The server never retries automatically.

## Error recovery

First check top-level `isError`. Server failures return JSON text with `{error: {code, message, action, retry}}`; HTTP failures also include `status`, and applicable service failures may include `retryAfterMs`. These failures have no success `structuredContent`. MCP SDK input validation errors may instead be plain text.

For a successful `assess_batch` envelope, inspect each record's `status` and apply the same recovery rules to its `error` object. Retry only eligible failed records. Never convert an error or missing result into a negative judgment.

| Code                               | Caller action                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| NOT_CONFIGURED / ACCESS_DENIED     | Fix server credentials or permissions; restart after changing configuration.                                      |
| INVALID_REQUEST                    | Revise the model, options, rubric or context as directed.                                                         |
| INVALID_RESPONSE                   | Discard judgments for the affected record; investigate the contract mismatch rather than repeating automatically. |
| RATE_LIMITED / SERVICE_UNAVAILABLE | Respect `retryAfterMs` when supplied; otherwise use bounded backoff within the caller budget.                     |
| LOCAL_OVERLOAD / QUEUE_TIMEOUT     | Reduce concurrency or batch size; retry with bounded backoff if the caller deadline permits.                      |
| TIMEOUT / CONNECTION_ERROR         | Upstream completion is unknown; consider duplicate cost before retrying.                                          |
| CANCELLED                          | Do not automatically resume a cancelled task. The client may observe local cancellation instead of a tool result. |
| UPSTREAM_ERROR / INTERNAL_ERROR    | Inspect the diagnostic and correct conditions; avoid blind retries.                                               |

`retry` is `never`, `after_backoff` or `caller_decision`. It is guidance, not an automatic operation.

## Data and local guidance

Inference sends content and questions to the remote model service configured by the server operator. The MCP does not retrieve files, persist inputs or execute returned actions. API credentials remain in server configuration.

`jev_guide` and guide resources use packaged local content without inference. Tool discovery and guidance require no API key; inference and model listing require one. Use the sources topic for official references when current Jev capability information is needed.
