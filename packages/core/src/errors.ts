/**
 * JSON-safe form of a {@link BriarError}. Used in run results, run events and the REST error
 * body (`{ "error": SerializedError }`). See docs/specs/runtime.md §8.
 */
export interface SerializedError {
  /** Stable, machine-readable code, e.g. `"edge.type_mismatch"`. */
  code: string;
  /** Human sentence: what is wrong, where, and how to fix it. */
  message: string;
  /** Optional structured data (must be JSON-serializable). */
  details?: unknown;
  /** Node that produced the error (node and run errors). */
  nodeId?: string;
  /** Whether retrying the same work may succeed (node errors). */
  retryable?: boolean;
  /** The wrapped error, e.g. the node error inside `run.node_failed`. */
  cause?: SerializedError;
}

/** Options accepted by {@link BriarError} and its subclasses. */
export interface BriarErrorOptions {
  /** Structured, JSON-serializable data that helps a caller react to the error. */
  details?: unknown;
  /** The underlying error, if this one wraps another. */
  cause?: unknown;
}

/**
 * Base class for every error thrown by Briarflow packages.
 *
 * `code` is stable across versions and safe to branch on; `message` is for humans and says
 * what is wrong, where, and how to fix it.
 *
 * @example
 * ```ts
 * throw new BriarError(
 *   "flow.not_found",
 *   'Flow "flow_abc" does not exist in context "ctx_1". Check the id or create the flow first.',
 *   { details: { flowId: "flow_abc", contextId: "ctx_1" } },
 * );
 * ```
 */
export class BriarError extends Error {
  /** Stable, machine-readable code in `area.snake_case` form. */
  readonly code: string;
  /** Optional structured data; JSON-serializable. */
  readonly details: unknown;

  constructor(code: string, message: string, options: BriarErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
  }

  /**
   * JSON-safe representation. `details` is omitted when absent; `cause` is included only
   * when it is itself a Briarflow error (plain causes may hold secrets or stacks).
   */
  toJSON(): SerializedError {
    const out: SerializedError = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    if (isBriarError(this.cause)) out.cause = serializeError(this.cause);
    return out;
  }
}

/**
 * Thrown by interface stubs whose implementation has not been written yet.
 *
 * @example
 * ```ts
 * export function validateFlow(): never {
 *   throw new NotImplementedError("validateFlow");
 * }
 * ```
 */
export class NotImplementedError extends BriarError {
  constructor(feature: string, options: BriarErrorOptions = {}) {
    super(
      "not_implemented",
      `${feature} is not implemented yet. It is planned for a later phase (see docs/PHASES.md).`,
      { ...options, details: options.details ?? { feature } },
    );
  }
}

/**
 * Type guard that also works across duplicated package copies or realms, where
 * `instanceof` can fail: it checks for an `Error` with a string `code`.
 *
 * @example
 * ```ts
 * if (isBriarError(err) && err.code === "not_implemented") skip();
 * ```
 */
export function isBriarError(value: unknown): value is BriarError {
  if (value instanceof BriarError) return true;
  return value instanceof Error && typeof (value as { code?: unknown }).code === "string";
}

/**
 * Converts any thrown value into a {@link SerializedError}. Briarflow errors keep their code,
 * details and Briarflow causes; anything else becomes `{ code: "internal", message }`.
 * Stacks are never serialized.
 *
 * @example
 * ```ts
 * catch (err) { return { error: serializeError(err) }; }
 * ```
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof BriarError) return error.toJSON();
  if (isBriarError(error)) {
    const withJson = error as { toJSON?: () => SerializedError };
    if (typeof withJson.toJSON === "function") return withJson.toJSON();
    const out: SerializedError = { code: error.code, message: error.message };
    if (error.details !== undefined) out.details = error.details;
    return out;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "internal", message };
}

// ---------------------------------------------------------------------------------------------
// Definition-time errors (thrown synchronously by builders; programmer errors)
// ---------------------------------------------------------------------------------------------

/**
 * A type could not be built or parsed: invalid constraint, bad shorthand, invalid name.
 * Codes: `type.invalid_constraint`, `type.syntax`, `type.invalid_name`, `type.var_not_allowed`, …
 *
 * @example
 * ```ts
 * t.int({ min: 5, max: 1 }); // throws TypeDefinitionError (type.invalid_constraint)
 * ```
 */
export class TypeDefinitionError extends BriarError {}

/**
 * `defineNode` rejected a definition. Code `node_def.invalid`; the message names the node type
 * and the field.
 */
export class NodeDefinitionError extends BriarError {
  constructor(message: string, options: BriarErrorOptions = {}) {
    super("node_def.invalid", message, options);
  }
}

/** `definePack` / `defineStruct` / `defineEnum` rejected a definition. Code `pack.invalid`. */
export class PackDefinitionError extends BriarError {
  constructor(message: string, options: BriarErrorOptions = {}) {
    super("pack.invalid", message, options);
  }
}

/**
 * `createCatalog` rejected a set of packs. Codes: `catalog.duplicate_pack`,
 * `catalog.namespace_conflict`.
 */
export class CatalogError extends BriarError {}

