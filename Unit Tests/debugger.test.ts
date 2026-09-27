/**
 * The playtest's Lua debugger (ENGINE_ROADMAP.md, Phase 5): breakpoint hooks
 * on the cart's statement lines, stopping mid-frame, stepping into / over /
 * out, the call stack, locals and upvalues, and watch expressions — on the
 * real engine.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DebugCommand,
  RAM_LAYOUTS,
  appendLuaCode,
  armDebugBlock,
  breakableLine,
  codeChunks,
  codeLineOffset,
  createConsole,
  debugBlockAddress,
  debugPostlude,
  debugSdkLua,
  getModel,
  injectSdk,
  instrumentLua,
  parsePauseInfo,
  prependLuaCode,
  readCartCode,
  readPause,
  rewriteLuaCode,
  seedCartridge,
  sendDebugCommand,
  tokenizeLua,
  writeBreakpoints,
  writeWatches,
  type ModelId,
} from "@cartbox/player";

const DIST = path.resolve(__dirname, "../packages/engine/dist");

describe("instrumenting", () => {
  it("hooks statement lines and keeps every line where it was", () => {
    const code = `local t = 0
function TIC()
  t = t + 1
  if t > 3 then
    print("x")
  end
  local v = foo(1,
    2)
  local s = [[
not code
]]
  return t
end`;
    const { code: out, lines } = instrumentLua(code);
    expect(lines).toEqual([1, 2, 3, 4, 5, 7, 9, 12]);
    expect(out.split("\n").length).toBe(code.split("\n").length);
    expect(out.split("\n")[2]).toBe("  __bp(3) t = t + 1");
    expect(out).toContain("[[\nnot code\n]]"); // a long string is left alone
  });

  it("stays out of expressions that carry on over lines, tables and loop headers", () => {
    const code = `local x = a +
  b
local t = {
  one = 1,
  two = 2;
  three = 3
}
for i = 1,
  10 do
  go(i)
end
local y = x
  or z`;
    expect(instrumentLua(code).lines).toEqual([1, 3, 8, 10, 12]);
  });

  it("hooks function bodies inside calls and tables", () => {
    const code = `each(list, function(v)
  use(v)
end)
local h = { on = function()
  fire()
end }`;
    expect(instrumentLua(code).lines).toEqual([1, 2, 4, 5]);
  });

  it("leaves code it can't read alone", () => {
    expect(instrumentLua("x = 'unfinished\ny = 1")).toEqual({ code: "x = 'unfinished\ny = 1", lines: [] });
    expect(instrumentLua("if x then y()").lines).toEqual([]);
    expect(tokenizeLua("--[[ a\nb ]] x = 0x1p4 -- c\n")!.map((t) => t.value)).toEqual(["x", "=", "0x1p4"]);
  });

  it("moves a breakpoint on a line with no statement to the next one", () => {
    expect(breakableLine(6, [1, 5, 7])).toBe(7);
    expect(breakableLine(5, [1, 5, 7])).toBe(5);
    expect(breakableLine(8, [1, 5, 7])).toBeNull();
  });
});

describe("pause information", () => {
  it("reads the stack, locals, upvalues and watches", () => {
    const info = parsePauseInfo(4, 'S hit:4\nS TIC:9\nL v={x=1}\nL n=3\nU count=7\nW 1=4\nW 3!attempt to index a nil value', 3);
    expect(info).toEqual({
      line: 4,
      stack: [
        { name: "hit", line: 4 },
        { name: "TIC", line: 9 },
      ],
      locals: [
        { name: "v", value: "{x=1}" },
        { name: "n", value: "3" },
      ],
      upvalues: [{ name: "count", value: "7" }],
      watches: [
        { value: "4", error: false },
        { value: "", error: false },
        { value: "attempt to index a nil value", error: true },
      ],
    });
  });
});

/** Boot `code` the way the playtest does with the debugger on. */
async function boot(model: ModelId, file: string, code: string) {
  const layout = RAM_LAYOUTS[model];
  const original = codeChunks(new TextEncoder().encode(code));
  const instrumented = instrumentLua(code);
  let prepared = seedCartridge(original, 3);
  prepared = appendLuaCode(rewriteLuaCode(prepared, (c) => c.slice(0, c.length - code.length) + instrumented.code), debugPostlude());
  prepared = injectSdk(prependLuaCode(prepared, debugSdkLua(debugBlockAddress(layout), { debugger: true })));
  const offset = codeLineOffset(instrumented.code, readCartCode(prepared));
  const mod = await (await import(pathToFileURL(path.join(DIST, file)).href)).default();
  const console = createConsole(mod, getModel(model), 44100);
  expect(console.loadCartridge(prepared)).toBe(true);
  const block = () => {
    const bytes = console.ramView(debugBlockAddress(layout) - layout.pmemAddress, 4096)!;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  let watches: string[] = [];
  const tick = () => {
    armDebugBlock(block(), offset, code.split("\n").length);
    console.tick(0);
    const err = console.readError();
    return { pause: readPause(block(), watches.length), error: err };
  };
  return {
    console,
    tick,
    breakpoints: (lines: number[]) => writeBreakpoints(block(), lines),
    watch: (exprs: string[]) => {
      watches = exprs;
      writeWatches(block(), exprs);
    },
    command: (c: number) => sendDebugCommand(block(), c),
  };
}

const CART = `count = 0
local total = 0
local function add(n)
  local doubled = n * 2
  total = total + doubled
  return doubled
end
function TIC()
  count = count + 1
  local got = add(count)
  trace(got)
end`;

describe.skipIf(!existsSync(path.join(DIST, "tic80.js")))("the debugger on the real engine", () => {
  it("runs at full speed with no breakpoints, then stops mid-frame at one", async () => {
    const e = await boot("classic", "tic80.js", CART);
    expect(e.tick().pause).toBeNull();
    e.breakpoints([4]);
    e.watch(["n + 1", "count", "nope.x"]);
    const { pause } = e.tick();
    expect(pause).not.toBeNull();
    expect(pause!.line).toBe(4);
    expect(pause!.stack).toEqual([
      { name: "add", line: 4 },
      { name: "TIC", line: 10 },
    ]);
    expect(pause!.locals).toEqual([{ name: "n", value: "2" }]);
    expect(pause!.upvalues).toContainEqual({ name: "total", value: "2" });
    expect(pause!.watches[0]).toEqual({ value: "3", error: false });
    expect(pause!.watches[1]).toEqual({ value: "2", error: false });
    expect(pause!.watches[2]!.error).toBe(true);

    // While stopped, a tick without a command stays put.
    expect(e.tick().pause!.line).toBe(4);
    // Changing the watches re-reads them in place.
    e.watch(["doubled", "n * 10"]);
    e.command(DebugCommand.refresh);
    expect(e.tick().pause!.watches).toEqual([
      { value: "nil", error: false },
      { value: "20", error: false },
    ]);
  }, 60_000);

  it("steps over, into and out, and continues to the next frame's stop", async () => {
    const e = await boot("classic", "tic80.js", CART);
    e.breakpoints([9]);
    expect(e.tick().pause!.line).toBe(9);
    e.command(DebugCommand.over);
    expect(e.tick().pause!.line).toBe(10);
    e.command(DebugCommand.into);
    let p = e.tick().pause!;
    expect(p.line).toBe(4);
    expect(p.stack.map((f) => f.name)).toEqual(["add", "TIC"]);
    e.command(DebugCommand.over);
    expect(e.tick().pause!.line).toBe(5);
    e.command(DebugCommand.out);
    p = e.tick().pause!;
    expect(p.line).toBe(11); // back in TIC, after the call
    expect(p.locals).toContainEqual({ name: "got", value: "2" });
    e.command(DebugCommand.continue);
    expect(e.tick().pause).toBeNull(); // the frame finishes...
    p = e.tick().pause!; // ...and the next one stops at 9 again
    expect(p.line).toBe(9);
    e.breakpoints([]);
    e.command(DebugCommand.continue);
    expect(e.tick().pause).toBeNull();
    expect(e.tick().pause).toBeNull();
  }, 60_000);

  it("reports an error inside a stopped-and-resumed frame with the cart's lines", async () => {
    const e = await boot(
      "classic",
      "tic80.js",
      `function boom(v)
  return v.x
end
function TIC()
  local a = 1
  boom(nil)
end`,
    );
    e.breakpoints([5]);
    expect(e.tick().pause!.line).toBe(5);
    e.command(DebugCommand.continue);
    const { pause, error } = e.tick();
    expect(pause).toBeNull();
    expect(error!.message).toMatch(/^line 2: attempt to index a nil value/);
    expect(error!.message).toContain("at boom:2 < TIC:6");
  }, 60_000);
});

describe("on every core", () => {
  const cores: [ModelId, string][] = [
    ["pro", "pro/engine.js"],
    ["portrait", "portrait/engine.js"],
    ["ps1", "ps1/engine.js"],
    ["n64", "n64/engine.js"],
    ["xbox360", "xbox360/engine.js"],
  ];
  for (const [model, file] of cores) {
    it.skipIf(!existsSync(path.join(DIST, file)))(`${model}: stops at a breakpoint and steps`, async () => {
      const e = await boot(model, file, CART);
      e.breakpoints([5]);
      expect(e.tick().pause!.line).toBe(5);
      e.command(DebugCommand.over);
      expect(e.tick().pause!.line).toBe(6);
    }, 60_000);
  }
});

describe("breakpoint lists", () => {
  it("toggle in order, and move to lines that can break", async () => {
    const { toggleBreakpoint, codeExcerpt } = await import("../apps/web/src/app/edit/[cartId]/debuggerView");
    const { effectiveBreakpoints } = await import("@cartbox/player");
    expect(toggleBreakpoint(toggleBreakpoint([], 9), 3)).toEqual([3, 9]);
    expect(toggleBreakpoint([3, 9], 3)).toEqual([9]);
    expect(effectiveBreakpoints([2, 6, 7, 40], [1, 3, 7, 12])).toEqual([3, 7]);
    expect(codeExcerpt("a\nb\nc\nd", 1, 1)).toEqual([
      { line: 1, text: "a" },
      { line: 2, text: "b" },
    ]);
  });
});
