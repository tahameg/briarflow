/**
 * What a node may read beyond its inputs: vault secrets it was given and its pack's
 * settings (ctx.secrets.read, ctx.settings.get).
 */
import { BUILTIN, NodeError, extendsStruct } from "@briarflow/core";
import type { DeclResolver, PackSetting, ResolvedPort, SecretVault, SettingsStore, TypeRef } from "@briarflow/core";

/** Secret names held by a value of `type` (a Secret or a struct extending it, optional, list of either). */
export function secretRefs(value: unknown, type: TypeRef, resolve?: DeclResolver, out: Set<string> = new Set()): Set<string> {
  if (value === null || value === undefined) return out;
  if (type.kind === "optional") return secretRefs(value, type.of, resolve, out);
  if (type.kind === "list" && Array.isArray(value)) {
    for (const item of value) secretRefs(item, type.of, resolve, out);
    return out;
  }
  if (type.kind !== "named") return out;
  const isSecret = type.id === BUILTIN.Secret || type.id === BUILTIN.ApiKey || (resolve !== undefined && extendsStruct(type.id, BUILTIN.Secret, resolve));
  const name = typeof value === "object" ? (value as { name?: unknown }).name : undefined;
  if (isSecret && typeof name === "string") out.add(name);
  return out;
}

/** The secret names in a node's resolved inputs. */
export function inputSecretRefs(ports: readonly ResolvedPort[], inputs: Readonly<Record<string, unknown>>, resolve?: DeclResolver): Set<string> {
  const out = new Set<string>();
  for (const p of ports) secretRefs(inputs[p.name], p.type, resolve, out);
  return out;
}

/** `ctx.settings` and `ctx.secrets.read` of one node attempt. */
export function nodeAccess(options: {
  title: string;
  settings: readonly PackSetting[];
  store: SettingsStore | undefined;
  vault: SecretVault | undefined;
  allowed: Set<string>;
}): { readSetting(name: string): Promise<unknown>; readSecret(ref: string | { name: string }): Promise<string> } {
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
      secretRefs(value, decl.type, undefined, allowed);
      return value;
    },
    async readSecret(given) {
      // A Secret value ({ name }) or its name.
      const ref = typeof given === "object" && given !== null ? (given as { name?: unknown }).name : given;
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
