/**
 * Assertion helpers for Briarflow errors (uses Vitest's `expect`).
 */
import { expect } from "vitest";
import { isBriarError, type BriarError } from "@briarflow/core";

/** Runs `fn` and returns what it threw (`undefined` when it did not throw). */
export function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Awaits `promise` and returns its rejection reason (`undefined` when it resolved). */
export async function catchRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

type ErrorClass = abstract new (...args: never[]) => BriarError;

function check(thrown: unknown, code: string, errorClass?: ErrorClass): BriarError {
  expect(isBriarError(thrown), `expected a BriarError "${code}", got ${String(thrown)}`).toBe(true);
  const error = thrown as BriarError;
  expect(error.code).toBe(code);
  if (errorClass) expect(error).toBeInstanceOf(errorClass);
  return error;
}

/** Asserts that `fn` throws a `BriarError` with `code` (and of `errorClass`); returns it. */
export function expectBriarError(fn: () => unknown, code: string, errorClass?: ErrorClass): BriarError {
  return check(catchError(fn), code, errorClass);
}

/** Async variant of {@link expectBriarError}. */
export async function expectBriarRejection(promise: Promise<unknown>, code: string, errorClass?: ErrorClass): Promise<BriarError> {
  return check(await catchRejection(promise), code, errorClass);
}
