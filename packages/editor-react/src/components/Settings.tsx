/**
 * `<SettingsPanel>`: the settings screen (docs/specs/settings.md). Sections come from two
 * places: the app (`sections`, any React content, e.g. the vault) and the loaded packs (every
 * `definePack({ settings })` becomes a section of typed fields, stored on the server).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { PackSetting } from "@briarflow/core";
import { ValueEditor } from "./ValueEditor.js";

/** Declared settings (with their packs) and stored values, as `GET /settings` returns them. */
export interface PackSettingsInfo {
  settings: (PackSetting & { pack: string; packTitle: string })[];
  values: Record<string, unknown>;
}

/** What the settings screen needs from the server (`client.settings` fits). */
export interface SettingsAccess {
  get(): Promise<PackSettingsInfo>;
  /** `null` clears the value. */
  set(key: string, value: unknown): Promise<PackSettingsInfo>;
}

/** A section the app adds to the settings screen. */
export interface SettingsSection {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Sort key; pack sections use 500. Default 100. */
  order?: number;
  render(): ReactNode;
}

/** Props of {@link SettingsPanel}. */
export interface SettingsPanelProps {
  /** Pack settings on the server. Without it only `sections` show. */
  settings?: SettingsAccess;
  /** App sections, e.g. `{ id: "secrets", title: "Secrets", render: () => <SecretsPanel /> }`. */
  sections?: readonly SettingsSection[];
  /** Section shown first. Default: the first one. */
  initial?: string;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * @example
 * ```tsx
 * <SettingsPanel settings={client.settings} sections={[{ id: "secrets", title: "Secrets", render: () => <SecretsPanel /> }]} />
 * ```
 */
export function SettingsPanel({ settings, sections = [], initial }: SettingsPanelProps) {
  const [info, setInfo] = useState<PackSettingsInfo | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!settings) return;
    try {
      setInfo(await settings.get());
      setLoadError(undefined);
    } catch (err) {
      setLoadError(messageOf(err));
    }
  }, [settings]);

  useEffect(() => {
    void load();
  }, [load]);

  const all = useMemo(() => {
    const packs = new Map<string, { title: string; items: PackSettingsInfo["settings"] }>();
    for (const s of info?.settings ?? []) {
      const entry = packs.get(s.pack) ?? { title: s.packTitle, items: [] };
      entry.items.push(s);
      packs.set(s.pack, entry);
    }
    const packSections: SettingsSection[] = [...packs].map(([pack, { title, items }]) => ({
      id: `pack:${pack}`,
      title,
      order: 500,
      render: () => <PackSettings items={items} values={info?.values ?? {}} settings={settings} onChange={setInfo} />,
    }));
    return [...sections, ...packSections].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }, [sections, info, settings]);

  const [active, setActive] = useState<string | undefined>(initial);
  const current = all.find((s) => s.id === active) ?? all[0];

  return (
    <div className="bf-settings">
      <nav className="bf-settings__nav" aria-label="Settings sections">
        {all.map((s) => (
          <button key={s.id} type="button" className={`bf-settings__tab${s === current ? " bf-settings__tab--active" : ""}`} aria-current={s === current ? "page" : undefined} onClick={() => setActive(s.id)}>
            {s.title}
          </button>
        ))}
        {all.length === 0 ? <span className="bf-muted">Nothing to set.</span> : null}
      </nav>
      <section className="bf-settings__body">
        {loadError ? <p className="bf-field__error">Could not load the settings: {loadError}</p> : null}
        {current ? (
          <>
            <h3 className="bf-settings__title">{current.title}</h3>
            {current.description ? <p className="bf-muted">{current.description}</p> : null}
            {current.render()}
          </>
        ) : null}
      </section>
    </div>
  );
}

function PackSettings({
  items,
  values,
  settings,
  onChange,
}: {
  items: PackSettingsInfo["settings"];
  values: Record<string, unknown>;
  settings: SettingsAccess | undefined;
  onChange: (info: PackSettingsInfo) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = (key: string, value: unknown) => {
    if (!settings) return;
    settings.set(key, value === undefined ? null : value).then(
      (info) => {
        onChange(info);
        setErrors(({ [key]: _gone, ...rest }) => rest);
      },
      (err: unknown) => setErrors((e) => ({ ...e, [key]: messageOf(err) })),
    );
  };
  return (
    <div className="bf-settings__fields">
      {items.map((s) => {
        const stored = values[s.key];
        return (
          <div key={s.key} className="bf-settings__field">
            <div className="bf-settings__label">
              <span>{s.title}</span>
              <span className="bf-muted bf-code">{s.key}</span>
            </div>
            {s.description ? <p className="bf-muted bf-settings__help">{s.description}</p> : null}
            <ValueEditor
              type={s.type}
              label={s.title}
              value={stored}
              placeholder={s.default !== undefined ? String(s.default) : undefined}
              onCommit={(v) => save(s.key, v)}
              onClear={stored === undefined ? undefined : () => save(s.key, null)}
            />
            {errors[s.key] ? <p className="bf-field__error">{errors[s.key]}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
