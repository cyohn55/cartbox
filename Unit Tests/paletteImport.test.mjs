/**
 * Unit tests for the palette-file parser (Lospec imports). Exercises each format
 * Lospec exports — HEX, GIMP .gpl, JASC .pal, paint.net .txt, and Lospec JSON —
 * with real sample content, plus channel clamping and empty input. Expected RGB
 * values are the hand-decoded triplets of the sample colours.
 *
 * Run:  node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/paletteImport.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../packages/editor/src/model/paletteImport.ts");
const { parsePaletteFile } = await import(pathToFileURL(modulePath).href);

// 0x1a1c2c, 0x5d275d, 0xffcd75 decoded once for reuse.
const DARK = [26, 28, 44];
const PURPLE = [93, 39, 93];
const GOLD = [255, 205, 117];
let passed = 0;

// 1. Plain HEX list (Lospec "HEX" export), with and without leading '#'.
{
  const { colors, format } = parsePaletteFile("1a1c2c\n5d275d\nffcd75\n");
  assert.equal(format, "hex");
  assert.deepEqual(colors, [DARK, PURPLE, GOLD]);
  assert.deepEqual(parsePaletteFile("#ff0000\n#00ff00").colors, [
    [255, 0, 0],
    [0, 255, 0],
  ]);
  passed += 1;
}

// 2. paint.net .txt: ';' comments and 8-digit AARRGGBB (alpha dropped).
{
  const { colors, format } = parsePaletteFile(";paint.net Palette File\nFF1a1c2c\nFFffcd75\n");
  assert.equal(format, "paintnet");
  assert.deepEqual(colors, [DARK, GOLD]);
  passed += 1;
}

// 3. GIMP .gpl: header/comment lines ignored, decimal R G B rows parsed.
{
  const gpl = "GIMP Palette\nName: Sample\nColumns: 0\n#\n26 28 44 dark\n255 205 117 gold\n";
  const { colors, format } = parsePaletteFile(gpl);
  assert.equal(format, "gpl");
  assert.deepEqual(colors, [DARK, GOLD]);
  passed += 1;
}

// 4. JASC .pal: 3-line header then decimal rows.
{
  const pal = "JASC-PAL\n0100\n2\n26 28 44\n255 205 117\n";
  const { colors, format } = parsePaletteFile(pal);
  assert.equal(format, "jasc");
  assert.deepEqual(colors, [DARK, GOLD]);
  passed += 1;
}

// 5. Lospec JSON export.
{
  const json = JSON.stringify({ name: "Sample", author: "x", colors: ["1a1c2c", "ffcd75"] });
  const { colors, format } = parsePaletteFile(json);
  assert.equal(format, "json");
  assert.deepEqual(colors, [DARK, GOLD]);
  passed += 1;
}

// 6. Out-of-range channel values are clamped to 0..255.
{
  const { colors } = parsePaletteFile("GIMP Palette\n300 40 128 x\n");
  assert.deepEqual(colors, [[255, 40, 128]]);
  passed += 1;
}

// 7. Unrecognisable content yields no colours (caller reports it).
{
  assert.deepEqual(parsePaletteFile("hello world\nnot a colour\n").colors, []);
  passed += 1;
}

console.log(`PASS — paletteImport: ${passed} checks green.`);
