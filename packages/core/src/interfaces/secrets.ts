/**
 * Resolves secrets (API keys) by name. `undefined` = not configured.
 *
 * @example
 * ```ts
 * const secrets: SecretResolver = { get: async (name) => process.env[name] };
 * ```
 */
export interface SecretResolver {
  get(name: string): Promise<string | undefined>;
}
