/**
 * Internal helpers: failing with a CommandError, immutable array/object updates.
 */
import { CommandError } from "../result.js";

/** Throws a {@link CommandError}; caught by the batch runner and located there. */
export function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new CommandError(code, message, details === undefined ? {} : { details });
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy of `obj` without `key` (same object when the key is absent). */
export function without<T extends object, K extends keyof T>(obj: T, key: K): T {
  if (!(key in obj)) return obj;
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

/** Copy of `obj` with `key` set, or removed when `value` is undefined. */
export function withKey<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
  if (value === undefined) return without(obj, key);
  return { ...obj, [key]: value };
}

export function replaceAt<T>(arr: readonly T[], index: number, value: T): T[] {
  const copy = arr.slice();
  copy[index] = value;
  return copy;
}

export function insertAt<T>(arr: readonly T[], index: number, value: T): T[] {
  const copy = arr.slice();
  copy.splice(Math.max(0, Math.min(index, copy.length)), 0, value);
  return copy;
}

export function removeAt<T>(arr: readonly T[], index: number): T[] {
  const copy = arr.slice();
  copy.splice(index, 1);
  return copy;
}

export function moveTo<T>(arr: readonly T[], from: number, to: number): T[] {
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item as T);
  return copy;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Case-insensitive lookup: the existing name equal to `name` ignoring case, else undefined. */
export function sameNameIgnoringCase(names: Iterable<string>, name: string, except?: string): string | undefined {
  const lower = name.toLowerCase();
  for (const n of names) if (n !== except && n.toLowerCase() === lower) return n;
  return undefined;
}

/** Plain JSON copy (documents and payload values are JSON). */
export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
