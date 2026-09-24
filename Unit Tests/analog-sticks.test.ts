/**
 * cartbox.stick through the real engine: the SDK opts in on first use, reads
 * what the host packs into pmem 68, and Lockout walks with the left stick and
 * turns with the right one.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { lockoutCartridge } from "@cartbox/editor";
import { codeChunks, decodeMeshCamera, injectSdk } from "@cartbox/player";
import { STICK_OPTIN_MAGIC, STICK_OPTIN_WORD, STICK_WORD, packSticks } from "../packages/player/src/sticks";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

async function boot(tic: Uint8Array) {
  const factory = (await import(pathToFileURL(ENGINE).href)).default;
  const mod = await factory();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
  mod._free(ptr);
  const pmem = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - 119 * 4, 256);
  const mailbox = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice();
  /** One tick, feeding sticks the way the player does once the cart has opted in. */
  const tick = (buttons: number, sticks: [number, number, number, number] = [0, 0, 0, 0]) => {
    if (pmem()[STICK_OPTIN_WORD] === STICK_OPTIN_MAGIC) pmem()[STICK_WORD] = packSticks(sticks);
    mod._cbx_tick(h, buttons);
  };
  return { tick, pmem, mailbox };
}

describe.skipIf(!existsSync(ENGINE))("analog sticks", () => {
  it("opt in on first read and return what the host packed", async () => {
    const lua = `function TIC()
  local lx, ly = cartbox.stick(0)
  local rx, ry = cartbox.stick(1)
  pmem(200, math.floor(lx*100+1000)); pmem(201, math.floor(ly*100+1000))
  pmem(202, math.floor(rx*100+1000)); pmem(203, math.floor(ry*100+1000))
end`;
    const { tick, pmem } = await boot(injectSdk(codeChunks(new TextEncoder().encode(lua))));
    expect(pmem()[STICK_OPTIN_WORD]).not.toBe(STICK_OPTIN_MAGIC);
    tick(0);
    expect(pmem()[STICK_OPTIN_WORD]).toBe(STICK_OPTIN_MAGIC);
    tick(0, [1, -1, 0.5, 0]);
    expect(Array.from(pmem().subarray(200, 204)).map((v) => v - 1000)).toEqual([100, -100, 50, 0]);
  });

  it("leaves pmem alone for a cart that never reads a stick", async () => {
    const { tick, pmem } = await boot(injectSdk(codeChunks(new TextEncoder().encode("function TIC() pmem(68, 1234) end"))));
    tick(0, [1, 1, 1, 1]);
    tick(0, [1, 1, 1, 1]);
    expect(pmem()[STICK_WORD]).toBe(1234);
  });

  it("drives Lockout: the left stick walks, the right stick turns", async () => {
    const { tick, mailbox } = await boot(injectSdk(lockoutCartridge()));
    for (const b of [0, 0, 0, 0x10, 0x10, 0, 0]) tick(b); // start Free for All
    const cam = () => decodeMeshCamera(mailbox())!;
    const yaw0 = cam().yaw;
    for (let i = 0; i < 20; i += 1) tick(0, [0, 0, 1, 0]); // right stick hard right
    expect(Math.abs(cam().yaw - yaw0)).toBeGreaterThan(0.3);

    const t0 = cam().target;
    for (let i = 0; i < 30; i += 1) tick(0, [0, -1, 0, 0]); // left stick forward
    const t1 = cam().target;
    expect(Math.hypot(t1[0] - t0[0], t1[2] - t0[2])).toBeGreaterThan(0.5);
  });
});
