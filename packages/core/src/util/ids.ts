/** Kinds of document ids and their prefixes (docs/specs/types.md §1). */
export const ID_PREFIXES = {
  context: "ctx",
  flow: "flow",
  type: "ty",
  global: "gv",
  variable: "var",
  node: "n",
  edge: "e",
} as const;

/** A kind of document id: `context`, `flow`, `type`, `global`, `variable`, `node`, `edge`. */
export type IdKind = keyof typeof ID_PREFIXES;

/** Id prefix for one {@link IdKind}, e.g. `"ctx"`. Run ids use `"run"`, media ids `"m"`. */
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** Regex of every document id: `<prefix>_<1–60 of [A-Za-z0-9_-]>`. */
export const ID_PATTERN = /^(ctx|flow|ty|gv|var|n|e)_[A-Za-z0-9_-]{1,60}$/;

/**
 * Creates ids for new entities. Receives the prefix (`"flow"`, `"n"`, `"run"`, …) and returns
 * `<prefix>_<suffix>`. Injected everywhere ids are created so tests are deterministic.
 */
export type IdGenerator = (prefix: string) => string;

/** Returns "now". Injected everywhere time is read so tests are deterministic. */
export type Clock = () => Date;

/**
 * True when `id` is a valid id of the given kind (`types.md` §1).
 *
 * @example
 * ```ts
 * isValidId("flow", "flow_8fK2"); // true
 * isValidId("node", "flow_8fK2"); // false
 * ```
 */
export function isValidId(kind: IdKind, id: string): boolean {
  return ID_PATTERN.test(id) && id.startsWith(`${ID_PREFIXES[kind]}_`);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Random id generator: `<prefix>_<length base62 chars>` (default 12).
 *
 * @example
 * ```ts
 * const ids = createIdGenerator();
 * ids("flow"); // "flow_4fK29aQx0LmZ"
 * ```
 */
export function createIdGenerator(options: { random?: () => number; length?: number } = {}): IdGenerator {
  const random = options.random ?? Math.random;
  const length = options.length ?? 12;
  return (prefix) => {
    let suffix = "";
    for (let i = 0; i < length; i++) suffix += BASE62[Math.floor(random() * 62) % 62];
    return `${prefix}_${suffix}`;
  };
}

/**
 * Deterministic generator for tests: `<prefix>_1`, `<prefix>_2`, … counted per prefix.
 *
 * @example
 * ```ts
 * const ids = createSequentialIdGenerator();
 * ids("n"); ids("n"); ids("e"); // "n_1", "n_2", "e_1"
 * ```
 */
export function createSequentialIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}
