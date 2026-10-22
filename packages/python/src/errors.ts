import { BriarError } from "@briarflow/core";
import type { BriarErrorOptions } from "@briarflow/core";

/**
 * Errors of the Python bridge outside node execution (loading a pack, starting a worker).
 * Codes: `python.unreachable`, `python.unsupported_protocol`, `python.protocol_error`,
 * `python.worker_not_ready`, `python.worker_exited`, `python.invalid_options` (bad bridge
 * options, e.g. `mediaServer.publicUrl`), or a worker error code such as
 * `protocol.unauthorized`. Execution failures are thrown as `NodeError`.
 *
 * @example
 * ```ts
 * try { await pythonPack({ url }); } catch (err) { if (isBriarError(err) && err.code === "python.unreachable") … }
 * ```
 */
export class PythonBridgeError extends BriarError {}

export function bridgeError(code: string, message: string, options: BriarErrorOptions = {}): PythonBridgeError {
  return new PythonBridgeError(code, message, options);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${err.message} (${cause.message})`;
  return err.message;
}
