/**
 * Run inputs typed in the editor, kept in a key-value storage per context so a reload does
 * not lose them.
 */
import type { KeyValueStorage } from "./types.js";

type RunInputs = Record<string, Record<string, unknown>>;

const keyOf = (contextId: string) => `briarflow.runInputs.${contextId}`;

/** Stored run inputs of a context; `{}` when missing, unreadable or not an object of objects. */
export function readRunInputs(storage: KeyValueStorage, contextId: string): RunInputs {
  try {
    const raw = storage.getItem(keyOf(contextId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: RunInputs = {};
    for (const [flowId, values] of Object.entries(parsed)) {
      if (typeof values === "object" && values !== null && !Array.isArray(values)) out[flowId] = values as Record<string, unknown>;
    }
    return out;
  } catch {
    return {};
  }
}

/** Saves run inputs; storage errors (private mode, quota) are ignored. */
export function writeRunInputs(storage: KeyValueStorage, contextId: string, inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>): void {
  try {
    storage.setItem(keyOf(contextId), JSON.stringify(inputs));
  } catch {
    // Not persisted; the inputs stay in the store.
  }
}
