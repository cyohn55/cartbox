/**
 * Localisation and accessibility in Lua (ENGINE_PARITY_ROADMAP.md EP19b): the
 * cart's string table and the player's settings, as cartbox functions.
 *
 *   cartbox.text(key, ...)        the key's text in the current language (else
 *                                 the fallback language, else the key), with
 *                                 {1}, {2}… filled from the arguments ({name}
 *                                 from a table argument)
 *   cartbox.language()            the current language code
 *   cartbox.languages()           every language the cart has
 *   cartbox.setlanguage(code)     switch (true when the cart has it)
 *   cartbox.textscale()           the player's text size (1, 1.5 or 2)
 *   cartbox.colorfilter()         the player's colour filter ("none",
 *                                 "protanopia", "deuteranopia", "tritanopia",
 *                                 "high-contrast")
 *
 * UI documents' `@key` texts go through cartbox.text, drawn at the player's
 * text size (see uiSdk.ts). Without a table or settings, the base SDK's
 * stand-ins answer (the key itself, 1, "none").
 */

import { COLOR_FILTERS, TEXT_SCALES, pickLanguage, type AccessibilitySettings, type StringTable } from "@cartbox/editor";

import { INPUT_MAGIC } from "./actionsSdk.js";

const lua = (s: string) => JSON.stringify(s);

/** The language a player plays in: the first of `preferred` the table has, else its fallback (null without a table). */
export function playLanguage(table: StringTable | null | undefined, preferred: readonly string[] | undefined): string | null {
  return table ? pickLanguage(table, preferred ?? []) : null;
}

/** Where the live settings sit in the input block (EP19b): text size, colour filter, language, revision. */
export const INPUT_SETTINGS = 12;

/** The settings as the host writes them: indices into TEXT_SCALES and COLOR_FILTERS, the language (1-based, 0 none) and a revision. */
export function writeInputSettings(block: DataView, accessibility: AccessibilitySettings, languageIndex: number, revision: number): void {
  block.setUint8(INPUT_SETTINGS, Math.max(0, TEXT_SCALES.indexOf(accessibility.textScale)));
  block.setUint8(INPUT_SETTINGS + 1, Math.max(0, COLOR_FILTERS.indexOf(accessibility.colorFilter)));
  block.setUint8(INPUT_SETTINGS + 2, Math.max(0, Math.min(255, languageIndex)));
  block.setUint8(INPUT_SETTINGS + 3, revision & 0xff);
}

/**
 * The Lua for a string table in `language` and the player's settings, or ""
 * when there's neither. With `live` (the input block's address), the cart
 * reads the settings the host writes there before each tick, so a change to
 * text size, colour filter or language applies at once; until the host first
 * writes (code run at load), the starting values answer.
 */
export function stringsSdkLua(table: StringTable | null | undefined, language: string | null, accessibility?: AccessibilitySettings | null, live?: number | null): string {
  const parts: string[] = [];
  const startScale = accessibility?.textScale ?? 1;
  const startFilter = accessibility?.colorFilter ?? "none";
  if (live !== undefined && live !== null && (table || accessibility)) {
    parts.push(`local _A = ${live}
local TS = {${TEXT_SCALES.join(",")}}
local CF = {${COLOR_FILTERS.map(lua).join(",")}}
local function live(i)
  if (peek(_A) | (peek(_A + 1) << 8) | (peek(_A + 2) << 16) | (peek(_A + 3) << 24)) ~= ${INPUT_MAGIC} then return nil end
  return peek(_A + ${INPUT_SETTINGS} + i)
end
cartbox.textscale = function() local v = live(0) if v == nil then return ${startScale} end return TS[v + 1] or 1 end
cartbox.colorfilter = function() local v = live(1) if v == nil then return ${lua(startFilter)} end return CF[v + 1] or "none" end`);
  } else if (accessibility && (accessibility.textScale !== 1 || accessibility.colorFilter !== "none")) {
    parts.push(`cartbox.textscale = function() return ${startScale} end
cartbox.colorfilter = function() return ${lua(startFilter)} end`);
  }
  if (table && table.languages.length > 0) {
    const byLanguage = table.languages.map((l) => {
      const rows = table.entries.flatMap((e) => (e.text[l] !== undefined ? [`[${lua(e.key)}]=${lua(e.text[l]!)}`] : []));
      return `[${lua(l)}]={${rows.join(",")}}`;
    });
    const current = language && table.languages.includes(language) ? language : table.fallback;
    const liveLanguage = live !== undefined && live !== null;
    parts.push(`local S = {${byLanguage.join(",\n")}}
local LANGS = {${table.languages.map(lua).join(",")}}
local FALLBACK, lang = ${lua(table.fallback)}, ${lua(current)}
${
  liveLanguage
    ? `-- The host's language choice, adopted whenever it changes (the cart's own setlanguage holds until then).
local seen = nil
local function sync()
  local rev = live(3)
  if rev == nil or rev == seen then return end
  seen = rev
  local i = live(2)
  if i and i > 0 and LANGS[i] then lang = LANGS[i] end
end`
    : "local function sync() end"
}
local function fill(s, a)
  local t = type(a[1]) == "table" and a[1] or nil
  return (string.gsub(s, "{(%w+)}", function(n)
    local v
    if tonumber(n) then v = a[tonumber(n)] elseif t then v = t[n] end
    if v == nil then return nil end
    return tostring(v)
  end))
end
cartbox.text = function(k, ...)
  sync()
  local s = S[lang][k] or S[FALLBACK][k] or tostring(k)
  return fill(s, {...})
end
cartbox.language = function() sync() return lang end
cartbox.languages = function() local out = {} for i, l in ipairs(LANGS) do out[i] = l end return out end
cartbox.setlanguage = function(l) sync() if S[l] then lang = l return true end return false end`);
  }
  return parts.length > 0 ? `do\n${parts.join("\n")}\nend` : "";
}
