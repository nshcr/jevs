---
name: jev-mcp
description: Use Jevs MCP for finite-answer classification, scoring and checks across configured decision providers, preserving their capabilities and optional measurements.
---

# Use decision models through MCP

Use installed tool names (hosts may prefix them). Credentials belong in server configuration. Models judge supplied evidence; they do not retrieve URLs, invent extracted values or execute actions.

## Select a model and tool

Call `provider_info` with the same optional `model` you will evaluate. It reports protocol, capabilities, `availability`, `capabilitySource`, five-tool `toolSupport` and host `unverifiedModelsAllowed`. Discovery lists all tools so a call can choose another model; inspect the selected model rather than inferring support from tool presence.

Unverified models are blocked by default. After checking their protocol, explicitly attempt one with `allowUnverifiedModel: true` or host `JEVS_ALLOW_UNVERIFIED_MODELS=true`. This never bypasses unsupported models, inputs or limits. `list_models({})` reports remote/configured source and catalog completeness; neither catalog entries nor supported status prove account access or model quality.

Single-context tools take `content` or `messages`, the following groups and optional `model`:

- `classify`: `items: [{id, question, options}]`. Options are a label-description map or `[{value, description?}]`; boolean values require `typedChoices: true`. Preserve `true` versus `"true"`; include no-match when needed.
- `score`: `items: [{id, question, levels, levelLabels?}]`. Describe each ordered level independently; native labels require `labeledScores: true` and one label per level.
- `check`: `items: [{id, question, yes?, no?}]`. Use separate checks for independent labels.
- `assess_structure`: combine `classifications?`, `scores?`, `checks?` using these item shapes.
- `assess_batch`: use 1–32 `records: [{id, content?, messages?, images?, videos?, mediaOptions?}]` with shared groups. Model, unverified-model override and safetyIdentifier are shared metadata.

Omit model for the server default. Each evaluation needs at least one judgment; IDs must be nonblank and unique across groups. `__proto__` is rejected as an ID or JSON key; record IDs have a separate namespace. Option/level minima and maxima are model-specific. Tev1 accepts one classification with 2–24 nonempty text descriptions and a text question, without confidence. Do not silently convert judgments or split multi-question requests.

## Supply evidence

Every record supplies exactly one of content/messages. Content, questions and descriptions accept text, JSON objects/arrays or null; nested JSON permits numbers and booleans. Refer explicitly to named evidence. OpenAI serializes JSON entries as text; unsupported forms on other providers produce errors rather than automatic substitutions.

For example, call `check`:

```json
{
  "content": { "message": "Please refund the duplicate charge." },
  "items": [{ "id": "refund", "question": "Does `message` request a refund?" }]
}
```

Ordered messages use `[{parts: [{type: "text", text}, {type: "image", image}]}]`, require `messages: true`, and cannot accompany content or top-level images/videos. They preserve user-message/part order, with no arbitrary roles or tool history. Optional image-object detail and safetyIdentifier require their capabilities; detail is low/high/auto/original/null, safetyIdentifier is a string up to 128 characters or null.

Embed supported data URLs or `{content_type, base64, detail?}`. OpenAI supports PNG/JPEG/WebP/non-animated GIF; Workers Clef supports PNG/JPEG/WebP. Remote URLs are not fetched. Only local clef-python supports `videos: [{frames: ImageInput[]}]` and JSON mediaOptions, mapping ordered PIL frames and official media_kwargs. It requires legacy content and rejects messages, image detail, safety identifiers, named score labels and boolean choices. See [limits](references/limits.md) for provider limits and runtime behavior.

Group independent judgments sharing evidence. If one answer determines later evidence or choices, construct a later call. Batch separate records sharing a rubric; it evaluates each record independently and returns after all settle.

## Read results

Check top-level `isError`, then associate results by ID:

- classification: string/boolean value; optional confidence and probabilities, as a label map or typed `[{value, probability}]` array.
- score: numeric value, possibly a fractional zero-based rubric position; optional confidence, levels, probabilities and native `levelProbabilities: [{value, label, probability}]`. Keep the input rubric.
- check: yes probability and/or boolean value. Missing probability is not zero; a boolean is not a calibrated probability.
- refusal: `{id, kind: "refusal", judgment}` is an unanswered question, with no value/score/probability. Handle it separately and retain other answers.

Preserve provider, protocol and actual model, plus optional responseId/upstreamProvider/usage. Missing counters remain missing; OpenAI can supply cachedInputTokens, cacheWriteTokens, reasoningTokens and totalTokens. Do not infer cost units or compare confidence thresholds across models without calibration.

For batches, inspect every record: status ok contains result, error contains error. An ok result may include refusals; even all failed records can occur in a successful batch envelope. Retry only eligible failures. Server errors report code/action/retry in JSON text; SDK input errors may be plain text. Invalid responses require investigation, not automatic repetition. Recovery and deadlines are in [limits](references/limits.md).

Keep arithmetic, evidence requirements, policies and execution in caller code. Confidence is neither proof nor action permission.

## References

- [Patterns](references/patterns.md): ranking, extraction, routing and caller composition.
- [Examples](references/examples.json): payloads for the five evaluation tools; check model constraints.
- [Limits](references/limits.md): validation, operation and recovery.
- [Sources](references/sources.md): provider contracts and workflow references.

Use `decision_guide` topics overview/patterns/examples/limits/sources or `jevs://guide/<topic>` when these files are unavailable. Guidance is local and requires no model credential.
