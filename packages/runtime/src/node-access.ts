/**
 * What a node may read beyond its inputs: vault secrets it was given and its pack's
 * settings (ctx.secrets.read, ctx.settings.get).
 */
import { NodeError } from "@briarflow/core";
import type { PackSetting, ResolvedPort, SecretVault, SettingsStore, TypeRef } from "@briarflow/core";

/** Secret names held by a value of `type` (secret, optional, list of either). */
export function secretRefs(value: unknown, type: TypeRef, out: Set<string> = new Set()): Set<string> {
  if (value === null || value === undefined) return out;
  if (type.kind === "optional") return secretRefs(value, type.of, out);
  if (type.kind === "list" && Array.isArray(value)) {
    for (const item of value) secretRefs(item, type.of, out);
    return out;
  }
  if (type.kind === "primitive" && type.name === "secret" && typeof value === "string") out.add(value);
  return out;
}

/** The secret names in a node's resolved inputs. */
export function inputSecretRefs(ports: readonly ResolvedPort[], inputs: Readonly<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const p of ports) secretRefs(inputs[p.name], p.type, out);
  return out;
}

/** `ctx.settings` and `ctx.secrets.read` of one node attempt. */
export function nodeAccess(options: {
  title: string;
  settings: readonly PackSetting[];
  store: SettingsStore | undefined;
  vault: SecretVault | undefined;
  allowed: Set<string>;
}): { readSetting(name: string): Promise<unknown>; readSecret(ref: string): Promise<string> } {
  const { title, settings, store, vault, allowed } = options;
  return {
    async readSetting(name) {
      const decl = settings.find((s) => s.name === name);
      if (!decl) {
        throw new NodeError("node.unknown_setting", `Node ${title} asked for setting "${name}", which its pack does not declare. Settings: ${settings.map((s) => s.name).join(", ") || "none"}.`, {
          details: { setting: name },
        });
      }
      const stored = store ? await store.get(decl.key) : undefined;
      const value = stored === undefined || stored === null ? (decl.default ?? null) : stored;
      // A secret setting gives the node the right to read that secret.
      secretRefs(value, decl.type, allowed);
      return value;
    },
    async readSecret(ref) {
      if (typeof ref !== "string" || !allowed.has(ref)) {
        throw new NodeError("node.secret_not_allowed", `Node ${title} asked for secret "${String(ref)}", which none of its inputs or settings gives it.`, {
          details: { secret: typeof ref === "string" ? ref : null },
        });
      }
      const found = vault ? await vault.reveal(ref) : undefined;
      if (!found) {
        throw new NodeError("node.missing_secret", `Node ${title} needs secret "${ref}", which is not in the vault. Create it in Secrets or pick another one.`, {
          details: { secret: ref },
        });
      }
      return found.value;
    },
  };
}
