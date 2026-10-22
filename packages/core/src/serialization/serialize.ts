/**
 * Serialization and format migrations (docs/ARCHITECTURE.md §4.7, storage.md §5).
 */
import type { ContextDocument } from "../documents/model.js";
import { CONTEXT_FORMAT, CONTEXT_FORMAT_VERSION } from "../documents/model.js";
import { FormatError, isBriarError } from "../errors.js";
import { cloneJson, isPlainObject, stringifySorted } from "../util/json.js";
import { typeRefShapeProblem } from "../types/walk.js";

/**
 * Deterministic JSON of a context: object keys sorted (UTF-16 order) at every level, arrays in
 * order, 2-space indentation, trailing newline, `undefined` entries dropped. Equal documents
 * give identical strings.
 *
 * @example
 * ```ts
 * await store.write(doc.id, serializeContext(doc));
 * ```
 */
export function serializeContext(doc: ContextDocument): string {
  return stringifySorted(doc, 2) + "\n";
}

/** A migration from format version N (the key) to N+1. Receives a private deep copy. */
type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Internal migration registry: `MIGRATIONS.get(n)` upgrades a document from version `n` to
 * `n + 1`. Version 1 is the first format, so the registry is empty for now.
 */
export const MIGRATIONS: ReadonlyMap<number, Migration> = new Map<number, Migration>();

/**
 * Parses (when given a string) and structurally validates a context, running format
 * migrations from older `formatVersion`s up to the current one. Does not run semantic
 * validation (use `validateContext`). Never mutates its input.
 *
 * Throws `FormatError`:
 * - `format.invalid` — not JSON, wrong `format`, missing/ill-typed fields (`details.path`);
 * - `format.unsupported_version` — `formatVersion` newer than this library or unknown.
 *
 * @example
 * ```ts
 * const doc = deserializeContext(await readFile(path, "utf8"));
 * ```
 */
export function deserializeContext(input: string | unknown): ContextDocument {
  let raw: unknown;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      throw invalid(`the text is not valid JSON (${err instanceof Error ? err.message : String(err)})`, "");
    }
  } else {
    try {
      raw = cloneJson(input);
    } catch (err) {
      if (isBriarError(err)) throw invalid("the value is not plain JSON", "");
      throw err;
    }
  }
  if (!isPlainObject(raw)) throw invalid("expected an object", "");
  if (raw["format"] !== CONTEXT_FORMAT) throw invalid(`format must be "${CONTEXT_FORMAT}"`, "format");
  const version = raw["formatVersion"];
  if (version === undefined) throw invalid("formatVersion is missing", "formatVersion");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > CONTEXT_FORMAT_VERSION) {
    throw new FormatError(
      "format.unsupported_version",
      `This context uses format version ${JSON.stringify(version)}; this Briarflow supports up to ${CONTEXT_FORMAT_VERSION}. Update Briarflow.`,
      { details: { formatVersion: version, supported: CONTEXT_FORMAT_VERSION } },
    );
  }
  let doc: Record<string, unknown> = raw;
  for (let v = version; v < CONTEXT_FORMAT_VERSION; v++) {
    const migrate = MIGRATIONS.get(v);
    if (!migrate) {
      throw new FormatError("format.unsupported_version", `No migration from format version ${v}. Update Briarflow.`, {
        details: { formatVersion: version, supported: CONTEXT_FORMAT_VERSION },
      });
    }
    doc = { ...migrate(doc), formatVersion: v + 1 };
  }
  checkContext(doc, "");
  return doc as unknown as ContextDocument;
}

function invalid(problem: string, path: string): FormatError {
  return new FormatError("format.invalid", `Not a Briarflow context: ${problem} at ${path === "" ? "the root" : path}.`, {
    details: { path },
  });
}

type Check = (value: unknown, path: string) => void;

