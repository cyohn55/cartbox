"use client";

/**
 * The player's accessibility and language settings (ENGINE_PARITY_ROADMAP.md
 * EP19b), under a game: text size, colour filter and — when the cart speaks
 * more than one — language. Kept in this browser for every cart.
 */

import { COLOR_FILTERS, COLOR_FILTER_LABELS, TEXT_SCALES, languageName, type ColorFilter } from "@cartbox/editor";

import type { PlayerPrefs } from "@/lib/accessibilityPrefs";

const selectStyle = { font: "inherit", padding: "4px 8px", borderRadius: 6 } as const;

export function PlayerPrefsControls({
  prefs,
  languages,
  onChange,
  restartNote = true,
}: {
  prefs: PlayerPrefs;
  /** The cart's languages (null or one: no language choice). */
  languages: readonly string[] | null;
  onChange: (next: PlayerPrefs) => void;
  /** Say that text size and language apply from the next start. */
  restartNote?: boolean;
}) {
  return (
    <div role="group" aria-label="Accessibility" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13 }}>
      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
        Text size
        <select aria-label="Text size" value={prefs.textScale} onChange={(e) => onChange({ ...prefs, textScale: Number(e.target.value) })} style={selectStyle}>
          {TEXT_SCALES.map((s) => (
            <option key={s} value={s}>
              {s === 1 ? "Normal" : `×${s}`}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
        Colours
        <select aria-label="Colour filter" value={prefs.colorFilter} onChange={(e) => onChange({ ...prefs, colorFilter: e.target.value as ColorFilter })} style={selectStyle}>
          {COLOR_FILTERS.map((f) => (
            <option key={f} value={f}>
              {COLOR_FILTER_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      {languages && languages.length > 1 && (
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          Language
          <select aria-label="Language" value={prefs.language ?? ""} onChange={(e) => onChange({ ...prefs, language: e.target.value || null })} style={selectStyle}>
            <option value="">Browser&apos;s</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {languageName(l)}
              </option>
            ))}
          </select>
        </label>
      )}
      {restartNote && <span style={{ opacity: 0.6 }}>Text size and language apply when the game next starts.</span>}
    </div>
  );
}
