/**
 * Type IR (docs/ARCHITECTURE.md §4.1, docs/specs/types.md). Plain JSON, stored in documents.
 */

/**
 * Primitive type names (types.md §1.1). Everything else is a struct or an enum: text, media,
 * JSON, secrets and errors are built-in structs (`builtins.ts`).
 *
 * - `binary` holds bytes. Its value is a {@link MediaRef}: the id of an entry in the media
 *   registry, never the bytes themselves.
 */
export type PrimitiveName = "int" | "float" | "bool" | "string" | "binary";

/** All primitive names, in display order. */
export const PRIMITIVE_NAMES: readonly PrimitiveName[] = ["int", "float", "bool", "string", "binary"];

/** The kinds of media built-in structs (Image, Video, Audio, Model3D, File). */
export type MediaKind = "image" | "video" | "audio" | "model3d" | "file";

/** All media kinds, in display order. */
export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "audio", "model3d", "file"];

/** Kinds of vault secrets. `apiKey` is text the studio never shows. */
export type SecretKind = "text" | "number" | "json" | "apiKey";

/** All secret kinds, in display order. */
export const SECRET_KINDS: readonly SecretKind[] = ["apiKey", "text", "number", "json"];

/** Constraints of `int` and `float` (inclusive). The only primitive constraints. */
export interface NumberConstraints {
  min?: number;
  max?: number;
}

/** A primitive type, discriminated by `name` so `constraints` is precise. */
export type PrimitiveTypeRef =
  | { kind: "primitive"; name: "int"; constraints?: NumberConstraints }
  | { kind: "primitive"; name: "float"; constraints?: NumberConstraints }
  | { kind: "primitive"; name: "bool"; constraints?: Record<string, never> }
  | { kind: "primitive"; name: "string"; constraints?: Record<string, never> }
  | { kind: "primitive"; name: "binary"; constraints?: Record<string, never> };

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

/**
 * A generic placeholder. Only allowed in node definitions (types.md §5). `oneOf` limits what
 * it binds to: the bound type must be assignable to one of them; unconnected, it binds to the
 * first.
 */
export interface VarTypeRef {
  kind: "var";
  name: string;
  oneOf?: TypeRef[];
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

/** What a media registry entry knows about its content. Known keys are validated (media.md §2). */
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
 * The JSON value of `binary` (types.md §8): the id of an entry in the media registry, which
 * holds the bytes. Media structs (Image, …) carry it in their `data` member.
 *
 * @example
 * ```ts
 * const ref: MediaRef = { mediaId: "med_3kq9x2" };
 * ```
 */
export interface MediaRef {
  mediaId: string;
}
