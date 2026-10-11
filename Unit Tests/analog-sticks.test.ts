/**
 * cartbox.stick through the real engine: the SDK opts in on first use, reads
 * what the host packs into pmem 68, and Lockout walks with the left stick and
 * turns with the right one. cartbox.lookgain (CONTROLLER_SETTINGS_ROADMAP.md
 * C2) reads the gains the host packs into pmem 69, and Lockout turns by them;
 * cartbox.aimassist reads the level beside them and cartbox.rumble asks the
 * host to vibrate (C3).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { lockoutCartridge } from "@cartbox/editor";
import { codeChunks, decodeMailbox, decodeMeshCamera, injectSdk } from "@cartbox/player";
import {
  LOOK_GAIN_OPTIN_MAGIC,
  STICK_OPTIN_MAGIC,
  STICK_OPTIN_WORD,
  STICK_WORD,
  packLookGain,
  packSticks,
  stickChannel,
  type LookGain,
} from "../packages/player/src/sticks";

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
  /** The gains the host writes for a cart that reads them (C2). */
  let gain: LookGain = { x: 1, y: 1, zoom: 1 };
  /** One tick, feeding sticks (and gains) the way the player does once the cart has opted in. */
  const tick = (buttons: number, sticks: [number, number, number, number] = [0, 0, 0, 0]) => {
    const channel = stickChannel(pmem()[STICK_OPTIN_WORD]!);
    if (channel !== "off") pmem()[STICK_WORD] = packSticks(sticks);
    if (channel === "gain") pmem()[STICK_OPTIN_WORD] = packLookGain(gain);
    mod._cbx_tick(h, buttons);
  };
  const setGain = (g: LookGain) => {
    gain = g;
  };
  return { tick, pmem, mailbox, setGain };
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

  it("hand a cart that reads its look gain the host's gains, times zoom when zoomed", async () => {
    const lua = `function TIC()
  local rx = cartbox.stick(1)
  local h, v = cartbox.lookgain(false)
  local zh, zv = cartbox.lookgain(true)
  pmem(200, math.floor(h*100+0.5)); pmem(201, math.floor(v*100+0.5))
  pmem(202, math.floor(zh*100+0.5)); pmem(203, math.floor(zv*100+0.5))
  pmem(204, math.floor(rx*100+1000))
end`;
    const { tick, pmem, setGain } = await boot(injectSdk(codeChunks(new TextEncoder().encode(lua))));
    tick(0);
    // Before the host answers: 1, 1, and the cart has asked for gains.
    expect(Array.from(pmem().subarray(200, 204))).toEqual([100, 100, 100, 100]);
    expect(pmem()[STICK_OPTIN_WORD]).toBe(LOOK_GAIN_OPTIN_MAGIC);
    setGain({ x: 2, y: 1.5, zoom: 0.5 });
    tick(0, [0, 0, 0.5, 0]);
    expect(Array.from(pmem().subarray(200, 204))).toEqual([200, 150, 100, 75]);
    // stick() still reads, and leaves the host's gains in place.
    expect(pmem()[204]! - 1000).toBe(50);
    expect(stickChannel(pmem()[STICK_OPTIN_WORD]!)).toBe("gain");
  });

  it("read the aim assist level beside the gains, standard until the host answers", async () => {
    const lua = `function TIC()
  cartbox.lookgain(false)
  pmem(200, cartbox.aimassist())
end`;
    const { tick, pmem, setGain } = await boot(injectSdk(codeChunks(new TextEncoder().encode(lua))));
    tick(0);
    expect(pmem()[200]).toBe(1);
    for (const assist of [0, 2]) {
      setGain({ x: 1, y: 1, zoom: 1, assist });
      tick(0);
      expect(pmem()[200]).toBe(assist);
    }
  });

  it("send a rumble request to the host", async () => {
    const lua = `local n = 0
function TIC() n = n + 1 if n == 2 then cartbox.rumble(0.8, 120) end end`;
    const { tick, mailbox } = await boot(injectSdk(codeChunks(new TextEncoder().encode(lua))));
    tick(0);
    const seq = decodeMailbox(mailbox(), 0).seq;
    tick(0);
    expect(decodeMailbox(mailbox(), seq).events).toEqual([{ type: 5, kind: "rumble", id: 204, value: 120 }]);
  });

  it("leaves pmem alone for a cart that never reads a stick", async () => {
    const { tick, pmem } = await boot(injectSdk(codeChunks(new TextEncoder().encode("function TIC() pmem(68, 1234) end"))));
    tick(0, [1, 1, 1, 1]);
    tick(0, [1, 1, 1, 1]);
    expect(pmem()[STICK_WORD]).toBe(1234);
  });

  /**
   * Directions as the player sees them. The camera looks along `forward`; the
   * screen's right is forward rotated a quarter turn clockwise seen from above:
   * (-forward.z, forward.x) in Lockout's world (+x shows on the screen's left
   * when looking down +z).
   */
  async function lockout() {
    const game = await boot(injectSdk(lockoutCartridge()));
    for (const b of [0, 0, 0, 0x10, 0x10, 0, 0, 0x10, 0]) game.tick(b); // start Free for All, then skip the intro (Z)
    const cam = () => decodeMeshCamera(game.mailbox())!;
    // drive_camera sets yaw = atan2(-fx, -fz), so forward = (-sin yaw, -cos yaw).
    const forward = () => [-Math.sin(cam().yaw), -Math.cos(cam().yaw)] as const;
    const right = () => {
      const [fx, fz] = forward();
      return [-fz, fx] as const;
    };
    return { ...game, cam, forward, right };
  }

  it("turns the view right with the right stick pushed right (and with the Right key)", async () => {
    const g = await lockout();
    let r0 = g.right();
    for (let i = 0; i < 8; i += 1) g.tick(0, [0, 0, 1, 0]);
    let f1 = g.forward();
    expect(f1[0] * r0[0] + f1[1] * r0[1]).toBeGreaterThan(0.1); // swung toward the old screen-right

    r0 = g.right();
    for (let i = 0; i < 8; i += 1) g.tick(1 << 3); // Right on the D-pad / arrow key
    f1 = g.forward();
    expect(f1[0] * r0[0] + f1[1] * r0[1]).toBeGreaterThan(0.1);
  });

  it("strafes toward the screen's right with the left stick pushed right, and walks forward on up", async () => {
    const g = await lockout();
    const r = g.right();
    const f = g.forward();
    // Strafe right, then left (the random spawn may put a wall on one side, so
    // compare the two rather than demanding free movement one way).
    const along = (from: readonly number[], to: readonly number[]) => (to[0]! - from[0]!) * r[0] + (to[2]! - from[2]!) * r[1];
    const t0 = g.cam().target;
    for (let i = 0; i < 12; i += 1) g.tick(0, [1, 0, 0, 0]);
    const t1 = g.cam().target;
    for (let i = 0; i < 12; i += 1) g.tick(0, [-1, 0, 0, 0]);
    const t2l = g.cam().target;
    const rightward = along(t0, t1);
    const leftward = along(t1, t2l);
    expect(rightward).toBeGreaterThan(-0.05); // never toward the screen's left
    expect(leftward).toBeLessThan(0.05); // never toward the screen's right
    expect(rightward - leftward).toBeGreaterThan(0.3);
    void f;

    const t2 = g.cam().target;
    for (let i = 0; i < 12; i += 1) g.tick(0, [0, -1, 0, 0]);
    const t3 = g.cam().target;
    const f2 = g.forward();
    expect((t3[0] - t2[0]) * f2[0] + (t3[2] - t2[2]) * f2[1]).toBeGreaterThan(0.3);
  });

  it("turns faster than full lean allows when the player's sensitivity is above 1", async () => {
    const turned = async (x: number) => {
      const g = await lockout();
      g.setGain({ x, y: 1, zoom: 1 });
      g.tick(0); // the gains reach the cart from the next tick
      const before = g.cam().yaw;
      for (let i = 0; i < 4; i += 1) g.tick(0, [0, 0, 1, 0]);
      const d = g.cam().yaw - before;
      return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); // the turn, however yaw wraps
    };
    const normal = await turned(1);
    const fast = await turned(2);
    expect(normal).toBeGreaterThan(0.1);
    expect(fast / normal).toBeCloseTo(2, 1);
  });

  it("aims up with the right stick pushed up, and down with it pulled down", async () => {
    const g = await lockout();
    const level = g.cam().pitch;
    for (let i = 0; i < 15; i += 1) g.tick(0, [0, 0, 0, -1]); // up
    const up = g.cam().pitch;
    // drive_camera's pitch is asin(-forward.y): looking up is a smaller pitch.
    expect(up).toBeLessThan(level - 0.2);
    for (let i = 0; i < 30; i += 1) g.tick(0, [0, 0, 0, 1]); // down
    expect(g.cam().pitch).toBeGreaterThan(up + 0.4);
    // …and it stays where it was left (no drift back to level without a target).
    const held = g.cam().pitch;
    for (let i = 0; i < 20; i += 1) g.tick(0);
    expect(Math.abs(g.cam().pitch - held)).toBeLessThan(0.15);
  });
});
