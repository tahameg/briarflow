/**
 * Shorthand type strings (docs/specs/types.md §2): `"text"`, `"list<image>[..4]"`,
 * `"Character?"`, `"openai.ChatMessage"`, `"list<$T>"`.
 */
import type { Diagnostic } from "../validation/diagnostic.js";
import { constraintMessage, constraintProblems } from "./constraints.js";
import type { ListTypeRef, PrimitiveName, TypeRef } from "./ir.js";
import { PRIMITIVE_NAMES } from "./ir.js";
import type { TypeScope } from "./scope.js";

/** Options of {@link parseType}. */
export interface ParseTypeOptions {
  /**
   * Resolve names to ids in this scope (`type.unknown` / `type.ambiguous` on failure).
   * Without a scope, named refs keep the bare/qualified name as `id` (pending resolution).
   */
  scope?: TypeScope;
  /** Accept `$T` generic vars (node definitions only). Default `false` → `type.var_not_allowed`. */
  allowVars?: boolean;
  /**
   * Where the type is written, used in `type.unknown` messages (e.g. `flow input "character"`).
   * Default: the quoted shorthand text.
   */
  where?: string;
}

/** Result of {@link parseType}. Failures carry exactly one diagnostic. */
export type ParseTypeResult =
  | { ok: true; type: TypeRef }
  | { ok: false; diagnostic: Diagnostic };

class ParseFailure {
  constructor(readonly diagnostic: Diagnostic) {}
}

const EXAMPLES = "Example of valid types: text, list<image>, Character?";

/**
 * Parses a shorthand string into the IR. Never throws for bad input; returns a diagnostic with
 * code `type.syntax`, `type.unknown`, `type.ambiguous`, `type.var_not_allowed` or
 * `type.invalid_constraint`. Positions in messages are 0-based character offsets.
 *
 * @example
 * ```ts
 * parseType("list<Character?>", { scope });
 * // { ok: true, type: { kind: "list", of: { kind: "optional", of: { kind: "named", id: "ty_c1" } } } }
 * ```
 */
export function parseType(text: string, options: ParseTypeOptions = {}): ParseTypeResult {
  if (typeof text !== "string") {
    return { ok: false, diagnostic: syntax(String(text), "the type must be a string", 0) };
  }
  const p = new Parser(text, options);
  try {
    const type = p.parseType();
    if (p.pos < text.length) p.fail(`unexpected "${text[p.pos]}"`);
    return { ok: true, type };
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, diagnostic: err.diagnostic };
    throw err;
  }
}

function syntax(text: string, reason: string, pos: number): Diagnostic {
  return {
    severity: "error",
    code: "type.syntax",
    message: `Cannot read the type "${text}": ${reason} at position ${pos}. ${EXAMPLES}`,
    path: {},
    details: { text, reason, position: pos },
  };
}

class Parser {
  pos = 0;
  constructor(
    private readonly text: string,
    private readonly options: ParseTypeOptions,
  ) {}

  fail(reason: string, pos = this.pos): never {
    throw new ParseFailure(syntax(this.text, reason, pos));
  }

  private ws(): void {
    while (this.text[this.pos] === " ") this.pos++;
  }

