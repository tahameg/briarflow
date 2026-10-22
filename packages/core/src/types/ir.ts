/**
 * Type IR (docs/ARCHITECTURE.md §4.1, docs/specs/types.md). Plain JSON, stored in documents.
 */

/** Primitive type names. Media primitives hold a {@link MediaRef}. */
export type PrimitiveName =
  | "text" | "int" | "float" | "boolean"
  | "image" | "video" | "audio" | "model3d" | "file"
  | "error";

/** The media primitives. */
export type MediaPrimitiveName = "image" | "video" | "audio" | "model3d" | "file";

/** All primitive names, in display order. */
export const PRIMITIVE_NAMES: readonly PrimitiveName[] = [
  "text", "int", "float", "boolean", "image", "video", "audio", "model3d", "file", "error",
];

/**
 * Value of the `error` primitive: why a node failed. Produced by the engine on a node's
 * `error` output when it fails and its "failed" execution line is connected; read its fields
 * with Break error.
 */
export interface ErrorValue {
  /** Stable code, e.g. `node.timeout`. */
  code: string;
  message: string;
  /** Node that failed. */
  nodeId?: string;
  /** Its title at run time. */
  node?: string;
  details?: unknown;
}

/** All media primitive names. */
export const MEDIA_PRIMITIVE_NAMES: readonly MediaPrimitiveName[] = ["image", "video", "audio", "model3d", "file"];

/** Constraints of `text` (types.md §6). `multiline` is a UI hint only. */
export interface TextConstraints {
  minLength?: number;
  maxLength?: number;
  /** ECMAScript regex source, `u` flag, implicitly anchored to the whole string. */
  pattern?: string;
  multiline?: boolean;
}

/** Constraints of `int` and `float` (inclusive). */
export interface NumberConstraints {
  min?: number;
  max?: number;
}

/** Constraints shared by every media primitive. */
export interface MediaConstraints {
  /** Format names (`png`, `mp4`, …, see types.md §6) or literal mime types. */
  formats?: readonly string[];
  /** Checked only when `MediaRef.bytes` is present. */
  maxBytes?: number;
}

/** Constraints of `image`. Size checks apply only when `meta.width/height` are present. */
export interface ImageConstraints extends MediaConstraints {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

/** Constraints of `video` and `audio`. Checked only when `meta.durationSec` is present. */
export interface TimedMediaConstraints extends MediaConstraints {
  maxDurationSec?: number;
}

/** A primitive type, discriminated by `name` so `constraints` is precise. */
export type PrimitiveTypeRef =
  | { kind: "primitive"; name: "text"; constraints?: TextConstraints }
  | { kind: "primitive"; name: "int"; constraints?: NumberConstraints }
  | { kind: "primitive"; name: "float"; constraints?: NumberConstraints }
  | { kind: "primitive"; name: "boolean"; constraints?: Record<string, never> }
  | { kind: "primitive"; name: "image"; constraints?: ImageConstraints }
  | { kind: "primitive"; name: "video"; constraints?: TimedMediaConstraints }
  | { kind: "primitive"; name: "audio"; constraints?: TimedMediaConstraints }
  | { kind: "primitive"; name: "model3d"; constraints?: MediaConstraints }
  | { kind: "primitive"; name: "file"; constraints?: MediaConstraints }
  | { kind: "primitive"; name: "error"; constraints?: Record<string, never> };

/**
 * A struct or enum, by stable id: `ty_…` for user types, `<pack>.<Name>` for pack types.
 *
 * Inside a {@link TypeSpec} built before its pack is known (`t.ref("Role")`,
 * `t.ref(defineStruct(...))`), `id` may be a bare type name such as `"Role"`; `definePack`
 * qualifies it to `"<pack>.Role"`. A bare name is never valid inside a document.
 */
export interface NamedTypeRef {
  kind: "named";
  id: string;
}

/** A list. Bounds are optional, inclusive. */
export interface ListTypeRef {
  kind: "list";
  of: TypeRef;
  minItems?: number;
  maxItems?: number;
}

/** An optional value: the inner type or `null`. Never nested (`T??` is invalid). */
export interface OptionalTypeRef {
  kind: "optional";
  of: TypeRef;
}

/** A generic placeholder. Only allowed in node definitions (types.md §5). */
export interface VarTypeRef {
  kind: "var";
  name: string;
}

/**
 * The type IR. JSON-serializable; stored in documents.
 *
 * @example
 * ```ts
 * const ref: TypeRef = { kind: "list", of: { kind: "named", id: "ty_char" }, maxItems: 4 };
 * ```
 */
export type TypeRef = PrimitiveTypeRef | NamedTypeRef | ListTypeRef | OptionalTypeRef | VarTypeRef;

/** Extra information on a {@link MediaRef}. Known keys are validated (types.md §8). */
export interface MediaMeta {
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  /** Conventional place for an original file name. */
  filename?: string;
  [key: string]: unknown;
}

/**
 * The JSON value of every media primitive (types.md §8).
 *
 * @example
 * ```ts
 * const ref: MediaRef = { uri: "briar-media://m_abc", mime: "image/png", bytes: 2048 };
 * ```
 */
export interface MediaRef {
  /** `briar-media://<id>`, `https://…` or `http://…`. */
  uri: string;
  /** Lowercase mime type without parameters. */
  mime: string;
  bytes?: number;
  /** SHA-256 of the content, lowercase hex. Used for caching. */
  hash?: string;
  meta?: MediaMeta;
}
