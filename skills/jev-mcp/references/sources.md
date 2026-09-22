# Official sources and adaptation

This skill is written for MCP callers; it is not an official TypeSafe skill or a copy of its SDK integration workflow.

- [Official TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md): adapted its judgment selection, batching, candidate coverage and caller-owned composition principles. SDK installation instructions are replaced with MCP tool usage.
- [Documentation index](https://docs.typesafe.ai/llms.txt): find current targeted references.
- [State](https://docs.typesafe.ai/concepts/state): prepare evidence and named context.
- [Advanced structure](https://docs.typesafe.ai/primitives/advanced): objects and arrays in questions and rubrics.
- [Confidence](https://docs.typesafe.ai/confidence): distinguish distribution confidence from correctness and consequence-sensitive thresholds.
- [Models](https://docs.typesafe.ai/models): context budgets, modality/language boundaries and aliases.
- [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring): keep weights in caller code.
- [Candidate extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): select supplied spans, then copy/normalize them.
- [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe): judge candidates by the relevant common criterion.
- [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification): bounded multi-step branch selection.

The evaluation tools cover all three documented model primitives and their structured inputs. Derived workflows use those tools, rather than multiplying tools with overlapping semantics. General text generation, media understanding, retrieval and action execution are not Jev primitives and are not claimed as MCP capabilities.
