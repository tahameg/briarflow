/**
 * Briar Woodshop theme in TypeScript (docs/specs/design-system.md): token values, the
 * type → port color/shape map (§6) and node header colors (§7). The CSS tokens in
 * `styles/tokens.css` carry the same names.
 */
import type { NodeColor, TypeRef } from "@briarflow/core";

/** Token values (same names as the CSS custom properties without `--bf-`). */
export const BRIAR_TOKENS = {
  bg: "#1D1914",
  surface: "#2D2A25",
  "surface-2": "#36322B",
  "surface-3": "#443E35",
  ink: "#EADFCA",
  "ink-muted": "#A99C86",
  "ink-disabled": "#6F6656",
  "ink-inverse": "#24170A",
  shadow: "#000000",
  "grid-minor": "#2A251E",
  "grid-major": "#3A3228",
  yellow: "#F2B84B",
  "yellow-press": "#D99A2B",
  mint: "#A8E6CF",
  lavender: "#C3B1E1",
  peach: "#FFC8A2",
  sky: "#A0D2EB",
  pink: "#FFB3C6",
  lime: "#D4F0A0",
  aqua: "#9EE6E0",
  sand: "#E8D8B0",
  coral: "#FF9E9E",
  stone: "#B8B8B8",
  danger: "#FF8A72",
} as const;

/** A token name of {@link BRIAR_TOKENS}. */
export type BriarToken = keyof typeof BRIAR_TOKENS;

/** `var(--bf-<token>)`. */
export function tokenVar(token: BriarToken): string {
  return `var(--bf-${token})`;
}

/** Kind of a named type, used to tell enums (diamond ports) from structs. */
export type NamedKindLookup = ((typeId: string) => "struct" | "enum" | undefined) & {
  /** The root of a struct's `extends` chain (`ShortText` → `briar.Text`), so it is styled like its base. */
  root?: (typeId: string) => string;
};

/** Visual description of a type (design-system.md §6). */
export interface TypeStyle {
  /** Token of the base color. */
  token: BriarToken;
  /** CSS color (`var(--bf-…)`). */
  color: string;
  shape: "square" | "diamond";
  /** `list<X>`: hollow marker. */
  hollow: boolean;
  /** `X?`: dashed outline. */
  optional: boolean;
  /** Unbound `$T`. */
  unbound: boolean;
}

const PRIMITIVE_TOKENS: Record<string, BriarToken> = {
  string: "mint",
  int: "sky",
  float: "aqua",
  bool: "lime",
  binary: "stone",
};

/** Built-in structs keep the colors their kinds always had (types.md §1.2). */
const BUILTIN_TOKENS: Record<string, BriarToken> = {
  "briar.Text": "mint",
  "briar.Json": "yellow",
  "briar.Secret": "lavender",
  "briar.ApiKey": "lavender",
  "briar.Image": "peach",
  "briar.Video": "coral",
  "briar.Audio": "pink",
  "briar.Model3D": "sand",
  "briar.File": "stone",
  "briar.Error": "coral",
};

/**
 * Color and shape of a port of type `type`.
 *
 * @example
 * ```ts
 * typeStyle({ kind: "list", of: { kind: "primitive", name: "string" } }); // mint, hollow
 * ```
 */
export function typeStyle(type: TypeRef, kindOf?: NamedKindLookup): TypeStyle {
  switch (type.kind) {
    case "primitive": {
      const token = PRIMITIVE_TOKENS[type.name] ?? "stone";
      return { token, color: tokenVar(token), shape: "square", hollow: false, optional: false, unbound: false };
    }
    case "named": {
      const kind = kindOf?.(type.id);
      const token = BUILTIN_TOKENS[kindOf?.root?.(type.id) ?? type.id] ?? "lavender";
      return { token, color: tokenVar(token), shape: kind === "enum" ? "diamond" : "square", hollow: false, optional: false, unbound: false };
    }
    case "list":
      return { ...typeStyle(type.of, kindOf), hollow: true };
    case "optional":
      return { ...typeStyle(type.of, kindOf), optional: true };
    case "var":
      return { token: "ink", color: tokenVar("ink"), shape: "square", hollow: true, optional: false, unbound: true };
  }
}

/** CSS color of a type (`briarTheme.typeColor`). */
export function typeColor(type: TypeRef, kindOf?: NamedKindLookup): string {
  return typeStyle(type, kindOf).color;
}

const CATEGORY_TOKENS: Record<string, BriarToken> = {
  text: "mint",
  image: "peach",
  ai: "lavender",
  data: "sky",
  list: "sky",
  convert: "sky",
  flow: "yellow",
  variables: "pink",
  variable: "pink",
  globals: "pink",
};

/**
 * Header strip token of a node: the definition `color`, else by category (Text=mint,
 * Image=peach, AI=lavender, Data=sky, Variables=pink), else stone.
 */
export function nodeAccent(color: NodeColor | null | undefined, category: string | undefined): BriarToken {
  if (color) return color;
  const key = (category ?? "").toLowerCase().split(/[\s(]/)[0] ?? "";
  return CATEGORY_TOKENS[key] ?? "stone";
}

/**
 * LED color family of a port (woodshop nodes): strings and Text amber, numbers green, bools
 * yellow, media structs magenta, Error red, other structured types (struct, enum, Json, File,
 * binary) frosted white, unbound `$T` "any".
 * The CSS colors are `--bf-led-<family>`.
 */
export type LedFamily = "text" | "num" | "bool" | "media" | "data" | "error" | "any";

const PRIMITIVE_LEDS: Record<string, LedFamily> = {
  string: "text",
  int: "num",
  float: "num",
  bool: "bool",
  binary: "data",
};

const BUILTIN_LEDS: Record<string, LedFamily> = {
  "briar.Text": "text",
  "briar.Image": "media",
  "briar.Video": "media",
  "briar.Audio": "media",
  "briar.Model3D": "media",
  "briar.Error": "error",
};

/**
 * LED family of a type; `list<X>` and `X?` take X's family.
 *
 * @example
 * ```ts
 * ledFamily({ kind: "list", of: { kind: "primitive", name: "int" } }); // "num"
 * ```
 */
export function ledFamily(type: TypeRef, kindOf?: NamedKindLookup): LedFamily {
  switch (type.kind) {
    case "primitive":
      return PRIMITIVE_LEDS[type.name] ?? "data";
    case "named":
      return BUILTIN_LEDS[kindOf?.root?.(type.id) ?? type.id] ?? "data";
    case "list":
    case "optional":
      return ledFamily(type.of, kindOf);
    case "var":
      return "any";
  }
}

/** `list<X>` or `list<X>?`: the LED is a bar instead of a dot. */
export function isListType(type: TypeRef): boolean {
  return type.kind === "list" || (type.kind === "optional" && type.of.kind === "list");
}

/** The theme object (`briarTheme`) with the same names as the CSS tokens. */
export const briarTheme = {
  tokens: BRIAR_TOKENS,
  tokenVar,
  typeStyle,
  typeColor,
  nodeAccent,
} as const;