/**
 * A serialized context could not be read. Codes: `format.invalid` (details: `{ path }`),
 * `format.unsupported_version` (details: `{ formatVersion, supported }`).
 */
export class FormatError extends BriarError {}

// ---------------------------------------------------------------------------------------------
// Node execution errors
// ---------------------------------------------------------------------------------------------

/** Options for {@link NodeError}. */
export interface NodeErrorOptions extends BriarErrorOptions {
  /** Whether the engine may retry the attempt. Default depends on the code (node-api.md §6). */
  retryable?: boolean;
}

/** Codes whose `retryable` default is `true` (docs/specs/node-api.md §6). */
const RETRYABLE_BY_DEFAULT = new Set(["node.rate_limited", "node.unavailable", "node.timeout"]);

/**
 * Expected failure thrown from a node's `run`. Use the standard codes from node-api.md §6
 * (`node.invalid_input`, `node.rate_limited`, `node.unavailable`, …) or `<pack>.<reason>`.
 *
 * @example
 * ```ts
 * throw new NodeError("node.rate_limited", "ACME rate limit reached. The request will be retried.", {
 *   retryable: true,
 *   details: { retryAfterMs: 2000 },
 * });
 * ```
 */
export class NodeError extends BriarError {
  /** Whether the engine may retry the attempt. */
  readonly retryable: boolean;

  constructor(code: string, message: string, options: NodeErrorOptions = {}) {
    super(code, message, options);
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
  }

  override toJSON(): SerializedError {
    return { ...super.toJSON(), retryable: this.retryable };
  }
}

// ---------------------------------------------------------------------------------------------
// Storage errors (docs/specs/storage.md). Thrown by ContextStore / MediaStore implementations.
// Store-specific codes without a class (plain `BriarError`): `store.unsupported_schema`
// (`details: { schemaVersion, supported }`, a database written by a newer library version).
// ---------------------------------------------------------------------------------------------

/**
 * `ContextStore.save` with a stale `expectedRevision`. Code `store.revision_conflict`,
 * details `{ id, expected, actual }` (`actual` is 0 when the context does not exist).
 *
 * @example
 * ```ts
 * throw new RevisionConflictError({ id: doc.id, name: doc.name, expected: 3, actual: 5 });
 * ```
 */
export class RevisionConflictError extends BriarError {
  constructor(args: { id: string; name?: string; expected: number; actual: number }, options: BriarErrorOptions = {}) {
    super(
      "store.revision_conflict",
      `Context "${args.name ?? args.id}" was changed by someone else (revision ${args.actual}, you had ${args.expected}). Reload and try again.`,
      { ...options, details: { id: args.id, expected: args.expected, actual: args.actual } },
    );
  }
}

/**
 * `ContextStore.save` of a document containing a flow id owned by another context.
 * Code `store.flow_id_conflict`, details `{ flowId, contextId }` (`contextId` = the owner).
 */
export class FlowIdConflictError extends BriarError {
  constructor(args: { flowId: string; contextId: string }, options: BriarErrorOptions = {}) {
    super(
      "store.flow_id_conflict",
      `Flow id "${args.flowId}" already belongs to context "${args.contextId}". Flow ids must be unique across contexts; use a new id.`,
      { ...options, details: { flowId: args.flowId, contextId: args.contextId } },
    );
  }
}

/** A stored document failed to deserialize. Code `store.corrupt`, details `{ id }`. */
export class StoreCorruptError extends BriarError {
  constructor(args: { id: string }, options: BriarErrorOptions = {}) {
    super(
      "store.corrupt",
      `Stored context "${args.id}" cannot be read. Restore it from a backup or delete it.`,
      { ...options, details: { id: args.id } },
    );
  }
}

/**
 * Malformed list cursor, or a cursor produced for another search. Code `store.invalid_cursor`.
 */
export class InvalidCursorError extends BriarError {
  constructor(message = "The list cursor is invalid or belongs to another search. Start again without a cursor.", options: BriarErrorOptions = {}) {
    super("store.invalid_cursor", message, options);
  }
}

/** Invalid `list` query (e.g. `limit < 1`). Code `store.invalid_query`. */
export class InvalidQueryError extends BriarError {
  constructor(message: string, options: BriarErrorOptions = {}) {
    super("store.invalid_query", message, options);
  }
}

/** `save` received something that is not a context document. Code `store.invalid_document`. */
export class InvalidDocumentError extends BriarError {
  constructor(message: string, options: BriarErrorOptions = {}) {
    super("store.invalid_document", message, options);
  }
}

/** A store method was called after `close()`. Code `store.closed`. */
export class StoreClosedError extends BriarError {
  constructor(kind: string, options: BriarErrorOptions = {}) {
    super("store.closed", `The ${kind} store is closed. Create a new store instance.`, options);
  }
}

/**
 * Media problems. Codes: `media.invalid_mime`, `media.too_large` (details `{ maxBytes }`),
 * `media.not_found`, `media.invalid_uri`, `media.fetch_failed` (details `{ status }`, a non-2xx
 * other than 404 from an http(s) media URL), `media.corrupt` (details `{ uri }`, a stored item
 * whose metadata cannot be read; delete and upload it again).
 */
export class MediaError extends BriarError {}
