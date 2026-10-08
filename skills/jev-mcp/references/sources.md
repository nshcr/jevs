# Sources and adaptation

This skill is written for Jevs MCP callers. It is not an official TypeSafe, Cloudflare, OpenRouter or OpenAI skill. The server supports explicit provider adapters; sources establish contracts only within their product and deployment scope.

## Native decision contracts

- [TypeSafe HTTP API](https://docs.typesafe.ai/api): System One text/JSON requests, three judgment primitives and model discovery.
- [TypeSafe models](https://docs.typesafe.ai/models): text, context/language boundaries and aliases.
- [TypeSafe confidence](https://docs.typesafe.ai/confidence): provider-specific distribution confidence and consequence-sensitive thresholds.
- [OpenRouter Decisions schema](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md): native Alpha endpoint and optional probability/confidence/legend fields.
- [OpenRouter models](https://openrouter.ai/docs/api/api-reference/models/get-models): decisions output-modality catalogs; protocol support still requires verification.
- [Workers AI Clef](https://developers.cloudflare.com/workers-ai/models/clef/) and [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/): native model schema, image input and limits.
- [Workers AI REST](https://developers.cloudflare.com/workers-ai/get-started/rest-api/): authentication, URL and result envelopes.
- [Cloudflare self-hosted Clef implementation](https://huggingface.co/Cloudflare/clef/blob/main/joint_schema_model.py): a Python callable, not an HTTP server; the separate clef-python runtime bridge uses its model loader, images/video frames and media_kwargs. Confidence and media scope differ from Workers API.
- [Cloudflare AI Gateway REST](https://developers.cloudflare.com/ai-gateway/usage/rest-api/): separate unified billing gateway protocol.
- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions): public beta, native text/image inputs, finite choices, ordered scores and predicates.
- [OpenAI create decision](https://developers.openai.com/api/reference/resources/decisions/methods/create): `/v1/decisions`, typed candidates, per-question refusals and native token details.
- [OpenAI changelog](https://developers.openai.com/api/docs/changelog) and [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna): 2026-10-06 beta release and the currently supported model.
- [OpenAI model directory](https://developers.openai.com/api/reference/resources/models/methods/list): account model listings, without a Decisions capability filter.
- [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision): image formats, including non-animated GIF. Endpoint-specific Decisions input restrictions still apply.

## Caller workflow references

- [Official TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md): judgment selection, batching, candidate coverage and caller-owned composition; SDK instructions are replaced with MCP usage here.
- [Documentation index](https://docs.typesafe.ai/llms.txt): targeted current TypeSafe references.
- [State](https://docs.typesafe.ai/concepts/state) and [advanced structure](https://docs.typesafe.ai/primitives/advanced): evidence, named context, structured questions and rubrics.
- [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring): keep weights in caller code.
- [Candidate extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): select supplied spans, then copy/normalize them.
- [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe): evaluate candidates under a common criterion.
- [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification): bounded branch selection.

These patterns are caller composition guidance, not evidence of equal quality across providers. General text generation, retrieval and action execution are not exposed. Test actual provider semantics, measurements and workflow outcomes before transferring thresholds or benchmark conclusions.
