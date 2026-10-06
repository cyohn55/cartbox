/**
 * The player's accessibility and language preferences (ENGINE_PARITY_ROADMAP.md
 * EP19b), kept once in this browser and honoured by every cart: the play page,
 * the editor's playtest, exported games and Lockout all read them.
 *
 * Text size and colour filter are engine features (see accessibility.ts in
 * @cartbox/editor); the language is a preference ahead of the browser's own.
 * Remapping lives with each game's control settings (EP15).
 */

import { languageCode, parseAccessibility, type AccessibilitySettings } from "@cartbox/editor";

export const ACCESSIBILITY_KEY = "cartbox:accessibility";

export interface PlayerPrefs extends AccessibilitySettings {
  /** A language to prefer over the browser's (null: the browser's). */
  readonly language: string | null;
}

/** Preferences read defensively from stored JSON (defaults for anything missing). */
export function parsePlayerPrefs(raw: string | null | undefined): PlayerPrefs {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const language = languageCode((value as { language?: unknown } | null)?.language);
  return { ...parseAccessibility(value), language };
}

export function readPlayerPrefs(storage: Pick<Storage, "getItem"> | null | undefined): PlayerPrefs {
  try {
    return parsePlayerPrefs(storage?.getItem(ACCESSIBILITY_KEY));
  } catch {
    return parsePlayerPrefs(null);
  }
}

export function writePlayerPrefs(storage: Pick<Storage, "setItem"> | null | undefined, prefs: PlayerPrefs): void {
  try {
    storage?.setItem(ACCESSIBILITY_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the setting lasts this visit only.
  }
}

/** The languages to offer a cart, best first: the chosen one, then the browser's. */
export function preferredLanguages(prefs: Pick<PlayerPrefs, "language">, browser: readonly string[] = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []): string[] {
  return [...(prefs.language ? [prefs.language] : []), ...browser.filter(Boolean)];
}
