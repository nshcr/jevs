import { ResponseContractError } from "./failures.ts";

export function hasPrototypeKey(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item && typeof item === "object") {
      if (Object.hasOwn(item, "__proto__")) return true;
      pending.push(...Object.values(item));
    }
  }
  return false;
}

export function rejectPrototypeKeys(value: unknown): void {
  if (hasPrototypeKey(value))
    throw new ResponseContractError(
      "Model response contains an unsupported JSON key.",
    );
}
