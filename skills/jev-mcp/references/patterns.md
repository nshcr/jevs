# Composing Jev tools

These patterns keep the caller in control. Use the examples topic for runnable payloads.

## Multi-label detection

Use one check per label when multiple labels can apply. A classify item picks exactly one alternative; its probabilities compete and are not independent label probabilities. Apply per-label thresholds outside Jev.

## Candidate selection and extraction

Find candidate spans from the source first using caller-side parsing or retrieval. Put candidates in classify options, with stable IDs and source spans in their descriptions. Include a no-match option; after selection copy the original candidate value rather than asking Jev to invent it. Candidate recall bounds extraction recall. Check source presence separately when useful. Use assess_structure to select a value and judge its attributes in one call when independent.

## Ranking

For graded relevance, give each candidate a score item with the same rubric, then sort by value in caller code. For an exact condition such as whether a passage supports a specified rule, a check per candidate is appropriate. Put a short list in shared content and reference each candidate explicitly; keep retrieval and final sorting outside the tools. For isolated candidate/query pairs sharing a rubric, use `assess_batch`: put each pair in a record and reference the same field names in the shared question. Use separate calls when rubrics differ. A single Choice distribution selects among alternatives; it is not a general-purpose relevance score for each item.

## Hierarchical classification

Classify among the current node's children, including subtree descriptions where useful. Then construct the next call using selected branches. A beam can retain multiple plausible paths; batch independent branch questions at each depth. Define a depth limit, leaf stopping condition and uncertainty handling in the caller. A subtree supplied as an option is context, not an instruction to automatically walk that tree. Do not compare path products of different depths as though they had identical meaning.

## Composite scoring and routing

Score independent dimensions together. For a rubric of length L, value/(L-1) puts its expected position on 0–1; reverse direction if that dimension means cost rather than benefit. Combine comparable dimensions using caller-defined weights. Keep veto conditions as checks rather than averaging serious violations away. Changing weights need not rerun Jev if evidence and rubric meanings are unchanged.

Use classify to select an allowed handler and other items to select known arguments. Include explicit premises in branch-specific questions, then use only the selected branch's answers. Selecting a function does not execute it or grant authorization.

## Evidence verification and cascades

Supply a claim or proposed field value alongside source evidence and ask a focused check or classification. Distinguish unsupported, contradicted and supported if that distinction matters. Escalate to more evidence, a person or a reasoning model when uncertainty matters to the decision. The tool provides a judgment, not a citation span it has independently retrieved. Keep source links and extraction provenance in caller data.

Separate observations from inferred claims. Include an insufficient-evidence outcome when needed, and enforce deterministic evidence requirements in caller code. Missing fields alone need not prevent a judgment if the remaining evidence is sufficient.

## Uncertainty and changing state

Several acceptable alternatives can spread probability without making a harmless preference choice unusable. Apply consequence-sensitive thresholds to the answers actually used; ignore uncertainty on unused branches. A check near 0.5 indicates similar probabilities for yes and no, not moderate intensity.

Associate results with the evidence snapshot or revision that produced them. Before applying a judgment to changing state, check whether relevant facts or criteria changed; if they did, reassess using current evidence. Keep observed facts separate from inferred state, and let the caller bound each next step.

## Validate the composed workflow

Test representative inputs and the resulting behavior, not just whether the tool returns valid JSON. For a failure, inspect the exact content, questions, candidate coverage, answers, caller composition and observed outcome. Distinguish missing evidence, semantic misjudgment, caller logic errors and service failures before choosing a remedy.

Independent-question and record batching follow the entry guide. Extra judgments still consume budget: measure usage and end-to-end latency. Reduce irrelevant context or split independent work while retaining the evidence each judgment needs.
