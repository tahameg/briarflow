/**
 * The secret vault in the editor (docs/specs/secrets.md): `<VaultProvider>` keeps the list of
 * secret names, `<SecretPicker>` picks one (with a "+" that opens the new-secret dialog) and
 * `<SecretsPanel>` manages them. Values are typed here and sent to the server; nothing ever
 * reads them back.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SECRET_KINDS } from "@briarflow/core";
import type { NewSecret, SecretInfo, SecretKind } from "@briarflow/core";
import { Button, ConfirmDialog, Modal } from "./ui.js";

/** What the editor needs from a vault (`client.secrets` fits). */
export interface VaultAccess {
  list(): Promise<SecretInfo[]>;
  create(secret: NewSecret): Promise<SecretInfo>;
  update(name: string, value: string): Promise<SecretInfo>;
  delete(name: string): Promise<void>;
}

/** Options of {@link VaultApi.requestNew}. */
export interface NewSecretRequest {
  /** Fixes the kind (e.g. a port that takes `secret({ kind: "apiKey" })`). */
  kind?: SecretKind;
  /** Called with the new secret's name once it is created. */
  onCreated?: (name: string) => void;
}

/** State and actions of the nearest {@link VaultProvider}. */
export interface VaultApi {
  readonly secrets: readonly SecretInfo[];
  readonly status: "loading" | "ready" | "error";
  readonly error: string | undefined;
  refresh(): Promise<void>;
  create(secret: NewSecret): Promise<SecretInfo>;
  update(name: string, value: string): Promise<SecretInfo>;
  remove(name: string): Promise<void>;
  /** Opens the new-secret dialog. */
  requestNew(request?: NewSecretRequest): void;
}

const VaultContext = createContext<VaultApi | undefined>(undefined);

const KIND_LABEL: Record<SecretKind, string> = { apiKey: "API key", text: "text", number: "number", json: "JSON" };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Makes a vault available to `<SecretPicker>`, `<SecretsPanel>` and secret inputs of
 * `<ValueEditor>`. Renders the new-secret dialog.
 *
 * @example
 * ```tsx
 * <VaultProvider vault={client.secrets}><Workspace /></VaultProvider>
 * ```
 */
export function VaultProvider({ vault, children }: { vault: VaultAccess; children?: ReactNode }) {
  const [secrets, setSecrets] = useState<readonly SecretInfo[]>([]);
  const [status, setStatus] = useState<VaultApi["status"]>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [request, setRequest] = useState<NewSecretRequest | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSecrets(await vault.list());
      setStatus("ready");
      setError(undefined);
    } catch (err) {
      setStatus("error");
      setError(messageOf(err));
    }
  }, [vault]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const api = useMemo<VaultApi>(
    () => ({
      secrets,
      status,
      error,
      refresh,
      async create(secret) {
        const info = await vault.create(secret);
        await refresh();
        return info;
      },
      async update(name, value) {
        const info = await vault.update(name, value);
        await refresh();
        return info;
      },
      async remove(name) {
        await vault.delete(name);
        await refresh();
      },
      requestNew: (r = {}) => setRequest(r),
    }),
    [secrets, status, error, refresh, vault],
  );

  return (
    <VaultContext.Provider value={api}>
      {children}
      <NewSecretDialog request={request} onClose={() => setRequest(undefined)} />
    </VaultContext.Provider>
  );
}

/** The nearest vault, or `undefined` outside a `<VaultProvider>`. */
export function useVault(): VaultApi | undefined {
  return useContext(VaultContext);
}

