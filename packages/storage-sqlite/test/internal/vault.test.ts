import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSecretVault, SqliteSettingsStore, loadVaultKey, parseVaultKey } from "../../src/index.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "briar-vault-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SqliteSecretVault", () => {
  it("stores values encrypted and gives them back only through reveal", async () => {
    const dir = tempDir();
    const file = join(dir, "db.sqlite");
    const key = loadVaultKey(join(dir, "vault.key"));
    const vault = new SqliteSecretVault({ file, key, clock: () => new Date("2026-10-24T00:00:00.000Z") });
    await vault.create({ name: "OPENAI_KEY", kind: "apiKey", value: "sk-plain-text-value" });
    expect(await vault.list()).toEqual([{ name: "OPENAI_KEY", kind: "apiKey", createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" }]);
    expect(await vault.reveal("OPENAI_KEY")).toEqual({ kind: "apiKey", value: "sk-plain-text-value" });
    vault.close();
    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from("sk-plain-text-value"))).toBe(false);
    const db = new Database(file);
    const row = db.prepare("SELECT value FROM vault_secrets").get() as { value: Buffer };
    expect(row.value.toString("utf8")).not.toContain("sk-plain");
    db.close();
  });

  it("keeps secrets across opens with the same key; another key cannot read them", async () => {
    const dir = tempDir();
    const file = join(dir, "db.sqlite");
    const keyFile = join(dir, "vault.key");
    const first = new SqliteSecretVault({ file, key: loadVaultKey(keyFile) });
    await first.create({ name: "N", kind: "number", value: "42" });
    first.close();
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const again = new SqliteSecretVault({ file, key: loadVaultKey(keyFile) });
    expect(await again.reveal("N")).toEqual({ kind: "number", value: "42" });
    await again.update("N", "7");
    expect(await again.reveal("N")).toEqual({ kind: "number", value: "7" });
    await expect(again.update("N", "x")).rejects.toMatchObject({ code: "secret.invalid" });
    await expect(again.create({ name: "N", kind: "text", value: "y" })).rejects.toMatchObject({ code: "secret.exists" });
    again.close();
    const other = new SqliteSecretVault({ file, key: parseVaultKey("ab".repeat(32)) });
    await expect(other.reveal("N")).rejects.toMatchObject({ code: "vault.unreadable" });
    await other.delete("N");
    await expect(other.delete("N")).rejects.toMatchObject({ code: "secret.not_found" });
    other.close();
  });

  it("refuses a bad key", () => {
    expect(() => parseVaultKey("short")).toThrow(/32 bytes/);
  });
});

describe("SqliteSettingsStore", () => {
  it("sets, reads and clears JSON values by key", async () => {
    const store = new SqliteSettingsStore({ file: ":memory:" });
    await store.set("openai.chatKey", "OPENAI_KEY");
    await store.set("openai.limits", { rpm: 10 });
    expect(await store.get("openai.chatKey")).toBe("OPENAI_KEY");
    expect(await store.all()).toEqual({ "openai.chatKey": "OPENAI_KEY", "openai.limits": { rpm: 10 } });
    await store.set("openai.chatKey", undefined);
    expect(await store.get("openai.chatKey")).toBeUndefined();
    store.close();
  });
});
