# Spec: Settings

Status: implemented 2026-10-24. Owner: designer (written by the orchestrator in single-developer mode).

One settings screen for the whole studio. It is extensible from two sides:

1. **Packs** declare settings; the server stores their values (per server, not per context).
2. **Apps** add their own sections (any React content).

## 1. Pack settings

```ts
definePack({
  name: "openai",
  settings: {
    defaultKey: { type: t.optional(t.secret({ kind: "apiKey" })), title: "Default API key", description: "…" },
    baseUrl: { type: t.text(), default: "https://api.openai.com/v1" },
  },
  nodes: [...],
});
```

- Keys are `<pack>.<name>` (`openai.defaultKey`). Names follow field-name rules.
- Types: primitives, lists and optionals of them (no named or generic types). Defaults are
  validated at definition time.
- `NodePack.settings` lists them; `GET /node-types` and `GET /settings` carry them.
- Nodes read their own pack's settings: `await ctx.settings.get("defaultKey")` → stored value,
  else the default, else `null`. Undeclared → `node.unknown_setting`. Reading a `secret`
  setting allows the node to `ctx.secrets.read` that secret (secrets.md §3).

## 2. Storage and API

- Core `SettingsStore` (`all`, `get`, `set`), `createMemorySettings()`;
  `@briarflow/storage-sqlite` `SqliteSettingsStore` (table `settings`, JSON per key).
- Engine option `settings`; facade option `settings` and `briar.settings.info()` /
  `briar.settings.set(key, value)` (validates: `settings.unknown`, `settings.invalid`; `null`
  clears).
- REST: `GET /settings`, `POST /settings` (rest-api.md).

## 3. Editor

`<SettingsPanel settings={client.settings} sections={[…]} />` (editor-react): a list of
sections on the left, the chosen one on the right.

- App sections: `{ id, title, description?, order?, render() }`. Default order 100.
- Pack sections come from the server, one per pack with settings (order 500), with one typed
  field per setting (`ValueEditor`; secret settings get the secret picker with **+**). A change
  is saved at once; × clears it.
- The studio adds "Secrets" (order 10, the vault: `<SecretsPanel>`) and "Studio" (order 900:
  reset the panel layout). It opens from **Settings** in the top bar.
