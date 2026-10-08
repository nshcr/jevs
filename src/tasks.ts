import { z } from "zod";

import { choiceValue, entry, safeJson } from "./contracts.ts";
const id = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0 && v !== "__proto__", "Invalid identifier")
  .describe("Unique result identifier within this call.");
const question = entry.describe(
  "Focused question; accepts text, JSON object/array, or null. Preserve supporting data as JSON.",
);
export const classification = z.strictObject({
  id,
  question,
  options: safeJson(
    z.union([
      z
        .record(z.string().min(1), entry)
        .refine(
          (v) => Object.keys(v).length >= 1,
          "Provide at least 1 option; the provider may impose stricter limits",
        )
        .meta({ minProperties: 1 }),
      z
        .array(
          z.strictObject({ value: choiceValue, description: entry.optional() }),
        )
        .min(1)
        .refine(
          (v) =>
            new Set(v.map((option) => JSON.stringify(option.value))).size ===
            v.length,
          "Choice values must be unique with their original types",
        ),
    ]),
  ).describe(
    "Labels mapped to descriptions, or an array of {value,description?}. Boolean values require typedChoices capability; true and string 'true' remain distinct. Descriptions accept text, JSON or null.",
  ),
});
export const scoring = z
  .strictObject({
    id,
    question,
    levels: z
      .array(entry)
      .min(1)
      .describe(
        "Ordered levels, each text, JSON object/array, or null. Score is a zero-based expected position, possibly fractional.",
      ),
    levelLabels: z
      .array(z.string())
      .optional()
      .describe(
        "Native labels for ordered levels; requires labeledScores capability.",
      ),
  })
  .refine(
    (v) =>
      v.levelLabels === undefined || v.levelLabels.length === v.levels.length,
    "Provide one label per score level",
  );
export const checking = z.strictObject({
  id,
  question,
  yes: entry
    .optional()
    .describe("Optional structured definition of a positive answer."),
  no: entry
    .optional()
    .describe("Optional structured definition of a negative answer."),
});
export const imageInput = z
  .union([
    z.string().min(1),
    z.strictObject({
      content_type: z.enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
      ]),
      base64: z.string().min(1),
      detail: z.enum(["low", "high", "auto", "original"]).nullable().optional(),
    }),
  ])
  .describe(
    "Embedded data URL or {content_type,base64}; only on image-capable providers. Remote image URLs are unsupported.",
  );
export const messageInput = z
  .strictObject({
    parts: z
      .array(
        z.discriminatedUnion("type", [
          z.strictObject({ type: z.literal("text"), text: z.string() }),
          z.strictObject({ type: z.literal("image"), image: imageInput }),
        ]),
      )
      .min(1),
  })
  .describe(
    "One user message with ordered text/image parts; requires messages capability.",
  );
const evidence = {
  images: z.array(imageInput).min(1).optional(),
  content: entry
    .optional()
    .describe(
      "Shared text or JSON context. Supply content or messages, exclusively.",
    ),
  messages: z.array(messageInput).min(1).optional(),
  videos: z
    .array(z.strictObject({ frames: z.array(imageInput).min(1) }))
    .min(1)
    .optional()
    .describe(
      "Video clips as ordered embedded frames; requires video input capability.",
    ),
  mediaOptions: safeJson(z.record(z.string(), z.json()))
    .optional()
    .describe(
      "Native media processor options; requires mediaOptions capability.",
    ),
};
const metadata = {
  model: z.string().trim().min(1).optional(),
  allowUnverifiedModel: z
    .boolean()
    .optional()
    .describe(
      "Explicitly attempt an unverified model using its declared protocol baseline; never bypasses unsupported capabilities.",
    ),
  safetyIdentifier: z
    .string()
    .max(128)
    .nullable()
    .optional()
    .describe(
      "Provider safety identifier; requires safetyIdentifier capability.",
    ),
};
const common = { ...evidence, ...metadata };
export function evidenceIssue(v: {
  content?: unknown;
  messages?: unknown;
  images?: unknown;
  videos?: unknown;
}): string | undefined {
  if ((v.content !== undefined) === (v.messages !== undefined))
    return "Supply exactly one of content or messages";
  if (
    v.messages !== undefined &&
    (v.images !== undefined || v.videos !== undefined)
  )
    return "Put images inside message parts; messages cannot be combined with legacy images or videos";
}
function validateEvidence(
  v: Parameters<typeof evidenceIssue>[0],
  ctx: z.RefinementCtx,
) {
  const message = evidenceIssue(v);
  if (message) ctx.addIssue({ code: "custom", message });
}
function uniqueIds(items: { id: string }[]) {
  return new Set(items.map((x) => x.id)).size === items.length;
}
export const classifySchema = z
  .strictObject({ ...common, items: z.array(classification).min(1) })
  .refine((v) => uniqueIds(v.items), "Item IDs must be unique")
  .superRefine(validateEvidence);
export const scoreSchema = z
  .strictObject({ ...common, items: z.array(scoring).min(1) })
  .refine((v) => uniqueIds(v.items), "Item IDs must be unique")
  .superRefine(validateEvidence);
export const checkSchema = z
  .strictObject({ ...common, items: z.array(checking).min(1) })
  .refine((v) => uniqueIds(v.items), "Item IDs must be unique")
  .superRefine(validateEvidence);
const groups = {
  classifications: z.array(classification).optional(),
  scores: z.array(scoring).optional(),
  checks: z.array(checking).optional(),
};
function validateGroups(
  v: {
    classifications?: { id: string }[];
    scores?: { id: string }[];
    checks?: { id: string }[];
  },
  ctx: z.RefinementCtx,
) {
  const items = [
    ...(v.classifications ?? []),
    ...(v.scores ?? []),
    ...(v.checks ?? []),
  ];
  if (!items.length)
    ctx.addIssue({
      code: "custom",
      message: "Provide at least one assessment",
    });
  if (!uniqueIds(items))
    ctx.addIssue({
      code: "custom",
      message: "IDs must be unique across all assessment groups",
    });
}
export const structureSchema = z
  .strictObject({ ...common, ...groups })
  .superRefine(validateGroups)
  .superRefine(validateEvidence);
export const batchSchema = z
  .strictObject({
    ...metadata,
    ...groups,
    records: z
      .array(z.strictObject({ id, ...evidence }).superRefine(validateEvidence))
      .min(1)
      .max(32)
      .refine(uniqueIds, "Record IDs must be unique"),
  })
  .superRefine(validateGroups);
export type Assessment = z.infer<typeof structureSchema>;
