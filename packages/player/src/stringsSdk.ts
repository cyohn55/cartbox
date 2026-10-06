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

import { pickLanguage, type AccessibilitySettings, type StringTable } from "@cartbox/editor";

const lua = (s: string) => JSON.stringify(s);

/** The language a player plays in: the first of `preferred` the table has, else its fallback (null without a table). */
export function playLanguage(table: StringTable | null | undefined, preferred: readonly string[] | undefined): string | null {
  return table ? pickLanguage(table, preferred ?? []) : null;
}

/** The Lua for a string table in `language` and the player's settings, or "" when there's neither. */
export function stringsSdkLua(table: StringTable | null | undefined, language: string | null, accessibility?: AccessibilitySettings | null): string {
  const parts: string[] = [];
  if (table && table.languages.length > 0) {
    const byLanguage = table.languages.map((l) => {
      const rows = table.entries.flatMap((e) => (e.text[l] !== undefined ? [`[${lua(e.key)}]=${lua(e.text[l]!)}`] : []));
      return `[${lua(l)}]={${rows.join(",")}}`;
    });
    const current = language && table.languages.includes(language) ? language : table.fallback;
    parts.push(`local S = {${byLanguage.join(",\n")}}
local LANGS = {${table.languages.map(lua).join(",")}}
local FALLBACK, lang = ${lua(table.fallback)}, ${lua(current)}
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
  local s = S[lang][k] or S[FALLBACK][k] or tostring(k)
  return fill(s, {...})
end
cartbox.language = function() return lang end
cartbox.languages = function() local out = {} for i, l in ipairs(LANGS) do out[i] = l end return out end
cartbox.setlanguage = function(l) if S[l] then lang = l return true end return false end`);
  }
  if (accessibility && (accessibility.textScale !== 1 || accessibility.colorFilter !== "none")) {
    parts.push(`cartbox.textscale = function() return ${accessibility.textScale} end
cartbox.colorfilter = function() return ${lua(accessibility.colorFilter)} end`);
  }
  return parts.length > 0 ? `do\n${parts.join("\n")}\nend` : "";
}
