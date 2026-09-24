/**
 * Carts whose code outgrows one 64 KB .tic chunk. The engine holds up to 8 code
 * banks, joined from the highest bank down; the player's code injection (the SDK,
 * the RNG seed, collision/flags layers) must read and rewrite all of them — it
 * used to give up silently past 64 KB, leaving a big cart without cartbox.*.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { lockoutCartridge, LOCKOUT_CODE } from "@cartbox/editor";
import { codeChunks, injectSdk, readCartCode, seedCartridge } from "@cartbox/player";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** A Lua cart of roughly `kb` KB: real code at both ends, padding comments between. */
function bigCart(kb: number): { bytes: Uint8Array; code: string } {
  const pad = Array.from({ length: Math.ceil((kb * 1024) / 64) }, (_, i) => `-- padding line ${String(i).padStart(6, "0")} ........................................`).join("\n");
  const code = `START = 7\n${pad}\nfunction TIC() pmem(200, (START == 7 and cartbox.flag) and 1 or 0) pmem(201, 4242) end\n`;
  const bytes = codeChunks(new TextEncoder().encode(code));
  return { bytes, code };
}

describe("multi-bank code", () => {
  it("splits code across banks, highest bank first, a full bank sized 0", () => {
    const code = new Uint8Array(0x10000 + 10).fill(0x2d); // '-'
    const bytes = codeChunks(code);
    expect(bytes[0]).toBe(5 | (1 << 5)); // CHUNK_CODE in bank 1 holds the start
    expect(bytes[1]! | (bytes[2]! << 8)).toBe(0); // 65536 bytes → size field 0
    const second = 4 + 0x10000;
    expect(bytes[second]).toBe(5); // bank 0 holds the tail
    expect(bytes[second + 1]! | (bytes[second + 2]! << 8)).toBe(10);
    expect(readCartCode(bytes)!.length).toBe(0x10000 + 10);
  });

  it("reads, seeds and injects into code of any size, keeping it whole", () => {
    const { bytes, code } = bigCart(150);
    expect(readCartCode(bytes)).toBe(code);
    const seeded = readCartCode(seedCartridge(bytes, 9))!;
    expect(seeded.startsWith("math.randomseed(9)\n")).toBe(true);
    expect(seeded.endsWith(code)).toBe(true);
    const injected = readCartCode(injectSdk(bytes))!;
    expect(injected).toContain("cartbox = {");
    expect(injected.endsWith(code)).toBe(true);
  });

  it("builds Lockout's cartridge in banks when its code needs them", () => {
    expect(readCartCode(lockoutCartridge())).toBe(LOCKOUT_CODE);
  });

  it.skipIf(!existsSync(ENGINE))("runs a 150 KB cart with the SDK on the real engine", async () => {
    const tic = injectSdk(bigCart(150).bytes);
    const factory = (await import(pathToFileURL(ENGINE).href)).default;
    const mod = await factory();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    for (let i = 0; i < 3; i += 1) mod._cbx_tick(h, 0);
    const pmem = new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - 119 * 4, 256);
    // The TIC at the very end ran, it saw START from the very beginning, and the
    // SDK (prepended ahead of both) defined cartbox.flag.
    expect(pmem[201]).toBe(4242);
    expect(pmem[200]).toBe(1);
    mod._cbx_delete(h);
  });
});
