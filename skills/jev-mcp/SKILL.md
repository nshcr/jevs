---
name: jev-mcp
description: Use Jev MCP for classification, scoring, condition checks and composed semantic decisions when an agent needs typed judgments and probabilities.
---

# Use Jev through MCP

Use installed tool names (hosts may prefix them). Authentication belongs in server configuration, never tool arguments. Jev judges supplied evidence; it does not generate prose, retrieve URLs, invent extracted values or execute actions.

## Choose a tool

Single-context tools take `content`, the listed groups, and optional `model`:

- `classify`: `items: [{id, question, options}]` selects one label. `options` maps 2–255 labels to descriptions; include no-match when needed.
- `score`: `items: [{id, question, levels}]` uses 2–10 ordered levels, each independently describing a concrete situation.
- `check`: `items: [{id, question, yes?, no?}]` estimates whether a condition holds. Use separate checks for independent labels.
- `assess_structure`: combine `classifications?`, `scores?`, `checks?`, using the corresponding item shapes above.
- `assess_batch`: replace shared `content` with `records: [{id, content}]` (1–32 records); supply shared `classifications?`, `scores?`, `checks?` and optional `model`.

Omit `model` for the server default. Call `jev_list_models` with `{}` when model discovery is needed; it requires credentials and may omit accepted versioned IDs.

## Build a request

Put evidence in `content` and the judgment in `question`; refer explicitly to named evidence fields. Content, questions and criterion descriptions accept text, JSON objects/arrays or null; numbers and booleans are allowed only inside JSON. Preserve useful structured definitions and policies. IDs identify results, not question meanings.

Each evaluation needs at least one judgment. IDs must be nonblank and unique across groups; `__proto__` is rejected as an ID or JSON key. Batch record IDs have a separate namespace. `question` is required but may be null when criteria fully define the judgment.

Example `check` arguments:

```json
{
  "content": { "message": "Please refund the duplicate charge." },
  "items": [{ "id": "refund", "question": "Does `message` request a refund?" }]
}
```

Group independent judgments over the same evidence; items cannot see each other's answers. If an answer determines the next evidence or options, make a later call. Use `assess_batch` for independent records sharing a rubric, not concatenated unrelated evidence. It sends one upstream request per record and returns after all settle; use smaller batches for interactive latency.

## Consume results

Check top-level `isError`, then associate `results` by `id`:

- classification: selected `value`, `probabilities`, `confidence`.
- score: zero-based expected position `value` (possibly fractional), `levels`, `probabilities`, `confidence`.
- check: `probability` of yes, not intensity or a boolean; no separate confidence.

For `assess_batch`, inspect every record's `status`: `ok` contains `result`, `error` contains `error`. Even all records failing can produce a successful envelope. Retry only eligible failed records.

Server errors contain JSON text with `error.code`, `error.action`, `error.retry`; SDK input errors may be plain text. Never interpret errors or missing results as negative judgments. Do not automatically repeat invalid responses. Read [limits](references/limits.md) for recovery, input limits and deadlines before handling those cases.

Confidence is not proof or action permission. Calibrate thresholds on representative data; keep arithmetic, evidence sufficiency, policies and execution in caller code. Preserve returned `model` and `usage` for comparisons.

## Read only the detail needed

- [Patterns](references/patterns.md): ranking, extraction, routing, composite scoring, uncertainty and changing state.
- [Examples](references/examples.json): callable payloads for all five evaluation tools.
- [Limits](references/limits.md): validation, batching, cancellation and error recovery.
- [Sources](references/sources.md): official skill and targeted model/workflow references.

Without these files, call `jev_guide` with `topic: "overview"`, `"patterns"`, `"examples"`, `"limits"` or `"sources"`. The same local, key-free guidance is available under `jevs://guide/`.
