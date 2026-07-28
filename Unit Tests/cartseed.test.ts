/**
 * Unit tests for deterministic RNG seed injection (Platform P1, item a).
 *
 * seedCartridge injects `math.randomseed(<seed>)` into a Lua cart's code chunk so
 * randomness is reproducible on replay. These tests check the cart-format surgery
 * is correct: the prologue is present, the original code is preserved, non-Lua
 * carts are untouched, and the result is still a parseable cartridge.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import { readCartCode, seedCartridge } from "@cartbox/player";
// The cart builder used by the engine examples produces a minimal Lua cart.
import { buildLuaCart } from "../packages/engine/examples/sample-cart.mjs";

const ORIGINAL_CODE = ["function TIC()", " cls(1)", ' print("HI",10,10,15)', "end"].join("\n");

describe("seedCartridge (Lua)", () => {
  it("prepends math.randomseed and preserves the original code", () => {
    const cart = buildLuaCart(ORIGINAL_CODE);
    const seeded = seedCartridge(cart, 12345);

    const code = readCartCode(seeded);
    expect(code).not.toBeNull();
    expect(code!.startsWith("math.randomseed(12345)\n")).toBe(true);
    expect(code!.endsWith(ORIGINAL_CODE)).toBe(true);
  });

  it("produces different bytes for different seeds", () => {
    const cart = buildLuaCart(ORIGINAL_CODE);
    const a = seedCartridge(cart, 1);
    const b = seedCartridge(cart, 2);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("keeps the result a valid, parseable cartridge", () => {
    const cart = buildLuaCart(ORIGINAL_CODE);
    const seeded = seedCartridge(cart, 7);
    // If the chunk header/size were wrong, the code chunk could not be located.
    expect(readCartCode(seeded)).toContain(ORIGINAL_CODE);
  });

  it("truncates a non-integer seed to an integer in the injected call", () => {
    const cart = buildLuaCart(ORIGINAL_CODE);
    const code = readCartCode(seedCartridge(cart, 42.9))!;
    expect(code.startsWith("math.randomseed(42)\n")).toBe(true);
  });
});

describe("seedCartridge (non-Lua / no code)", () => {
  it("leaves a cart marked as another language unchanged", () => {
    const jsCart = buildLuaCart(["// script: js", "function TIC() {}"].join("\n"));
    const result = seedCartridge(jsCart, 99);
    expect(Buffer.from(result).equals(Buffer.from(jsCart))).toBe(true);
  });

  it("leaves bytes without a code chunk unchanged", () => {
    const notACart = new Uint8Array([0, 0, 0, 0]); // a zero-size dummy chunk
    const result = seedCartridge(notACart, 1);
    expect(Buffer.from(result).equals(Buffer.from(notACart))).toBe(true);
  });
});
