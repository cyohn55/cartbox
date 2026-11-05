/**
 * Lua modules (AAA_PRODUCTION_ROADMAP.md K1): a cart's script as several files
 * in its one code text, loaded by `require` from the cart on both kinds of core,
 * with the main file's line numbers (errors, breakpoints) where they were.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { MAIN_FILE, addLuaModule, bundleLuaModules, luaFiles, readLuaFile, removeLuaModule, splitLuaModules, writeLuaFile } from "@cartbox/editor";
import { NET_WORDS, codeChunks } from "@cartbox/player";
import { createModernCore, type ModernCoreFactory } from "../packages/modern-core/src/index";

const CART = `-- script: lua
local enemies = require("enemies")
local util = require("util.math")
--#module util.math
local M = {}
function M.clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end
return M
--#end
--#module enemies
local util = require("util.math")
loads = (loads or 0) + 1
local M = { count = 0 }
function M.spawn() M.count = util.clamp(M.count + 1, 0, 3) return M.count end
return M
--#end
function TIC()
  enemies.spawn()
  report(enemies.count, loads, util.clamp(12, 0, 10))
end`;

describe("splitting a cart's code into files (K1)", () => {
  it("finds its modules and blanks their lines in the main file, keeping its line numbers", () => {
    const split = splitLuaModules(CART);
    expect(split.modules.map((m) => [m.name, m.line])).toEqual([["util.math", 4], ["enemies", 9]]);
    expect(split.problems).toEqual([]);
    const main = split.main.split("\n");
    expect(main).toHaveLength(CART.split("\n").length);
    expect(main[15]).toBe("function TIC()"); // line 16, as written
    expect(main.slice(3, 15).every((l) => l === "")).toBe(true);
  });

  it("reports an unclosed module, a repeated one and a bad name", () => {
    const split = splitLuaModules(`--#module a\nx = 1\n--#module a\ny = 2\n--#end\n--#module 9bad\n--#end\n--#module open\nz = 3`);
    expect(split.problems.map((p) => p.line)).toEqual([3, 3, 6, 8]);
    expect(split.modules.map((m) => m.name)).toEqual(["a", "open"]);
  });

  it("leaves code without modules to run as written", () => {
    expect(bundleLuaModules("function TIC() end")).toBeNull();
  });
});

describe("editing one file at a time (K1)", () => {
  it("lists, reads, writes, adds and removes files, the rest of the code untouched", () => {
    expect(luaFiles(CART)).toEqual([MAIN_FILE, "util.math", "enemies"]);
    expect(readLuaFile(CART, "util.math")).toBe("local M = {}\nfunction M.clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end\nreturn M");
    expect(readLuaFile(CART, MAIN_FILE)).toBe(`-- script: lua\nlocal enemies = require("enemies")\nlocal util = require("util.math")\nfunction TIC()\n  enemies.spawn()\n  report(enemies.count, loads, util.clamp(12, 0, 10))\nend`);
    const edited = writeLuaFile(CART, "enemies", "return { count = 9 }");
    expect(readLuaFile(edited, "enemies")).toBe("return { count = 9 }");
    expect(readLuaFile(edited, "util.math")).toBe(readLuaFile(CART, "util.math"));
    const mainEdited = writeLuaFile(CART, MAIN_FILE, "function TIC() end");
    expect(readLuaFile(mainEdited, MAIN_FILE)).toBe("function TIC() end");
    expect(luaFiles(mainEdited)).toEqual(luaFiles(CART));
    const added = addLuaModule(CART, "ai.patrol");
    expect(luaFiles(added)).toEqual([MAIN_FILE, "util.math", "enemies", "ai.patrol"]);
    expect(addLuaModule(added, "ai.patrol")).toBe(added); // taken
    expect(addLuaModule(CART, "not valid")).toBe(CART);
    expect(removeLuaModule(added, "ai.patrol")).toBe(CART);
  });
});

/** The code the player runs: the modules' prelude, then the main file. */
function bundled(code: string): string {
  const b = bundleLuaModules(code)!;
  return `${b.prelude}\n${b.main}`;
}

const MODERN = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

describe.skipIf(!existsSync(MODERN))("require on the Modern core (K1)", () => {
  it("loads each module once, on its first require, with its own locals", async () => {
    const factory = (await import(pathToFileURL(MODERN).href)).default as ModernCoreFactory;
    const seen: number[][] = [];
    const code = bundled(CART).replace(/report\(/g, "cartbox.command(1, ");
    const c = await createModernCore(factory, { width: 320, height: 180, seed: 1, host: { command: (_op, a, v1, v2) => seen.push([a, v1, v2]), query: () => null } });
    expect(c.load(code)).toBe(true);
    for (let i = 0; i < 5; i += 1) c.tick();
    expect(seen.map((s) => s.map(Math.round))).toEqual([[1, 1, 10], [2, 1, 10], [3, 1, 10], [3, 1, 10], [3, 1, 10]]);
  });

  it("names a module the cart doesn't hold, and keeps an error's line in the main file", async () => {
    const factory = (await import(pathToFileURL(MODERN).href)).default as ModernCoreFactory;
    const missing = await createModernCore(factory, { width: 320, height: 180, seed: 1, host: { command: () => {}, query: () => null } });
    expect(missing.load(bundled(`--#module a\nreturn 1\n--#end\nrequire("b")`))).toBe(false);
    expect(missing.error()).toContain("module 'b' isn't in this cart");
    const code = `--#module a\nreturn 1\n--#end\nlocal a = require("a")\nfunction TIC() error("line five") end`;
    const b = bundleLuaModules(code)!;
    const prelude = b.prelude.split("\n").length;
    const c = await createModernCore(factory, { width: 320, height: 180, seed: 1, host: { command: () => {}, query: () => null } });
    expect(c.load(`${b.prelude}\n${b.main}`)).toBe(true);
    c.tick();
    expect(c.error()).toContain(`cart:${prelude + 5}: line five`); // line 5 of the cart, below the prelude
  });
});

const DIST = path.resolve(__dirname, "../packages/engine/dist");
const TIC_CORE = path.join(DIST, "xbox360/engine.js");

describe.skipIf(!existsSync(TIC_CORE))("require on a TIC-80–derived core (K1)", () => {
  it("runs the same modules the same way", async () => {
    const code = bundled(CART).replace(/report\((.*)\)/, "local c, l, v = $1 pmem(100, c) pmem(101, l) pmem(102, v)");
    const tic = codeChunks(new TextEncoder().encode(code));
    const mod = await (await import(pathToFileURL(TIC_CORE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    for (let i = 0; i < 5; i += 1) mod._cbx_tick(h, 0);
    const pmem = new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, 256);
    expect([pmem[100], pmem[101], pmem[102]]).toEqual([3, 1, 10]);
  }, 60_000);
});
