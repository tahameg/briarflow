/** Structured log data; JSON-serializable. */
export type LogData = Record<string, unknown>;

/**
 * Minimal structured logger. Adapt your logger (pino, console, …) to this shape.
 *
 * @example
 * ```ts
 * const logger: Logger = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
 * ```
 */
export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
}

/** A logger that drops everything. The default wherever a logger is optional. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
