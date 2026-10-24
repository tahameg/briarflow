# Spec: Secret vault

Status: implemented 2026-10-24. Owner: designer (written by the orchestrator in single-developer mode).

The user keeps named secrets (API keys, tokens, numbers, JSON blobs) in a vault on the server.
A value is typed once in the studio, sent to the server and **never read back**: documents,
editors and run events only ever hold the secret's **name**. Nodes read the value on the server.

## 1. Secrets

| Field | Meaning |
|---|---|
| `name` | Unique, chosen by the user. `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$` (`OPENAI_KEY`, `prod.openai-key`) |
| `kind` | `apiKey` (text the studio never shows), `text`, `number` (must read as a finite number), `json` (must parse) |
| value | Non-empty text, at most 64 KiB. Stored encrypted; changed with "Replace value", never shown |
| `createdAt`, `updatedAt` | ISO times |

Renaming is not supported: create a new secret and pick it where the old one was used.

## 2. The `secret` type

- Primitive `secret` (`t.secret({ kind? })`, shorthand `secret`). Its value is a secret name
  (`SecretRef = string`). Assignable only to `secret`; `kind` is a constraint that only filters
  what pickers offer.
- Usable anywhere a type is: node ports, flow inputs, variables, globals, pack settings.
- Editors show a dropdown of existing secret names (of the port's kind) with a **+** button that
  opens the new-secret dialog and picks the new secret. An optional secret has no "set" box:
  picking nothing is no secret.

## 3. Reading a secret in a node

`ctx.secrets.read(ref)` returns the value. A node may read only the names it was **given**:

- the value of one of its `secret` inputs (also inside optionals and lists), or
- a `secret` setting of its pack it read with `ctx.settings.get` (settings.md).

Anything else → `node.secret_not_allowed` (so a flow cannot make a node read an arbitrary
secret by name from a text input). A name missing from the vault → `node.missing_secret`.
Nodes must not put revealed values into outputs or logs.

`ctx.secrets.get(name)` (secrets declared in `defineNode({ secrets })`, from the environment
resolver) is unchanged.

## 4. Server side

- Core: `SecretVault` (`list` without values, `create`, `update`, `delete`, `reveal` for the
  engine), `createMemoryVault()`, `secretProblem()` / `secretValueProblem()`.
- `@briarflow/storage-sqlite`: `SqliteSecretVault` (table `vault_secrets`, AES-256-GCM per
  value with a random IV) and `loadVaultKey(file)` / `parseVaultKey(text)`.
- Engine option `vault`; facade option `vault` (default: in memory) and `briar.vault`.
- `apps/server`: the vault lives in `briarflow.db`; the key comes from `BRIAR_VAULT_KEY`
  (64 hex characters) or `<dataDir>/vault.key`, created (mode 0600) on first start. Losing the
  key makes stored values unreadable (`vault.unreadable`): create the secrets again.
- REST: `/secrets` (rest-api.md). Authorize actions `secrets.list`, `secrets.write`.

## 5. Error codes

| Code | HTTP | When |
|---|---|---|
| `secret.invalid` | 422 | bad name, kind or value |
| `secret.exists` | 409 | create with a name in use |
| `secret.not_found` | 404 | update / delete of an unknown name |
| `vault.invalid_key` | — | the vault key is not 32 bytes |
| `vault.unreadable` | — | a stored value cannot be decrypted with the current key |
| `node.secret_not_allowed` | — | `ctx.secrets.read` of a name the node was not given |
| `node.missing_secret` | — | the name is not in the vault |
