/**
 * Localisation and accessibility (ENGINE_PARITY_ROADMAP.md EP19b): string
 * tables (reading, choosing a language, translating with placeholders, what's
 * missing), colour filters (correction really separates what a colour-blind
 * player confuses; simulation, high contrast), text size, the Lua API and UI
 * `@key` texts in the real engine, the player's preferences, Lockout's table,
 * and — in a real browser — an exported game honouring a player's language,
 * text size and colour filter.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_STRINGS,
  LOCKOUT_UI,
  accessibleTextScale,
  applyColorMatrix,
  colorFilterMatrix,
  colorFilterSvg,
  fillPlaceholders,
  languageCode,
  lockoutMeshSidecar,
  missingTranslations,
  parseAccessibility,
  parseStringTable,
  pickLanguage,
  readSidecarStrings,
  translate,
  uiStringKeys,
  type StringTable,
  type UiDocument,
} from "@cartbox/editor";
import { INPUT_MAGIC, NET_WORDS, RAM_LAYOUTS, codeChunks, inputBlockAddress, injectSdk, playLanguage, stringsSdkLua, uiSdkLua, writeInputSettings } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

import { parsePlayerPrefs, preferredLanguages } from "../apps/web/src/lib/accessibilityPrefs";
import { standaloneHtml, type StandaloneGame } from "../apps/web/src/lib/standaloneExport";

const TABLE: StringTable = {
  languages: ["en", "es", "pt-br"],
  fallback: "en",
  entries: [
    { key: "greet", text: { en: "Hello {1}", es: "Hola {1}" } },
    { key: "score", text: { en: "{name} scored {points}", es: "{name} marca {points}" } },
    { key: "only.en", text: { en: "English only" } },
  ],
};

describe("string tables", () => {
  it("read defensively: language codes normalised and de-duplicated, bad keys and repeats dropped, the fallback kept valid", () => {
    expect(languageCode("pt_BR")).toBe("pt-br");
    expect(languageCode("english")).toBeNull();
    const t = parseStringTable({
      languages: ["EN", "es", "en", "nonsense!"],
      fallback: "fr",
      entries: [{ key: "ok", text: { en: "Yes", es: 5, fr: "Oui" } }, { key: "bad key", text: {} }, { key: "ok", text: { en: "again" } }],
    })!;
    expect(t.languages).toEqual(["en", "es"]);
    expect(t.fallback).toBe("en");
    expect(t.entries).toEqual([{ key: "ok", text: { en: "Yes" } }]);
    expect(parseStringTable({ languages: [] })).toBeNull();
    expect(readSidecarStrings(JSON.stringify({ strings: TABLE }))).toEqual(TABLE);
    expect(readSidecarStrings("not json")).toBeNull();
  });

  it("pick the player's first language the cart has: exact, then its base, then a regional one; else the fallback", () => {
    expect(pickLanguage(TABLE, ["es-MX", "en"])).toBe("es");
    expect(pickLanguage(TABLE, ["pt"])).toBe("pt-br");
    expect(pickLanguage(TABLE, ["fr", "de"])).toBe("en");
    expect(playLanguage(TABLE, ["es"])).toBe("es");
    expect(playLanguage(null, ["es"])).toBeNull();
  });

  it("translate with numbered and named placeholders, falling back to the fallback language, then the key", () => {
    expect(translate(TABLE, "es", "greet", ["Ana"])).toBe("Hola Ana");
    expect(translate(TABLE, "es", "score", [{ name: "Ana", points: 3 }])).toBe("Ana marca 3");
    expect(translate(TABLE, "es", "only.en")).toBe("English only");
    expect(translate(TABLE, "es", "nope")).toBe("nope");
    expect(fillPlaceholders("{1} and {2} {x}", ["a"])).toBe("a and {2} {x}");
  });

  it("say what each language lacks, and which keys the UI uses", () => {
    expect(missingTranslations(TABLE).get("es")).toEqual(["only.en"]);
    expect(missingTranslations(TABLE).get("pt-br")).toEqual(["greet", "score", "only.en"]);
    const docs: UiDocument[] = [{ name: "d", widgets: [{ id: "a", kind: "text", anchor: [0, 0], pivot: [0, 0], offset: [0, 0], size: [10, 10], text: "@greet" }, { id: "b", kind: "text", anchor: [0, 0], pivot: [0, 0], offset: [0, 0], size: [10, 10], text: "plain" }] }];
    expect(uiStringKeys(docs)).toEqual(["greet"]);
  });
});

describe("colour filters", () => {
  const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));
  it("correction moves apart what each type of colour blindness confuses", () => {
    // A red and a green that a deuteranope sees as nearly the same.
    const red: [number, number, number] = [0.8, 0.3, 0.1];
    const green: [number, number, number] = [0.45, 0.5, 0.1];
    for (const type of ["protanopia", "deuteranopia"] as const) {
      const see = colorFilterMatrix(type, "simulate")!;
      const fix = colorFilterMatrix(type, "correct")!;
      const before = dist(applyColorMatrix(see, red), applyColorMatrix(see, green));
      const after = dist(applyColorMatrix(see, applyColorMatrix(fix, red)), applyColorMatrix(see, applyColorMatrix(fix, green)));
      expect(after).toBeGreaterThan(before * 1.5);
    }
    // Greys pass through a correction unchanged (it only moves colour differences).
    const grey: [number, number, number] = [0.5, 0.5, 0.5];
    for (const type of ["protanopia", "deuteranopia", "tritanopia"] as const) {
      applyColorMatrix(colorFilterMatrix(type)!, grey).forEach((v) => expect(v).toBeCloseTo(0.5, 2));
    }
  });

  it("high contrast spreads tones about mid-grey; none is no filter; the SVG carries the matrix", () => {
    const hc = colorFilterMatrix("high-contrast")!;
    expect(applyColorMatrix(hc, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.5, 5);
    expect(applyColorMatrix(hc, [0.3, 0.3, 0.3])[0]).toBeLessThan(0.3);
    expect(applyColorMatrix(hc, [0.7, 0.7, 0.7])[0]).toBeGreaterThan(0.7);
    expect(colorFilterMatrix("none")).toBeNull();
    expect(colorFilterSvg("none")).toBeNull();
    const svg = colorFilterSvg("tritanopia", "correct", "f1")!;
    expect(svg).toContain('<filter id="f1" color-interpolation-filters="linearRGB">');
    expect(svg).toContain(`values="${colorFilterMatrix("tritanopia")!.join(" ")}"`);
  });
});

describe("text size", () => {
  it("scales UI text by whole steps, stepping back where it would overflow its box", () => {
    expect(accessibleTextScale(1, 2, 30, 200, 20)).toBe(2);
    expect(accessibleTextScale(2, 1.5, 30, 200, 40)).toBe(3);
    expect(accessibleTextScale(1, 2, 120, 200, 20)).toBe(1); // 240 px would overflow 200
    expect(accessibleTextScale(1, 2, 30, 200, 8)).toBe(1); // 12 px tall would overflow 8
    expect(accessibleTextScale(2, 1, 30, 10, 2)).toBe(2); // never below its own size
  });

  it("settings read defensively, snapping to the offered sizes", () => {
    expect(parseAccessibility({ textScale: 1.7, colorFilter: "deuteranopia" })).toEqual({ textScale: 1.5, colorFilter: "deuteranopia" });
    expect(parseAccessibility({ textScale: "big", colorFilter: "sepia" })).toEqual({ textScale: 1, colorFilter: "none" });
  });
});

describe("the player's preferences", () => {
  it("keep text size, colour filter and a chosen language ahead of the browser's", () => {
    const prefs = parsePlayerPrefs(JSON.stringify({ textScale: 2, colorFilter: "protanopia", language: "ES" }));
    expect(prefs).toEqual({ textScale: 2, colorFilter: "protanopia", language: "es" });
    expect(preferredLanguages(prefs, ["en-GB", "en"])).toEqual(["es", "en-GB", "en"]);
    expect(preferredLanguages(parsePlayerPrefs("garbage"), ["fr"])).toEqual(["fr"]);
  });
});

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** Run `code` with the given preludes for `ticks` frames; the first 256 pmem words back. */
async function run(code: string, preludes: string[], ticks = 3): Promise<Int32Array> {
  let tic = codeChunks(new TextEncoder().encode(code));
  for (const p of preludes) if (p) tic = prependLuaCode(tic, p);
  tic = injectSdk(tic);
  const mod = await (await import(pathToFileURL(ENGINE).href)).default();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
  mod._free(ptr);
  for (let i = 0; i < ticks; i += 1) mod._cbx_tick(h, 0);
  const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
  return new Int32Array(mod.HEAPU8.buffer.slice(base, base + 1024));
}

