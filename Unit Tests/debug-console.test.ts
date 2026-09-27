/**
 * The playtest console (ENGINE_ROADMAP.md, Phase 5): `trace()` output reaches
 * the host through the debug block, and runtime errors name the cart's own
 * lines (not lines of the SDK-prefixed source the engine runs), with a short
 * call stack.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { RAM_LAYOUTS, codeChunks, createConsole, getModel, injectSdk, readCartCode, seedCartridge, type ModelId } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import {
  DBG_TRACE_BYTES,
  DEBUG_BLOCK_BYTES,
  armDebugBlock,
  codeLineOffset,
  debugBlockAddress,
  debugSdkLua,
  drainTraces,
  errorStack,
  remapErrorLines,
} from "../packages/player/src/debug/debugBlock";
import { physicsBlockAddress } from "../packages/player/src/physics/protocol";

const DIST = path.resolve(__dirname, "../packages/engine/dist");
const CORES: [ModelId, string][] = [
  ["classic", "tic80.js"],
  ["pro", "pro/engine.js"],
  ["portrait", "portrait/engine.js"],
  ["ps1", "ps1/engine.js"],
  ["n64", "n64/engine.js"],
  ["xbox360", "xbox360/engine.js"],
];

/** Boot `code` the way the playtest does: seeded, debug prelude, SDK on top. */
async function boot(model: ModelId, file: string, code: string) {
  const layout = RAM_LAYOUTS[model];
  const original = codeChunks(new TextEncoder().encode(code));
  const prepared = injectSdk(prependLuaCode(seedCartridge(original, 7), debugSdkLua(debugBlockAddress(layout))));
  const offset = codeLineOffset(readCartCode(original), readCartCode(prepared));
  const mod = await (await import(pathToFileURL(path.join(DIST, file)).href)).default();
  const console = createConsole(mod, getModel(model), 44100);
  expect(console.loadCartridge(prepared)).toBe(true);
  const block = () => {
    const bytes = console.ramView(debugBlockAddress(layout) - layout.pmemAddress, DEBUG_BLOCK_BYTES)!;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const tick = () => {
    armDebugBlock(block(), offset);
    console.tick(0);
    return drainTraces(block());
  };
  return { console, tick, offset };
}

describe("line numbers", () => {
  it("counts the injected lines above the cart's code", () => {
    expect(codeLineOffset("a\nb", "x\ny\na\nb")).toBe(2);
    expect(codeLineOffset("a\nb", "a\nb")).toBe(0);
    expect(codeLineOffset(null, "x")).toBe(0);
    expect(codeLineOffset("zzz", "x\ny")).toBe(0);
  });

  it("rewrites the core's positions to cart lines", () => {
    const msg = `[string "-- cartbox SDK"]:312: attempt to index a nil value\nstack traceback:\n\t[string "-- cartbox SDK"]:320: in function 'TIC'\n\t[string "-- cartbox SDK"]:4: in ?`;
    expect(remapErrorLines(msg, 300)).toBe("line 12: attempt to index a nil value\nstack traceback:\n\tline 20: in function 'TIC'\n\tcartbox: in ?");
  });

  it("reads the call stack the prelude appends", () => {
    expect(errorStack("line 3: boom\nat hit:3 < update:9 < TIC:14")).toEqual([
      { name: "hit", line: 3 },
      { name: "update", line: 9 },
      { name: "TIC", line: 14 },
    ]);
    expect(errorStack("line 3: boom")).toEqual([]);
  });
});

describe("the block's place in RAM", () => {
  for (const [model] of CORES) {
    it(`${model}: sits in free RAM, below the runtime block`, () => {
      const layout = RAM_LAYOUTS[model];
      // TIC-80's free RAM starts 0xE00 bytes after pmem word 0 (after pmem,
      // flags, font, mapping and PCM), on every core.
      expect(debugBlockAddress(layout)).toBeGreaterThanOrEqual(layout.pmemAddress + 0xe00);
      expect(debugBlockAddress(layout) + DEBUG_BLOCK_BYTES).toBe(physicsBlockAddress(layout));
    });
  }
});

describe("trace and errors on the real engine", () => {
  for (const [model, file] of CORES) {
    it.skipIf(!existsSync(path.join(DIST, file)))(`${model}: traces reach the host, and errors name cart lines`, async () => {
      const cart = `t = 0
trace("loaded")
local function hit(v)
  return v.x
end
local function update()
  if t == 2 then hit(nil) end
end
function TIC()
  t = t + 1
  trace("frame " .. t, 6)
  if t == 1 then trace("héllo") end
  update()
end`;
      const e = await boot(model, file, cart);
      expect(e.offset).toBeGreaterThan(100); // the SDK and preludes sit on top
      const first = e.tick();
      expect(first.traces).toEqual([
        { text: "loaded", color: 15 },
        { text: "frame 1", color: 6 },
        { text: "héllo", color: 15 },
      ]);
      expect(e.tick().traces).toEqual([{ text: "frame 2", color: 6 }]);
      const error = e.console.readError()!;
      expect(error.message).toMatch(/^line 4: attempt to index a nil value/);
      expect(errorStack(error.message)).toEqual([
        { name: "hit", line: 4 },
        { name: "update", line: 7 },
        { name: "TIC", line: 13 },
      ]);
      expect(error.message.length).toBeLessThan(256);
    }, 60_000);
  }

  it.skipIf(!existsSync(path.join(DIST, "tic80.js")))("names the cart line of a syntax error", async () => {
    const e = await boot("classic", "tic80.js", `function TIC()\n  local x = 1\n  x = = 2\nend`);
    e.tick();
    const error = e.console.readError()!;
    expect(remapErrorLines(error.message, e.offset)).toMatch(/line 3:/);
  }, 60_000);

  it.skipIf(!existsSync(path.join(DIST, "tic80.js")))("counts traces that overflow the ring in one frame", async () => {
    const e = await boot("classic", "tic80.js", `function TIC() for i = 1, 100 do trace(string.rep("x", 40)) end end`);
    const { traces, dropped } = e.tick();
    expect(traces.length).toBe(Math.floor(DBG_TRACE_BYTES / 43));
    expect(traces.length + dropped).toBe(100);
    expect(e.tick().traces.length).toBe(traces.length); // emptied each frame
  }, 60_000);
});

describe("the console log", () => {
  it("collapses repeats, reads an error's line and stack, and keeps the newest", async () => {
    const { appendConsole, CONSOLE_LIMIT } = await import("../apps/web/src/app/edit/[cartId]/consoleLog");
    let log = appendConsole([], "trace", "hi", 1, 6);
    log = appendConsole(log, "trace", "hi", 2, 6);
    expect(log).toHaveLength(1);
    expect(log[0]!.count).toBe(2);
    log = appendConsole(log, "error", "line 4: boom\nat hit:4 < TIC:9", 3);
    log = appendConsole(log, "error", "line 4: boom\nat hit:4 < TIC:9", 4);
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ kind: "error", line: 4, count: 2, frame: 3, stack: [{ name: "hit", line: 4 }, { name: "TIC", line: 9 }] });
    for (let i = 0; i < CONSOLE_LIMIT + 10; i += 1) log = appendConsole(log, "trace", `t${i}`, i);
    expect(log).toHaveLength(CONSOLE_LIMIT);
    expect(log.at(-1)!.text).toBe(`t${CONSOLE_LIMIT + 9}`);
  });
});
