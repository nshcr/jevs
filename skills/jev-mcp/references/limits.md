# Capability boundaries and operation

## Model and input boundaries

Query provider_info with the selected model. Unknown models are unverified and blocked unless explicitly allowed per call or by the host; overrides never bypass unsupported status or capabilities. toolSupport describes the five evaluation tools, while discovery retains their union. Catalog source/completeness describe discovery, not account inference.

| Provider/protocol            | Known boundaries                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| TypeSafe/System One gateways | Jev text/JSON; model profiles declare option/level limits                                                                              |
| OpenAI Decisions             | 2–255 typed choices, up to 128 inline PNG/JPEG/WebP/non-animated GIF images; user messages, detail, safety identifier and score labels |
| Workers Clef                 | 1–64 questions, 2–255 choices, 2–10 levels, up to four PNG/JPEG/WebP images                                                            |
| Tev1 chat                    | One classification, 2–24 nonempty text descriptions and a text question; no confidence or images                                       |
| Clef Python                  | Legacy content, embedded images/video frames and mediaOptions; no OpenAI-specific metadata/messages or boolean candidates              |

No undocumented question/score-level limit is copied to OpenAI. Workers image limits are 4 MiB decoded/16 MP each, 8 MiB decoded total and 13 MiB request; local adapters check byte constraints, Workers checks pixels. HTTP adapters do not inspect GIF frames; local Pillow rejects animated images. A base64 placeholder is not usable media, and URLs/files are not retrieved.

Each evaluation needs judgments with unique nonblank IDs, excluding `__proto__`; the same key is rejected inside JSON. Content/messages are exclusive, and messages cannot accompany top-level images/videos. At least one option/level is required globally; provider rules can require more. Typed candidates are unique by value and type. Score labels must match levels; safetyIdentifier is string up to 128 characters or null. Unsupported fields are rejected before execution.

There is no exact local tokenizer admission. Revise or partition evidence deliberately after context-limit errors; no silent truncation occurs. Preserve actual model IDs because aliases can move.

## Local runtime

clef-python binds an operator-configured trusted release directory, interpreter and selector (default clef). Tool input cannot change them. Python/Pillow/torch/transformers and local weights are deployment dependencies; no automatic installation or download occurs.

Videos contain one or more ordered embedded frames per clip; Pillow decodes them. mediaOptions maps official media processor kwargs, not a raw wire envelope or code loader. Python evaluations are serial; the deadline includes internal waiting, loading and inference. Queued expiry/cancellation removes only that request; active expiry/cancellation terminates the worker, requiring a reload on later calls. Workers HTTP does not inherit these media capabilities.

## Results

Validation checks identities, types, candidates and necessary shape. Numeric values pass through without clamping, normalization, rounding or recomputation; missing measurements stay missing. Usage.cost has no inferred currency/unit. A shape error rejects the entire affected record while preserving other batch records.

Refusal means that particular judgment is unanswered; retain other answers and do not substitute false, zero or a retryable failure. A batch record with refusals can still have status ok. Scores use provider semantics; System One and OpenAI return zero-based rubric positions, possibly fractional. Keep typed choice values and score labels. Checks do not convert probability to boolean, or boolean to calibrated probability. Confidence requires per-model calibration and grants no authorization.

## Scheduling, deadlines and cancellation

`assess_batch` accepts 1–32 records with shared judgments. Record IDs and question IDs are separate namespaces. Each record has `status: "ok"` with `result`, or `status: "error"` with `error`. Inspect each record even when the top-level call succeeds; every record can fail within a successful batch envelope. Results arrive after the whole batch settles, not as a stream.

The local scheduler defaults to four in-flight requests, 32 queued requests and a 1000ms queue wait. Server configuration may change these limits; they do not guarantee remote capacity. `LOCAL_OVERLOAD` and `QUEUE_TIMEOUT` mean no upstream request was sent for the affected record.

`JEVS_REQUEST_TIMEOUT_MS` defaults to 30000ms per HTTP request or local-runtime evaluation, excluding the MCP scheduler's queue time. The Python provider's own serial wait remains included. The server makes no automatic retries; gateways may have independent policies. This is not a deadline for an entire batch. Choose smaller batches or a suitable host deadline. Cancellation stops unsent work and propagates to active requests. A timeout or cancellation does not prove upstream work was never performed or billed.

## Error recovery

First check top-level `isError`. Server failures return JSON text with `{error: {code, upstreamCode?, message, action, retry}}`; HTTP failures also include `status`, and applicable failures may include `retryAfterMs`. `code` is the MCP category; `upstreamCode` is included when a provider body has a recognizable code. The rest of the body is not echoed. Failures have no success `structuredContent`. MCP SDK input validation errors may be plain text.

For a successful batch envelope, inspect each record's `status` and apply the same recovery rules. Retry only eligible failed records. Never convert an error or missing result into a negative judgment.

| Code                               | Caller action                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| NOT_CONFIGURED / ACCESS_DENIED     | Fix provider configuration, credentials or permissions; restart after configuration changes.                    |
| INVALID_REQUEST                    | Revise model protocol, capabilities, options, rubric or evidence as directed.                                   |
| INVALID_RESPONSE                   | Discard judgments for the affected record; investigate rather than repeating automatically.                     |
| RATE_LIMITED / SERVICE_UNAVAILABLE | Check quota/capacity reasons, respect retryAfterMs, and bound backoff by caller budget.                         |
| LOCAL_OVERLOAD / QUEUE_TIMEOUT     | Reduce concurrency or batch size; retry with bounded backoff if the deadline permits.                           |
| TIMEOUT / CONNECTION_ERROR         | Upstream completion is unknown; consider duplicate cost before retrying.                                        |
| CANCELLED                          | Do not automatically resume cancelled work. The client may observe local cancellation instead of a tool result. |
| UPSTREAM_ERROR / INTERNAL_ERROR    | Correct conditions using diagnostics; avoid blind retries.                                                      |

`retry` is `never`, `after_backoff` or `caller_decision`. It is guidance, not an operation. A 429 can indicate exhausted quota rather than a transient condition.

## Data and local guidance

Remote inference sends content, questions and supplied images to the configured provider; clef-python processes supplied images/video frames in the configured local runtime. The MCP does not retrieve files, persist inputs or execute returned actions. API credentials remain in server configuration.

`decision_guide`, `provider_info` and guide resources use local content without inference. Tool discovery and guidance require no API key. Model listing may use either a remote request or a configured catalog; neither proves successful account inference. Read sources for official references.