describe.skipIf(!existsSync(ENGINE))("in Lua (real engine)", () => {
  it("cartbox.text / language / languages / setlanguage, and the player's settings", async () => {
    const code = `
done = false
function TIC()
  if done then return end
  done = true
  local ok = function(c) return c and 1 or 0 end
  pmem(100, ok(cartbox.text("greet", "Ana") == "Hola Ana"))
  pmem(101, ok(cartbox.text("score", { name = "Bo", points = 7 }) == "Bo marca 7"))
  pmem(102, ok(cartbox.text("only.en") == "English only"))
  pmem(103, ok(cartbox.text("missing.key") == "missing.key"))
  pmem(104, ok(cartbox.language() == "es"))
  pmem(105, #cartbox.languages())
  pmem(106, ok(cartbox.setlanguage("en") and cartbox.text("greet", "Ana") == "Hello Ana"))
  pmem(107, ok(not cartbox.setlanguage("xx") and cartbox.language() == "en"))
  pmem(108, math.floor(cartbox.textscale() * 10))
  pmem(109, ok(cartbox.colorfilter() == "deuteranopia"))
end`;
    const w = await run(code, [stringsSdkLua(TABLE, "es", { textScale: 1.5, colorFilter: "deuteranopia" })]);
    expect(Array.from(w.slice(100, 110))).toEqual([1, 1, 1, 1, 1, 3, 1, 1, 15, 1]);
  });

  it("without a table or settings, the stand-ins answer: the key (placeholders filled), 1, \"none\"", async () => {
    const code = `
function TIC()
  pmem(100, cartbox.text("Hi {1}", "Al") == "Hi Al" and 1 or 0)
  pmem(101, cartbox.language() == nil and #cartbox.languages() == 0 and not cartbox.setlanguage("en") and 1 or 0)
  pmem(102, cartbox.textscale() == 1 and cartbox.colorfilter() == "none" and 1 or 0)
end`;
    const w = await run(code, [stringsSdkLua(null, null, null)]);
    expect(Array.from(w.slice(100, 103))).toEqual([1, 1, 1]);
  });

  it("UI documents show @key texts in the current language, larger at the player's text size where they fit", async () => {
    const docs: UiDocument[] = [
      {
        name: "hud",
        widgets: [
          { id: "a", kind: "text", anchor: [0, 0], pivot: [0, 0], offset: [10, 10], size: [300, 40], text: "@greet", scale: 1 },
          { id: "b", kind: "text", anchor: [0, 0], pivot: [0, 0], offset: [10, 60], size: [30, 40], text: "Wide text here", scale: 1 },
        ],
      },
    ];
    // Capture what the UI prints (and at what scale) by standing in for print.
    const code = `
local seen = {}
function TIC()
  cartbox.ui.show("hud")
  local real = print
  print = function(s, x, y, c, f, scale, small)
    if y and y >= 0 then seen[#seen + 1] = s .. "@" .. (scale or 1) end
    return #s * 6 * (scale or 1)
  end
  cartbox.ui.draw()
  print = real
  local ok = function(c) return c and 1 or 0 end
  local all = table.concat(seen, "|")
  -- "{1}" is a UI binding there (none set): the translated text, drawn at ×2.
  pmem(100, ok(string.find(all, "Hola @2", 1, true) ~= nil))
  pmem(101, ok(string.find(all, "Wide text here@1", 1, true) ~= nil))
end`;
    const w = await run(code, [stringsSdkLua(TABLE, "es", { textScale: 2, colorFilter: "none" }), uiSdkLua(docs, 1280, 720)]);
    expect(Array.from(w.slice(100, 102))).toEqual([1, 1]);
  });
});