function NewSecretDialog({ request, onClose }: { request: NewSecretRequest | undefined; onClose: () => void }) {
  const vault = useVault();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SecretKind>("apiKey");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const open = request !== undefined;

  useEffect(() => {
    if (!open) return;
    setName("");
    setValue("");
    setError(undefined);
    setKind(request?.kind ?? "apiKey");
    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open, request]);

  const submit = async () => {
    if (!vault || busy) return;
    setBusy(true);
    try {
      const info = await vault.create({ name: name.trim(), kind, value });
      request?.onCreated?.(info.name);
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="New secret" onClose={onClose} className="bf-modal--narrow">
      <form
        className="bf-secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="bf-secret-form__row">
          <span>Name</span>
          <input ref={nameRef} className="bf-input" value={name} placeholder="OPENAI_KEY" autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="bf-secret-form__row">
          <span>Kind</span>
          <select className="bf-input bf-input--select" value={kind} disabled={request?.kind !== undefined} onChange={(e) => setKind(e.target.value as SecretKind)}>
            {SECRET_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="bf-secret-form__row">
          <span>Value</span>
          {kind === "json" ? (
            <textarea className="bf-input bf-input--textarea" rows={4} value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input className="bf-input" type={kind === "apiKey" ? "password" : "text"} autoComplete="new-password" value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
          )}
        </label>
        <p className="bf-muted bf-secret-form__note">The value goes to the server and cannot be shown again. You can replace it later.</p>
        {error ? (
          <p className="bf-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bf-secret-form__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || name.trim() === "" || value === ""}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Props of {@link SecretPicker}. */
export interface SecretPickerProps {
  /** Selected secret name. */
  value: string | undefined;
  onChange: (name: string | undefined) => void;
  /** Only secrets of this kind are offered. */
  kind?: SecretKind | undefined;
  label: string;
  compact?: boolean;
  disabled?: boolean;
}

/**
 * Picks a vault secret by name; "+" opens the new-secret dialog and picks the new one.
 * Outside a `<VaultProvider>` it is a plain name field.
 *
 * @example
 * ```tsx
 * <SecretPicker value={ref} kind="apiKey" label="API key" onChange={setRef} />
 * ```
 */
export function SecretPicker({ value, onChange, kind, label, compact, disabled }: SecretPickerProps) {
  const vault = useVault();
  const cls = `bf-input bf-input--select${compact ? " bf-input--compact" : ""} nodrag`;
  if (!vault) {
    return (
      <input
        className={`bf-input${compact ? " bf-input--compact" : ""} nodrag`}
        aria-label={label}
        placeholder="secret name"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      />
    );
  }
  const options = vault.secrets.filter((s) => kind === undefined || s.kind === kind);
  const missing = value !== undefined && value !== "" && !vault.secrets.some((s) => s.name === value);
  return (
    <span className="bf-secret-picker nodrag">
      <select
        className={cls}
        aria-label={label}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <option value="">{vault.status === "loading" ? "loading…" : options.length === 0 ? "no secrets yet" : "— pick a secret —"}</option>
        {missing ? <option value={value}>{value} (missing)</option> : null}
        {options.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="bf-secret-picker__add"
        title={kind ? `New ${KIND_LABEL[kind]} secret` : "New secret"}
        aria-label={`New secret for ${label}`}
        disabled={disabled}
        onClick={() => vault.requestNew({ ...(kind ? { kind } : {}), onCreated: (name) => onChange(name) })}
      >
        +
      </button>
    </span>
  );
}

/**
 * Lists the vault's secrets (name, kind, last change) to add, replace the value of, or delete.
 *
 * @example
 * ```tsx
 * <VaultProvider vault={client.secrets}><SecretsPanel /></VaultProvider>
 * ```
 */
export function SecretsPanel() {
  const vault = useVault();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  if (!vault) return <p className="bf-muted">No vault: the app did not connect one.</p>;
  const run = (work: Promise<unknown>) =>
    work.then(
      () => setError(undefined),
      (err: unknown) => setError(messageOf(err)),
    );
  return (
    <div className="bf-secrets">
      <div className="bf-secrets__bar">
        <span className="bf-muted">Values are stored on the server, encrypted, and never shown again.</span>
        <Button size="sm" variant="primary" onClick={() => vault.requestNew()}>
          + New secret
        </Button>
      </div>
      {vault.status === "error" ? <p className="bf-field__error">Could not load the secrets: {vault.error}</p> : null}
      {error ? (
        <p className="bf-field__error" role="alert">
          {error}
        </p>
      ) : null}
      <table className="bf-plain-table">
        <thead>
          <tr>
            <th>name</th>
            <th>kind</th>
            <th>changed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {vault.secrets.length === 0 ? (
            <tr>
              <td colSpan={4} className="bf-muted">
                No secrets yet.
              </td>
            </tr>
          ) : null}
          {vault.secrets.map((s) => (
            <tr key={s.name}>
              <td className="bf-code">{s.name}</td>
              <td>{KIND_LABEL[s.kind]}</td>
              <td className="bf-muted">{s.updatedAt.slice(0, 16).replace("T", " ")}</td>
              <td className="bf-plain-table__actions">
                {editing === s.name ? (
                  <form
                    className="bf-secrets__replace"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(vault.update(s.name, draft)).then(() => setEditing(undefined));
                    }}
                  >
                    <input className="bf-input bf-input--compact" type={s.kind === "apiKey" ? "password" : "text"} autoComplete="new-password" aria-label={`New value of ${s.name}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <Button size="sm" type="submit" variant="primary" disabled={draft === ""}>
                      Save
                    </Button>
                    <Button size="sm" onClick={() => setEditing(undefined)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setDraft("");
                        setEditing(s.name);
                      }}
                    >
                      Replace value
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleting(s.name)}>
                      Delete
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConfirmDialog
        open={deleting !== undefined}
        title={`Delete secret ${deleting ?? ""}?`}
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => {
          const name = deleting;
          setDeleting(undefined);
          if (name) void run(vault.remove(name));
        }}
      >
        Nodes, variables and settings that pick it fail at run time until you pick another one.
      </ConfirmDialog>
    </div>
  );
}
