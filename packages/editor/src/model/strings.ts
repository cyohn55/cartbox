/**
 * Localisation (ENGINE_PARITY_ROADMAP.md EP19b): a cart's string table — every
 * player-facing text under a key, in each language the cart speaks.
 *
 * - **Keys** name a text ("menu.play", "hud.ammo"); a language is a short code
 *   ("en", "es", "pt-br"). One language is the default: what a key shows when
 *   the current language lacks it.
 * - **Placeholders**: `{1}`, `{2}`… are filled from cartbox.text's extra
 *   arguments, `{name}` from a table argument — so word order can differ by
 *   language ("{1} wins!" / "¡Gana {1}!").
 * - **In UI documents** (EP13), a widget whose text is `@key` shows that key's
 *   text, in the current language.
 * - **Choosing a language**: the host passes the player's preferred languages
 *   (the browser's, or a setting); the first the cart has wins ("es-MX" finds
 *   "es"), else the default. A cart can switch with cartbox.setlanguage.
 *
 * Stored in the scene sidecar beside the UI documents and input actions.
 * Pure and DOM-free.
 */

export interface StringEntry {
  readonly key: string;
  /** Text by language code. */
  readonly text: Readonly<Record<string, string>>;
}

export interface StringTable {
  /** Language codes, in the order the editor shows them. */
  readonly languages: readonly string[];
  /** The fallback language (one of `languages`). */
  readonly fallback: string;
  readonly entries: readonly StringEntry[];
}

export const MAX_LANGUAGES = 16;
export const MAX_STRINGS = 1000;
export const MAX_STRING_LENGTH = 500;

const KEY = /^[A-Za-z_][\w.-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

/** A language code normalised ("pt_BR" → "pt-br"), or null when it isn't one. */
export function languageCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase().replace(/_/g, "-");
  return LANGUAGE.test(code) ? code : null;
}

/** Whether a string can be a key. */
export function isStringKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}

/** A stored string table read defensively (null when there is none worth keeping). */
export function parseStringTable(raw: unknown): StringTable | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const languages: string[] = [];
  for (const l of Array.isArray(r.languages) ? r.languages : []) {
    const code = languageCode(l);
    if (code && !languages.includes(code) && languages.length < MAX_LANGUAGES) languages.push(code);
  }
  if (languages.length === 0) return null;
  const fallback = languageCode(r.fallback);
  const entries: StringEntry[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(r.entries) ? r.entries : []) {
    if (entries.length >= MAX_STRINGS) break;
    const er = (e ?? {}) as Record<string, unknown>;
    if (!isStringKey(er.key) || seen.has(er.key)) continue;
    const source = (er.text && typeof er.text === "object" ? er.text : {}) as Record<string, unknown>;
    const text: Record<string, string> = {};
    for (const l of languages) if (typeof source[l] === "string") text[l] = (source[l] as string).slice(0, MAX_STRING_LENGTH);
    seen.add(er.key);
    entries.push({ key: er.key, text });
  }
  return { languages, fallback: fallback && languages.includes(fallback) ? fallback : languages[0]!, entries };
}

/** A stored scene sidecar's string table: what the host hands the player as its `strings` option. */
export function readSidecarStrings(raw: string | null | undefined): StringTable | null {
  if (!raw) return null;
  try {
    return parseStringTable((JSON.parse(raw) as { strings?: unknown }).strings);
  } catch {
    return null;
  }
}

/**
 * The language to play in: the first of the player's `preferred` languages the
 * table has (an exact code, else its base language: "es-mx" → "es", else a
 * regional one of it: "pt" → "pt-br"), else the table's fallback.
 */
export function pickLanguage(table: StringTable, preferred: readonly string[]): string {
  for (const raw of preferred) {
    const code = languageCode(raw);
    if (!code) continue;
    if (table.languages.includes(code)) return code;
    const base = code.split("-")[0]!;
    if (table.languages.includes(base)) return base;
    const regional = table.languages.find((l) => l.split("-")[0] === base);
    if (regional) return regional;
  }
  return table.fallback;
}

/** Fill `{1}`, `{2}`… from `args` (a table argument fills `{name}`); unknown placeholders stay as written. */
export function fillPlaceholders(text: string, args: readonly unknown[]): string {
  const named = args.length === 1 && args[0] && typeof args[0] === "object" ? (args[0] as Record<string, unknown>) : null;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (/^\d+$/.test(name)) {
      const v = args[Number(name) - 1];
      return v === undefined || v === null ? whole : String(v);
    }
    const v = named?.[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** A key's text in `language` (else the fallback language, else the key itself), placeholders filled. */
export function translate(table: StringTable | null, language: string, key: string, args: readonly unknown[] = []): string {
  const entry = table?.entries.find((e) => e.key === key);
  const text = entry?.text[language] ?? (table ? entry?.text[table.fallback] : undefined) ?? key;
  return fillPlaceholders(text, args);
}

/** For each language, the keys it lacks (what the editor flags as untranslated). */
export function missingTranslations(table: StringTable): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of table.languages) out.set(l, table.entries.filter((e) => !e.text[l]).map((e) => e.key));
  return out;
}

/** A language's name for menus ("es" → "Español"), from the platform when it can, else the code. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (name && name.toLowerCase() !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // Unknown to the platform.
  }
  return code;
}

/** Every `@key` the UI documents' texts use (to flag keys the table lacks). */
export function uiStringKeys(docs: readonly { widgets: readonly { text?: string; children?: readonly unknown[] }[] }[]): string[] {
  const keys = new Set<string>();
  const walk = (widgets: readonly { text?: string; children?: readonly unknown[] }[]) => {
    for (const w of widgets) {
      if (typeof w.text === "string" && w.text.startsWith("@") && isStringKey(w.text.slice(1))) keys.add(w.text.slice(1));
      if (w.children) walk(w.children as readonly { text?: string; children?: readonly unknown[] }[]);
    }
  };
  for (const d of docs) walk(d.widgets);
  return [...keys];
}
