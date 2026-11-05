/**
 * The cart Lua language service (AAA_PRODUCTION_ROADMAP.md K2): completion of
 * the SDK, locals and module members; diagnostics for undefined globals, SDK
 * arity and missing modules; go to definition across K1's modules.
 */
import { describe, expect, it } from "vitest";
import { luaCompletions, luaDefinition, luaDiagnostics } from "@cartbox/editor";
import { SDK_REFERENCE } from "../apps/web/src/app/edit/[cartId]/sdkReference";

const SDK = SDK_REFERENCE.flatMap((g) => g.entries);

const CART = `-- script: lua
local enemies = require("enemies")
score = 0
local function bump(n) score = score + n end
function TIC()
  for i, e in ipairs(enemies.list) do bump(i) end
  enemies.spawn(1, 2)
  cartbox.motor("door", 2, 100, 7)
  scroe = scroe + 1 -- a typo
  local t = { x = 1, y = 2 }
  print(t.x, "a string with undefinedName in it")
end
--#module enemies
local M = { list = {} }
function M.spawn(x, y) table.insert(M.list, { x = x, y = y }) end
M.clear = function() M.list = {} end
return M
--#end`;

const at = (needle: string, delta = 0) => CART.indexOf(needle) + delta;

describe("diagnostics (K2)", () => {
  const found = luaDiagnostics(CART, SDK);
  it("flags an undefined global, and nothing that's declared, built in, a field or in a string", () => {
    const undefinedNames = found.filter((d) => d.message.includes("isn't defined")).map((d) => d.message);
    expect(undefinedNames).toEqual([]); // `scroe = scroe + 1` assigns it: a global the cart defines
    const typo = luaDiagnostics(`function TIC()\n  cls(0)\n  pirnt("hi")\n  local x = undefinedThing + 1\nend`, SDK);
    expect(typo.map((d) => [d.line, d.message])).toEqual([
      [3, "'pirnt' isn't defined anywhere in the cart (a typo?)"],
      [4, "'undefinedThing' isn't defined anywhere in the cart (a typo?)"],
    ]);
  });

  it("flags an SDK call given too many arguments", () => {
    const arity = found.filter((d) => d.message.startsWith("cartbox.motor"));
    expect(arity).toEqual([{ line: 8, column: 10, message: "cartbox.motor takes at most 3 arguments; this call gives 4", severity: "warning" }]);
  });

  it("flags a module the cart doesn't hold, and K1's module problems", () => {
    const d = luaDiagnostics(`local a = require("nope")\n--#module open\nx = 1`, SDK);
    expect(d.map((x) => [x.line, x.severity])).toEqual([[1, "error"], [2, "error"]]);
  });
});

describe("completion (K2)", () => {
  it("offers the SDK after cartbox., with signatures", () => {
    const code = "cartbox.mo";
    const { from, items } = luaCompletions(code, code.length, SDK);
    expect(from).toBe(8);
    expect(items.map((i) => i.label)).toContain("motor");
    expect(items.find((i) => i.label === "motor")!.detail).toBe("cartbox.motor(obj, speed, force)");
  });

  it("offers a required module's members, and the names in scope", () => {
    const code = CART.replace("enemies.spawn(1, 2)", "enemies.");
    const members = luaCompletions(code, code.indexOf("enemies.\n") + "enemies.".length, SDK);
    expect(members.items.map((i) => i.label)).toEqual(["clear", "spawn"]);
    const scope = luaCompletions("local bumper = 1\nfunction TIC() bu", "local bumper = 1\nfunction TIC() bu".length, SDK);
    expect(scope.items.map((i) => i.label)).toEqual(["bumper"]);
  });
});

describe("go to definition (K2)", () => {
  it("finds a module member across files, a module from its require, a local and a global", () => {
    expect(luaDefinition(CART, at("enemies.spawn", 9))).toBe(15); // function M.spawn, in the module
    expect(luaDefinition(CART, at('require("enemies")', 10))).toBe(13); // the module's marker
    expect(luaDefinition(CART, at("bump(i)", 1))).toBe(4); // local function bump
    expect(luaDefinition(CART, at("score + n", 1))).toBe(3); // the global's first assignment
    expect(luaDefinition(CART, at("ipairs", 1))).toBeNull(); // a built-in
  });
});