const str: Check = (v, p) => {
  if (typeof v !== "string") throw invalid("expected a string", p);
};
const num: Check = (v, p) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid("expected a number", p);
};
const obj: Check = (v, p) => {
  if (!isPlainObject(v)) throw invalid("expected an object", p);
};
const any: Check = () => {};
const oneOf =
  (...values: string[]): Check =>
  (v, p) => {
    if (typeof v !== "string" || !values.includes(v)) throw invalid(`expected one of ${values.join(", ")}`, p);
  };
const typeRef: Check = (v, p) => {
  const problem = typeRefShapeProblem(v, p);
  if (problem) throw invalid(`type ${problem.reason}`, problem.path);
};
const arrayOf =
  (item: Check): Check =>
  (v, p) => {
    if (!Array.isArray(v)) throw invalid("expected a list", p);
    v.forEach((x, i) => item(x, `${p}[${i}]`));
  };
const recordOf =
  (item: Check): Check =>
  (v, p) => {
    obj(v, p);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) item(x, `${p}.${k}`);
  };

function fields(spec: Record<string, [Check, boolean]>): Check {
  return (v, p) => {
    obj(v, p);
    const o = v as Record<string, unknown>;
    for (const [key, [check, required]] of Object.entries(spec)) {
      const path = p === "" ? key : `${p}.${key}`;
      if (o[key] === undefined) {
        if (required) throw invalid(`${key} is missing`, path);
        continue;
      }
      check(o[key], path);
    }
  };
}

const req = (c: Check): [Check, boolean] => [c, true];
const opt = (c: Check): [Check, boolean] => [c, false];

const fieldDecl = fields({ name: req(str), type: req(typeRef), description: opt(str), default: opt(any) });
const typeDecl: Check = (v, p) => {
  obj(v, p);
  const kind = (v as Record<string, unknown>)["kind"];
  if (kind === "struct") {
    fields({ kind: req(str), id: req(str), name: req(str), description: opt(str), fields: req(arrayOf(fieldDecl)) })(v, p);
  } else if (kind === "enum") {
    const member = fields({ value: req(str), label: opt(str) });
    fields({ kind: req(str), id: req(str), name: req(str), description: opt(str), members: req(arrayOf(member)) })(v, p);
  } else {
    throw invalid('expected kind "struct" or "enum"', `${p}.kind`);
  }
};
const position = fields({ x: req(num), y: req(num) });
const node = fields({
  id: req(str),
  type: req(str),
  title: opt(str),
  position: req(position),
  config: opt(obj),
  values: opt(obj),
  typeBindings: opt(recordOf(typeRef)),
});
const address = fields({ node: req(str), port: req(str) });
const edge = fields({ id: req(str), from: req(address), to: req(address) });
const variable = fields({
  id: req(str),
  name: req(str),
  type: req(typeRef),
  access: req(oneOf("public", "private")),
  default: opt(any),
  description: opt(str),
});
const global = fields({
  id: req(str),
  name: req(str),
  type: req(typeRef),
  access: req(oneOf("readonly", "readwrite")),
  value: opt(any),
  description: opt(str),
});
const viewport = fields({ x: req(num), y: req(num), zoom: req(num) });
const flow = fields({
  id: req(str),
  name: req(str),
  description: opt(str),
  types: req(arrayOf(typeDecl)),
  inputs: req(arrayOf(fieldDecl)),
  outputs: req(arrayOf(fieldDecl)),
  variables: req(arrayOf(variable)),
  nodes: req(arrayOf(node)),
  edges: req(arrayOf(edge)),
  ui: opt(fields({ viewport: opt(viewport) })),
});
const checkContext = fields({
  format: req(str),
  formatVersion: req(num),
  id: req(str),
  name: req(str),
  description: opt(str),
  revision: req((v, p) => {
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid("expected a whole number >= 0", p);
  }),
  createdAt: req(str),
  updatedAt: req(str),
  types: req(arrayOf(typeDecl)),
  globals: req(arrayOf(global)),
  flows: req(arrayOf(flow)),
  meta: opt(obj),
});
