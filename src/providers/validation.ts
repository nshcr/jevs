import type { ProviderKind } from "../decision.ts";
import { ProviderInputError } from "../failures.ts";
import type { WireRequest } from "./system-one.ts";
const fail = (message: string): never => {
  throw new ProviderInputError(message);
};
function validateImages(images: NonNullable<WireRequest["images"]>) {
  if (images.length > 4) fail("Clef accepts at most four images.");
  let total = 0;
  for (const image of images) {
    let mime: string, encoded: string;
    if (typeof image === "string") {
      const match =
        /^[Dd][Aa][Tt][Aa]:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
          image,
        );
      if (!match)
        fail(
          "Use embedded PNG, JPEG or WebP images; remote URLs are unsupported.",
        );
      mime = match![1]!;
      encoded = match![2]!;
    } else {
      mime = image.content_type;
      encoded = image.base64;
    }
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(mime) ||
      !encoded.length ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      fail("Provide valid base64 PNG, JPEG or WebP image data.");
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const bytes = (encoded.length * 3) / 4 - padding;
    if (bytes > 4 * 1024 * 1024)
      fail("Each Clef image must be at most 4 MiB decoded.");
    total += bytes;
  }
  if (total > 8 * 1024 * 1024)
    fail("Clef images must total at most 8 MiB decoded.");
}
export function validateWire(kind: ProviderKind, request: WireRequest) {
  const clef = kind === "cloudflare-workers";
  const strict = clef || kind === "openrouter";
  if (request.images) {
    if (!clef)
      fail("This provider protocol supports text and JSON inputs only.");
    validateImages(request.images);
  }
  if (clef && Object.keys(request.questions).length > 64)
    fail("Clef accepts at most 64 judgments per call.");
  if ((strict || kind === "zen") && request.state === null)
    fail("Provide non-null content for this provider.");
  for (const [id, q] of Object.entries(request.questions)) {
    if (clef && !/^[a-zA-Z0-9_.-]{1,100}$/.test(id))
      fail(
        "Clef judgment IDs must contain 1 to 100 ASCII letters, digits, dots, underscores or hyphens.",
      );
    if (
      clef &&
      typeof q.instructions === "string" &&
      q.instructions.length === 0
    )
      fail("Clef requires non-empty question strings.");
    if (strict && q.instructions === null)
      fail("Provide a non-null question for every judgment on this provider.");
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length;
      if (
        n < (kind === "system-one" || kind === "openrouter" ? 1 : 2) ||
        (kind !== "system-one" && kind !== "openrouter" && n > 255)
      )
        fail("Provide options within this provider's allowed count.");
      if (
        Object.keys(q.criteria).some(
          (key) => !key.length || key === "__proto__",
        )
      )
        fail("Option IDs must be non-empty and safe JSON keys.");
    }
    if (q.type === "score") {
      if (
        q.criteria.length <
          (kind === "system-one" || kind === "openrouter" ? 1 : 2) ||
        (kind !== "system-one" &&
          kind !== "openrouter" &&
          q.criteria.length > 10)
      )
        fail("Provide score levels within this provider's limit.");
      if (
        (strict || kind === "zen") &&
        q.criteria.some((value) => value === null)
      )
        fail("Describe every score level with a non-null value.");
    }
    if (q.type === "noul") {
      if (
        kind === "openrouter" &&
        q.criteria &&
        (q.criteria.true == null || q.criteria.false == null)
      )
        fail("Supply both non-null yes and no definitions, or omit both.");
      if (
        kind === "zen" &&
        q.instructions === null &&
        q.criteria?.true == null &&
        q.criteria?.false == null
      )
        fail("OpenCode Zen requires a check question or a yes/no definition.");
    }
  }
  if (
    clef &&
    new TextEncoder().encode(JSON.stringify(request)).byteLength >
      13 * 1024 * 1024
  )
    fail("Clef requests must be at most 13 MiB.");
}
