/**
 * Parse palette files exported from tools like Lospec into RGB triplets the
 * editor can apply. Supports the common text formats Lospec offers as downloads:
 * plain HEX lists, GIMP .gpl, JASC .pal, paint.net .txt, and Lospec's JSON. The
 * parser is pure (no DOM), so the UI reads the file and hands the text here.
 */

export type Rgb = [number, number, number];

export type PaletteFormat = "hex" | "gpl" | "jasc" | "paintnet" | "json";

export interface ParsedPalette {
  colors: Rgb[];
  format: PaletteFormat;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value)));
}

/** Parse a `R G B` decimal row (GPL/JASC), or null if the line isn't one. */
function parseRgbRow(line: string): Rgb | null {
  const match = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
  if (!match) return null;
  const [, red, green, blue] = match;
  if (red === undefined || green === undefined || blue === undefined) return null;
  return [clampByte(Number(red)), clampByte(Number(green)), clampByte(Number(blue))];
}

/** Convert a 6-digit hex string (optional leading #) to an RGB triplet. */
function hexToRgb(hex: string): Rgb {
  const value = hex.replace(/^#/, "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** GIMP palette: `R G B  name` decimal rows after a `GIMP Palette` header. */
function parseGpl(text: string): Rgb[] {
  const colors: Rgb[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || /^(GIMP Palette|Name:|Columns:)/i.test(line)) continue;
    const rgb = parseRgbRow(line);
    if (rgb) colors.push(rgb);
  }
  return colors;
}

/** JASC-PAL: header, version, count, then decimal `R G B` rows. */
function parseJascPal(text: string): Rgb[] {
  const colors: Rgb[] = [];
  const lines = text.split(/\r?\n/);
  // Rows start after the 3-line header (JASC-PAL / 0100 / count).
  for (let index = 3; index < lines.length; index += 1) {
    const rgb = parseRgbRow((lines[index] ?? "").trim());
    if (rgb) colors.push(rgb);
  }
  return colors;
}

/**
 * A list of hex colours, one per line: plain `rrggbb` (HEX export), `#rrggbb`,
 * or 8-digit `aarrggbb` (paint.net — the leading alpha pair is dropped). Lines
 * that are not colours (names, comments, blanks) are ignored.
 */
function parseHexList(text: string): Rgb[] {
  const colors: Rgb[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue; // paint.net comment
    const match = /^#?(?:[0-9a-fA-F]{2})?([0-9a-fA-F]{6})$/.exec(line);
    const hex = match?.[1];
    if (hex !== undefined) colors.push(hexToRgb(hex));
  }
  return colors;
}

/** Lospec JSON: `{ "colors": ["1a1c2c", ...] }` (hex without #). */
function parseLospecJson(text: string): Rgb[] {
  const data: unknown = JSON.parse(text);
  const colors = (data as { colors?: unknown }).colors;
  if (!Array.isArray(colors)) return [];
  return colors
    .filter((entry): entry is string => typeof entry === "string" && /^#?[0-9a-fA-F]{6}$/.test(entry.trim()))
    .map((entry) => hexToRgb(entry.trim()));
}

/**
 * Parse a palette file's text into RGB triplets, auto-detecting the format.
 * Returns an empty `colors` array when nothing recognisable is found (the caller
 * surfaces that to the user); throws only on malformed JSON we chose to parse.
 */
export function parsePaletteFile(text: string): ParsedPalette {
  const trimmed = text.trim();

  if (/^GIMP Palette/i.test(trimmed)) return { colors: parseGpl(trimmed), format: "gpl" };
  if (/^JASC-PAL/i.test(trimmed)) return { colors: parseJascPal(trimmed), format: "jasc" };
  if (trimmed.startsWith("{")) {
    try {
      return { colors: parseLospecJson(trimmed), format: "json" };
    } catch {
      // Not valid JSON after all — fall through to the line-based parser.
    }
  }

  const colors = parseHexList(trimmed);
  // paint.net files carry an 8-hex (alpha) form; label them for clearer feedback.
  const format: PaletteFormat = /^[;]|^[0-9a-fA-F]{8}\s*$/m.test(trimmed) ? "paintnet" : "hex";
  return { colors, format };
}
