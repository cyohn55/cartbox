/**
 * Syntax-check the Lockout cart's Lua. The other starter tests assert the code
 * *contains* the right features (string matches), which cannot catch a structural
 * error like a missing `end` — the kind that only surfaces when the engine tries
 * to load the cart. This parses the whole generated program with a real Lua
 * grammar so a broken block fails CI instead of the player.
 *
 * `LOCKOUT_CODE` is already the interpolated program (the template's `${...}`
 * expressions are resolved at module load), so it is exactly what ships to the
 * cart. TIC-80 runs Lua 5.3/5.4; we parse at 5.3.
 */

import { describe, expect, it } from "vitest";
import { parse } from "luaparse";

import { LOCKOUT_CODE } from "@cartbox/editor";

describe("Lockout cart Lua", () => {
  it("parses as valid Lua (no unbalanced blocks)", () => {
    expect(() => parse(LOCKOUT_CODE, { luaVersion: "5.3" })).not.toThrow();
  });

  it("defines the entry point and the core routines the runtime calls", () => {
    const ast = parse(LOCKOUT_CODE, { luaVersion: "5.3" });
    const globals = new Set<string>();
    for (const node of ast.body) {
      if (node.type === "FunctionDeclaration" && node.identifier?.type === "Identifier") {
        globals.add(node.identifier.name);
      }
    }
    // TIC() is the engine's per-frame callback; without it the cart does nothing.
    expect(globals.has("TIC")).toBe(true);
  });
});
