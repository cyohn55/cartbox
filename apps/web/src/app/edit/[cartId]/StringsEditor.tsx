"use client";

/**
 * The Text tab (ENGINE_PARITY_ROADMAP.md EP19b): the cart's string table — each
 * player-facing text under a key, in every language the cart speaks. The cart
 * reads it with cartbox.text(key, ...); a UI widget whose text is `@key` shows
 * it. Untranslated cells are flagged, and keys the UI documents use but the
 * table lacks can be added in one go.
 */

import { useMemo, useState } from "react";

import {
  MAX_LANGUAGES,
  MAX_STRINGS,
  isStringKey,
  languageCode,
  languageName,
  missingTranslations,
  uiStringKeys,
  type StringTable,
  type UiDocument,
} from "@cartbox/editor";

import { setMeshStrings, type MeshSidecar } from "@/lib/meshSidecar";
import { RailGroup, RailHint } from "./railControls";

const cell = { padding: "4px 6px", verticalAlign: "top", borderTop: "1px solid rgba(255,255,255,0.06)" } as const;
const input = { font: "inherit", width: "100%", boxSizing: "border-box", padding: "4px 6px", background: "var(--well)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: 4 } as const;

const STARTER: StringTable = { languages: ["en"], fallback: "en", entries: [] };

export function StringsEditor({ sidecar, ui, onSidecarChange }: { sidecar: MeshSidecar; ui: readonly UiDocument[]; onSidecarChange: (next: MeshSidecar) => void }) {
  const table = sidecar.strings ?? null;
  const [newLanguage, setNewLanguage] = useState("");
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = (next: StringTable | null) => {
    setError(null);
    onSidecarChange(setMeshStrings(sidecar, next));
  };
  const missing = useMemo(() => (table ? missingTranslations(table) : new Map<string, string[]>()), [table]);
  const unknownUiKeys = useMemo(() => {
    const have = new Set(table?.entries.map((e) => e.key) ?? []);
    return uiStringKeys(ui).filter((k) => !have.has(k));
  }, [table, ui]);

  const addLanguage = () => {
    const code = languageCode(newLanguage);
    const base = table ?? STARTER;
    if (!code) return setError("A language is a code like en, es or pt-br.");
    if (base.languages.includes(code)) return setError(`The table already has ${code}.`);
    if (base.languages.length >= MAX_LANGUAGES) return setError(`At most ${MAX_LANGUAGES} languages.`);
    save({ ...base, languages: [...base.languages, code] });
    setNewLanguage("");
  };
  const removeLanguage = (code: string) => {
    if (!table) return;
    const languages = table.languages.filter((l) => l !== code);
    if (languages.length === 0) return save(null);
    save({
      languages,
      fallback: table.fallback === code ? languages[0]! : table.fallback,
      entries: table.entries.map((e) => {
        const { [code]: _drop, ...text } = e.text;
        void _drop;
        return { ...e, text };
      }),
    });
  };
  const addKeys = (keys: readonly string[]) => {
    const base = table ?? STARTER;
    const have = new Set(base.entries.map((e) => e.key));
    const fresh = keys.filter((k) => isStringKey(k) && !have.has(k));
    if (fresh.length === 0) return setError("Keys start with a letter and use letters, digits, dots, dashes and underscores; each once.");
    if (base.entries.length + fresh.length > MAX_STRINGS) return setError(`At most ${MAX_STRINGS} strings.`);
    save({ ...base, entries: [...base.entries, ...fresh.map((key) => ({ key, text: {} }))] });
  };
  const setText = (index: number, language: string, value: string) => {
    if (!table) return;
    save({
      ...table,
      entries: table.entries.map((e, i) => {
        if (i !== index) return e;
        const { [language]: _old, ...rest } = e.text;
        void _old;
        return { ...e, text: value === "" ? rest : { ...rest, [language]: value } };
      }),
    });
  };
  const renameKey = (index: number, key: string) => {
    if (!table) return;
    if (!isStringKey(key) || table.entries.some((e, i) => i !== index && e.key === key)) return setError(`“${key}” can't be a key here (taken, or not a valid key).`);
    save({ ...table, entries: table.entries.map((e, i) => (i === index ? { ...e, key } : e)) });
  };
  const removeKey = (index: number) => {
    if (!table) return;
    save({ ...table, entries: table.entries.filter((_, i) => i !== index) });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 1200 }}>
      <RailGroup label="Text and languages">
        <RailHint>
          Every player-facing text under a key, in each language. The cart reads cartbox.text(&quot;key&quot;, …) — {"{1}"}, {"{2}"}… fill from its
          arguments, {"{name}"} from a table — and a UI widget whose text is @key shows it. Players get the first of their languages the cart has (else
          the ★ fallback); cartbox.setlanguage switches in-game.
        </RailHint>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
          {(table?.languages ?? []).map((l) => (
            <span key={l} style={{ display: "inline-flex", gap: 4, alignItems: "center", padding: "2px 8px", borderRadius: 999, background: "rgba(255,255,255,0.08)" }}>
              <button
                type="button"
                title={table?.fallback === l ? "The fallback language" : "Make this the fallback language"}
                aria-pressed={table?.fallback === l}
                onClick={() => table && save({ ...table, fallback: l })}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0 }}
              >
                {table?.fallback === l ? "★" : "☆"}
              </button>
              {languageName(l)} <span style={{ opacity: 0.6 }}>({l})</span>
              {(missing.get(l)?.length ?? 0) > 0 && <span style={{ color: "#fbbf24", fontSize: 12 }}>{missing.get(l)!.length} missing</span>}
              <button type="button" aria-label={`Remove ${l}`} onClick={() => removeLanguage(l)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
                ×
              </button>
            </span>
          ))}
          <form
            style={{ display: "flex", gap: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              addLanguage();
            }}
          >
            <input aria-label="New language code" placeholder={table ? "es" : "en"} value={newLanguage} onChange={(e) => setNewLanguage(e.target.value)} style={{ ...input, width: 80 }} />
            <button type="submit" className="cbx-btn">
              Add language
            </button>
          </form>
        </div>
        {error && (
          <p role="alert" style={{ color: "#f87171", margin: "8px 0 0" }}>
            {error}
          </p>
        )}
      </RailGroup>

      {table && (
        <RailGroup label="Strings">
          {unknownUiKeys.length > 0 && (
            <p style={{ margin: "0 0 8px", fontSize: 13 }}>
              The UI uses {unknownUiKeys.map((k) => `@${k}`).join(", ")}, which the table lacks.{" "}
              <button type="button" className="cbx-btn" onClick={() => addKeys(unknownUiKeys)}>
                Add {unknownUiKeys.length === 1 ? "it" : "them"}
              </button>
            </p>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 12, opacity: 0.7 }}>
                <th style={{ ...cell, width: 180 }}>Key</th>
                {table.languages.map((l) => (
                  <th key={l} style={cell}>
                    {languageName(l)}
                    {table.fallback === l ? " ★" : ""}
                  </th>
                ))}
                <th style={{ ...cell, width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {table.entries.map((entry, i) => (
                <tr key={`${i}:${entry.key}:${JSON.stringify(entry.text)}`}>
                  <td style={cell}>
                    <input aria-label={`Key ${entry.key}`} defaultValue={entry.key} onBlur={(e) => e.target.value !== entry.key && renameKey(i, e.target.value.trim())} style={{ ...input, fontFamily: "var(--font-data)" }} />
                  </td>
                  {table.languages.map((l) => (
                    <td key={l} style={cell}>
                      <textarea
                        aria-label={`${entry.key} in ${l}`}
                        rows={1}
                        defaultValue={entry.text[l] ?? ""}
                        placeholder={l === table.fallback ? "" : (entry.text[table.fallback] ?? "")}
                        onBlur={(e) => e.target.value !== (entry.text[l] ?? "") && setText(i, l, e.target.value)}
                        style={{ ...input, resize: "vertical", borderColor: entry.text[l] ? "var(--border-strong)" : "#a16207" }}
                      />
                    </td>
                  ))}
                  <td style={cell}>
                    <button type="button" className="cbx-btn" aria-label={`Delete ${entry.key}`} onClick={() => removeKey(i)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            style={{ display: "flex", gap: 6, marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              addKeys([newKey.trim()]);
              setNewKey("");
            }}
          >
            <input aria-label="New key" placeholder="menu.play" value={newKey} onChange={(e) => setNewKey(e.target.value)} style={{ ...input, width: 220, fontFamily: "var(--font-data)" }} />
            <button type="submit" className="cbx-btn">
              Add string
            </button>
          </form>
        </RailGroup>
      )}
    </div>
  );
}
