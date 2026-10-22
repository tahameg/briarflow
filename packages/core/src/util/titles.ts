/**
 * Internal: human titles derived from identifiers (node-api.md §1–§2).
 */

/** Splits `maxTokens`, `max_tokens`, `imageURL` into lowercase words. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/** `maxTokens` → `"Max tokens"`. Sentence case. */
export function titleFromName(name: string): string {
  const words = splitWords(name);
  if (words.length === 0) return name;
  const first = words[0] ?? "";
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

/** `openai.chatCompletion` → `"Chat completion"`; `briar.variable.get` → `"Variable get"`. */
export function titleFromNodeType(type: string): string {
  const rest = type.split(".").slice(1).join("_");
  return titleFromName(rest || type);
}

/** `openai` → `"Openai"`. */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