describe.skipIf(!existsSync(ENGINE))("live settings (real engine)", () => {
  it("text size, colour filter and language change between ticks when the host writes them, the cart's own choice holding until then", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const at = inputBlockAddress(layout);
    // Each tick the cart records what it sees: size ×10, a filter flag, and which greeting it would show.
    const code = `
t = 0
function TIC()
  t = t + 1
  pmem(100 + t, math.floor(cartbox.textscale() * 10) * 100 + (cartbox.colorfilter() == "tritanopia" and 10 or 0) + (cartbox.text("greet", "") == "Hola " and 1 or 0))
  if t == 3 then cartbox.setlanguage("en") end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, stringsSdkLua(TABLE, "es", { textScale: 1, colorFilter: "none" }, at));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + at - layout.pmemAddress, 16);
    // [text size, filter, language index (1 en, 2 es), revision] per tick.
    const plan: [number, "none" | "tritanopia", number, number][] = [
      [1, "none", 2, 1], // 1: Spanish, as started
      [2, "none", 2, 1], // 2: text size ×2 at once
      [2, "tritanopia", 2, 1], // 3: filter on; the cart switches itself to English after reading
      [2, "tritanopia", 2, 1], // 4: same revision: the cart's English holds
      [1, "none", 2, 2], // 5: the host picks Spanish again (new revision): adopted
    ];
    for (const [size, filter, language, revision] of plan) {
      const b = block();
      b.setUint32(0, INPUT_MAGIC, true);
      writeInputSettings(b, { textScale: size, colorFilter: filter }, language, revision);
      mod._cbx_tick(h, 0);
    }
    const w = new Int32Array(mod.HEAPU8.buffer, base, 256);
    expect(Array.from(w.slice(101, 106))).toEqual([1001, 2001, 2011, 2010, 1001]);
  });
});

describe("Lockout", () => {
  it("speaks English and Spanish: every UI @key is in its table, translated, and the sidecar carries it", () => {
    expect(LOCKOUT_STRINGS.languages).toEqual(["en", "es"]);
    const keys = new Set(LOCKOUT_STRINGS.entries.map((e) => e.key));
    for (const key of uiStringKeys(LOCKOUT_UI)) expect(keys.has(key)).toBe(true);
    expect(missingTranslations(LOCKOUT_STRINGS).get("es")).toEqual([]);
    // The console font is ASCII.
    for (const e of LOCKOUT_STRINGS.entries) expect(/^[\x20-\x7e]*$/.test(e.text.es!)).toBe(true);
    expect(readSidecarStrings(lockoutMeshSidecar())).toEqual(LOCKOUT_STRINGS);
    expect(translate(LOCKOUT_STRINGS, "es", "mode.koth")).toBe("Rey de la colina");
    // In-match text too: every key its code asks for (T("key", english, ...)) is in the table, in both languages.
    const used = [...LOCKOUT_CODE.matchAll(/\bT\("([\w.]+)"/g)].map((m) => m[1]!).filter((k) => !k.endsWith("."));
    for (const k of ["ffa", "slayer", "swat", "snipe", "ball", "koth", "jugg"]) used.push(`mode.${k}`);
    for (const k of ["br", "smg", "shotgun", "sniper", "magnum", "sword"]) used.push(`weapon.${k}`);
    expect(used.length).toBeGreaterThan(20);
    for (const key of used) expect(keys.has(key)).toBe(true);
    expect(translate(LOCKOUT_STRINGS, "es", "msg.pickup", ["Escopeta"])).toBe("Recogiste Escopeta");
    expect(translate(LOCKOUT_STRINGS, "es", "status.teams", [3, 5, 40])).toBe("AZUL 3   ROJO 5   /40");
  });
});

// ── In a real browser ────────────────────────────────────────────────────────

function findChromium(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const bin of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const file = path.join(root, dir, bin);
      if (existsSync(file)) return file;
    }
  }
  return null;
}
const chromiumPath = findChromium();
const DIST = path.resolve(__dirname, "../packages/engine/dist");

describe.skipIf(!chromiumPath || !existsSync(path.join(DIST, "tic80.wasm")))("an exported game honours the player's settings (real browser)", () => {
  it("plays in their language, reports their text size and colour filter to the cart, and filters the frame", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cartbox-a11y-"));
    execFileSync("node", [path.resolve(__dirname, "../apps/web/scripts/build-standalone.mjs"), path.join(dir, "parts")]);
    const code = `
t = 0
function TIC()
  cls(1)
  t = t + 1
  if t == 20 then cartbox.save({ text = cartbox.text("greet", "Ana"), lang = cartbox.language(), size = cartbox.textscale(), filter = cartbox.colorfilter() }) end
end`;
    const game: StandaloneGame = { title: "A11y", cartId: "a11y-test", modelId: "classic", cart: codeChunks(new TextEncoder().encode(code)), mesh: JSON.stringify({ version: 2, meshes: [], strings: TABLE }) };
    const file = path.join(dir, "game.html");
    writeFileSync(
      file,
      standaloneHtml(game, {
        runtime: readFileSync(path.join(dir, "parts", "runtime.js"), "utf8"),
        engine: { js: readFileSync(path.join(DIST, "tic80.js"), "utf8"), wasm: new Uint8Array(readFileSync(path.join(DIST, "tic80.wasm"))) },
      }),
    );
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ executablePath: chromiumPath!, headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext();
      // The player's settings, as the site keeps them.
      await context.addInitScript(() => localStorage.setItem("cartbox:accessibility", JSON.stringify({ textScale: 2, colorFilter: "deuteranopia", language: "es" })));
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("press a key"), null, { timeout: 30_000 });
      await page.mouse.click(10, 10);
      await page.waitForFunction(() => localStorage.getItem("cartbox:save:play:a11y-test") !== null, null, { timeout: 30_000 });
      const saved = JSON.parse(JSON.parse(await page.evaluate(() => localStorage.getItem("cartbox:save:play:a11y-test")!)).data);
      expect(saved).toEqual({ text: "Hola Ana", lang: "es", size: 2, filter: "deuteranopia" });
      const filter = await page.evaluate(() => {
        const stage = document.getElementById("game")!;
        return { css: stage.style.filter, matrix: stage.querySelector("feColorMatrix")?.getAttribute("values") ?? null };
      });
      expect(filter.css).toMatch(/^url\("?#cbx-color-filter-\d+"?\)$/);
      expect(filter.matrix).toBe(colorFilterMatrix("deuteranopia")!.join(" "));
    } finally {
      await browser.close();
    }
  }, 90_000);
});
