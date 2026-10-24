/**
 * Settings (docs/specs/settings.md): values the user sets once for the whole server, by key.
 * Packs declare theirs (`definePack({ settings })`, keys `<pack>.<name>`); nodes read their
 * pack's settings with `ctx.settings.get(name)`.
 */
import type { JsonValue } from "../util/json.js";

/** Where setting values live. Missing keys read as `undefined` (the declared default applies). */
export interface SettingsStore {
  /** Every stored value, by key. */
  all(): Promise<Record<string, JsonValue>>;
  get(key: string): Promise<JsonValue | undefined>;
  /** `undefined` removes the value. */
  set(key: string, value: JsonValue | undefined): Promise<void>;
}

/**
 * Settings in memory.
 *
 * @example
 * ```ts
 * const settings = createMemorySettings({ "openai.chatKey": "OPENAI_KEY" });
 * ```
 */
export function createMemorySettings(initial: Readonly<Record<string, JsonValue>> = {}): SettingsStore {
  const values = new Map<string, JsonValue>(Object.entries(initial));
  return {
    async all() {
      return Object.fromEntries(values);
    },
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}