  private peek(): string | undefined {
    return this.text[this.pos];
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) {
      this.fail(this.peek() === undefined ? `expected "${ch}" but the text ended` : `expected "${ch}" but found "${this.peek()}"`);
    }
    this.pos++;
  }

  parseType(): TypeRef {
    this.ws();
    let type = this.parseBase();
    this.ws();
    if (this.peek() === "?") {
      this.pos++;
      type = { kind: "optional", of: type };
      this.ws();
      if (this.peek() === "?") this.fail("optional of optional (??) is not a type");
    }
    return type;
  }

  private word(re: RegExp): string {
    const start = this.pos;
    while (this.pos < this.text.length && re.test(this.text[this.pos] ?? "")) this.pos++;
    return this.text.slice(start, this.pos);
  }

  private parseBase(): TypeRef {
    const start = this.pos;
    const ch = this.peek();
    if (ch === undefined) this.fail("expected a type but the text ended");
    if (ch === "$") return this.parseVar();
    if (/[a-z]/.test(ch)) {
      const w = this.word(/[a-z0-9_]/);
      if (this.peek() === ".") {
        this.pos++;
        const nameStart = this.pos;
        if (!/[A-Z]/.test(this.peek() ?? "")) this.fail("expected a type name starting with an uppercase letter after the pack name");
        const name = this.word(/[A-Za-z0-9_]/);
        void nameStart;
        return this.named(`${w}.${name}`, start);
      }
      if (w === "list") return this.parseList();
      if ((PRIMITIVE_NAMES as readonly string[]).includes(w)) return { kind: "primitive", name: w as PrimitiveName };
      this.fail(`"${w}" is not a type (primitives are ${PRIMITIVE_NAMES.join(", ")}; named types start with an uppercase letter)`, start);
    }
    if (/[A-Z]/.test(ch)) {
      const name = this.word(/[A-Za-z0-9_]/);
      return this.named(name, start);
    }
    return this.fail(`unexpected "${ch}"`);
  }

  private parseVar(): TypeRef {
    const start = this.pos;
    this.pos++;
    if (!/[A-Z]/.test(this.peek() ?? "")) this.fail("expected a generic name starting with an uppercase letter after $");
    const name = this.word(/[A-Za-z0-9]/);
    if (name.length > 16) this.fail("generic names are at most 16 characters", start);
    if (!this.options.allowVars) {
      throw new ParseFailure({
        severity: "error",
        code: "type.var_not_allowed",
        message: `Generic type "$${name}" can only be used in node definitions.`,
        path: {},
        details: { name },
      });
    }
    return { kind: "var", name };
  }

  private parseList(): TypeRef {
    this.ws();
    this.expect("<");
    this.ws();
    if (this.peek() === ">") this.fail("expected a type inside list<>");
    const of = this.parseType();
    this.ws();
    this.expect(">");
    const list: ListTypeRef = { kind: "list", of };
    const save = this.pos;
    this.ws();
    if (this.peek() === "[") {
      this.pos++;
      this.ws();
      const min = this.word(/[0-9]/);
      this.ws();
      if (this.text.slice(this.pos, this.pos + 2) !== "..") this.fail('expected ".." in list bounds');
      this.pos += 2;
      this.ws();
      const max = this.word(/[0-9]/);
      this.ws();
      this.expect("]");
      if (min !== "") list.minItems = Number(min);
      if (max !== "") list.maxItems = Number(max);
      const problem = constraintProblems(list)[0];
      if (problem !== undefined) {
        throw new ParseFailure({
          severity: "error",
          code: "type.invalid_constraint",
          message: constraintMessage(problem, `"${this.text}"`),
          path: {},
          details: { constraint: problem.constraint, reason: problem.reason },
        });
      }
    } else {
      this.pos = save;
    }
    return list;
  }

  private named(name: string, start: number): TypeRef {
    const scope = this.options.scope;
    if (!scope) return { kind: "named", id: name };
    const r = scope.resolveName(name);
    if (r.ok) return { kind: "named", id: r.decl.id };
    void start;
    if (r.code === "type.ambiguous") {
      throw new ParseFailure({
        severity: "error",
        code: "type.ambiguous",
        message: `"${name}" matches several pack types: ${r.candidates.join(", ")}. Use the full name, e.g. ${r.candidates[0] ?? name}.`,
        path: {},
        details: { name, candidates: [...r.candidates] },
      });
    }
    const where = this.options.where ?? `"${this.text}"`;
    throw new ParseFailure({
      severity: "error",
      code: "type.unknown",
      message: `Unknown type "${name}" in ${where}. Define it in the Types panel or check the spelling.`,
      path: {},
      details: { name },
    });
  }
}

/**
 * Prints the shortest shorthand that parses back to the same IR in `scope` (qualified pack id
 * when the short name is shadowed or ambiguous; `#<id>` for unknown ids). Primitive
 * constraints are not printed; list bounds are. Without a scope, named ids are printed as they
 * are when they look like names (`Character`, `openai.ChatMessage`), else as `#<id>`.
 *
 * @example
 * ```ts
 * formatType({ kind: "optional", of: { kind: "named", id: "ty_c1" } }, scope); // "Character?"
 * ```
 */
export function formatType(type: TypeRef, scope?: TypeScope): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "var":
      return `$${type.name}`;
    case "optional":
      return `${formatType(type.of, scope)}?`;
    case "list": {
      let out = `list<${formatType(type.of, scope)}>`;
      if (type.minItems !== undefined || type.maxItems !== undefined) {
        out += `[${type.minItems ?? ""}..${type.maxItems ?? ""}]`;
      }
      return out;
    }
    case "named":
      return formatNamed(type.id, scope);
  }
}

function formatNamed(id: string, scope: TypeScope | undefined): string {
  if (!scope) {
    return /^([a-z][a-z0-9_]*\.)?[A-Z][A-Za-z0-9_]*$/.test(id) ? id : `#${id}`;
  }
  const entry = scope.getType(id);
  if (!entry) return `#${id}`;
  const short = scope.resolveName(entry.decl.name);
  if (short.ok && short.decl.id === id) return entry.decl.name;
  if (entry.origin === "pack") return id;
  return `#${id}`;
}
