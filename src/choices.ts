import type { z } from "zod";
import type { entry } from "./contracts.ts";
import type { Assessment } from "./tasks.ts";
import { ProviderInputError } from "./failures.ts";

export type Entry = z.infer<typeof entry>;
export type ChoiceOption = { value: string | boolean; description?: Entry };
export function optionEntries(
  options: NonNullable<Assessment["classifications"]>[number]["options"],
): ChoiceOption[] {
  return Array.isArray(options)
    ? options
    : Object.entries(options).map(([value, description]) => ({
        value,
        description,
      }));
}

// Record-based protocols cannot represent boolean values without changing their type.
export function stringOptions(
  options: NonNullable<Assessment["classifications"]>[number]["options"],
): Record<string, Entry> {
  const result: Record<string, Entry> = Object.create(null);
  for (const option of optionEntries(options)) {
    if (
      typeof option.value !== "string" ||
      !option.value ||
      option.value === "__proto__" ||
      Object.hasOwn(result, option.value)
    )
      throw new ProviderInputError(
        "This protocol requires unique, nonempty string option values.",
      );
    result[option.value] = option.description ?? null;
  }
  return result;
}
