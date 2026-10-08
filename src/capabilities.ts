import type { DecisionCapabilities, ProviderDescription } from "./decision.ts";
import { evidenceIssue, type Assessment } from "./tasks.ts";
import { ProviderInputError } from "./failures.ts";
import { optionEntries } from "./choices.ts";

export function validateModelAdmission(
  input: Assessment,
  model: ProviderDescription,
) {
  if (model.availability === "unsupported")
    throw new ProviderInputError(
      "The selected model does not support decision assessments. Read provider_info with the same model.",
    );
  if (
    model.availability === "unverified" &&
    model.unverifiedModelsAllowed !== true &&
    input.allowUnverifiedModel !== true
  )
    throw new ProviderInputError(
      "The selected model is unverified. Inspect provider_info, then set allowUnverifiedModel for this call or JEVS_ALLOW_UNVERIFIED_MODELS=true in host configuration to attempt its declared protocol.",
    );
}

export function validateAssessment(
  input: Assessment,
  cap: DecisionCapabilities,
) {
  const issue = evidenceIssue(input);
  if (issue) throw new ProviderInputError(issue);
  const images = [
    ...(input.images ?? []),
    ...(input.messages ?? []).flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "image" ? [part.image] : [],
      ),
    ),
  ];
  const allImages = [
    ...images,
    ...(input.videos ?? []).flatMap((video) => video.frames),
  ];
  if (
    (input.messages !== undefined && !cap.messages) ||
    (input.mediaOptions !== undefined && !cap.mediaOptions) ||
    (input.safetyIdentifier !== undefined && !cap.safetyIdentifier) ||
    (allImages.some(
      (image) => typeof image !== "string" && image.detail !== undefined,
    ) &&
      !cap.imageDetail) ||
    input.scores?.some(
      (q) =>
        q.levelLabels !== undefined &&
        (!cap.labeledScores || q.levelLabels.length !== q.levels.length),
    )
  )
    throw new ProviderInputError(
      "The selected model does not support these evidence options. Read provider_info with the same model.",
    );
  const kinds = [
    ...(input.classifications?.length ? ["classification" as const] : []),
    ...(input.scores?.length ? ["score" as const] : []),
    ...(input.checks?.length ? ["check" as const] : []),
  ];
  const count =
    (input.classifications?.length ?? 0) +
    (input.scores?.length ?? 0) +
    (input.checks?.length ?? 0);
  if (kinds.some((kind) => !cap.judgments.includes(kind)))
    throw new ProviderInputError(
      "The selected model does not support this judgment kind. Read provider_info with the same model.",
    );
  if (
    (!cap.mixedQuestions && kinds.length > 1) ||
    (cap.maxQuestions !== undefined && count > cap.maxQuestions)
  )
    throw new ProviderInputError(
      "The assessment exceeds the selected model's question capabilities. Read provider_info with the same model.",
    );
  if (
    input.classifications?.some((q) => {
      const options = optionEntries(q.options);
      const size = options.length;
      return (
        (!cap.typedChoices &&
          options.some((option) => typeof option.value !== "string")) ||
        (cap.minOptions !== undefined && size < cap.minOptions) ||
        (cap.maxOptions !== undefined && size > cap.maxOptions)
      );
    }) ||
    input.scores?.some(
      (q) =>
        (cap.minScoreLevels !== undefined &&
          q.levels.length < cap.minScoreLevels) ||
        (cap.maxScoreLevels !== undefined &&
          q.levels.length > cap.maxScoreLevels),
    ) ||
    (cap.maxImages !== undefined && images.length > cap.maxImages)
  )
    throw new ProviderInputError(
      "The assessment exceeds the selected model's rubric or image limits. Read provider_info with the same model.",
    );
  const modalities =
    input.messages !== undefined
      ? input.messages.flatMap((message) =>
          message.parts.map((part) =>
            part.type === "image" ? "image" : "text",
          ),
        )
      : [typeof input.content === "string" ? "text" : "json"];
  if (
    modalities.some(
      (modality) => !cap.inputs.includes(modality as "text" | "json" | "image"),
    ) ||
    (images.length && !cap.inputs.includes("image")) ||
    (input.videos?.length && !cap.inputs.includes("video"))
  )
    throw new ProviderInputError(
      "The selected model does not support this input modality. Read provider_info with the same model.",
    );
}

export function assessmentToolSupport(
  cap: DecisionCapabilities,
  availability: "supported" | "unverified" | "unsupported",
) {
  const status = (kind: "classification" | "score" | "check") =>
    cap.judgments.includes(kind) ? availability : ("unsupported" as const);
  return {
    classify: status("classification"),
    score: status("score"),
    check: status("check"),
    assess_structure: cap.judgments.length
      ? availability
      : ("unsupported" as const),
    assess_batch: cap.judgments.length
      ? availability
      : ("unsupported" as const),
  };
}
