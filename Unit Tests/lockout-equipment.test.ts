/**
 * Lockout's equipment (LOCKOUT_EQUIPMENT_ROADMAP.md), on the real engine.
 *
 * E1, loadouts and the Jetpack: a loadout gives its equipment at spawn, and
 * the equipment action works it. Holding it on a Jetpack lifts the soldier
 * while fuel lasts, and the fuel refills on the ground. Standard spawns as
 * Lockout always did, with nothing in the slot. Online, the host flies a
 * guest exactly as the guest predicts itself, and everyone sees its flames.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, LOCKOUT_INPUT_ACTIONS, lockoutMeshSidecar } from "@cartbox/editor";
import {
  INPUT_BLOCK_BYTES,
  RAM_LAYOUTS,
  actionsSdkLua,
  codeChunks,
  createConsole,
  getModel,
  injectSdk,
  inputBlockAddress,
  prependLuaCode,
  readSidecarUi,
  uiSdkLua,
  writeInputBlock,
} from "@cartbox/player";

import { LOCKOUT_ENGINE } from "./helpers/lockoutNetLab";
import { lockoutRoom } from "./helpers/lockoutRoom";

const DIST = path.resolve(__dirname, "../packages/engine/dist");
const ACT = Object.fromEntries(LOCKOUT_INPUT_ACTIONS.map((a, i) => [a.name, 1 << i])) as Record<string, number>;

/**
 * Lockout on one engine with the host's input block (so actions work as in a
 * browser), the bots kept out of it, and `probe` appended: it writes what a
 * test reads into pmem 117 and 118.
 */
async function offline(probe: string, titlePresses: number[] = []) {
  const layout = RAM_LAYOUTS.xbox360;
  const quiet = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" then for _,o in ipairs(bots) do o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end
end
end)()`;
  const code = `${LOCKOUT_CODE}\n${quiet}\n${probe}`;
  let tic = prependLuaCode(codeChunks(new TextEncoder().encode(code)), actionsSdkLua(LOCKOUT_INPUT_ACTIONS, layout));
  tic = injectSdk(prependLuaCode(tic, uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
  const mod = await (await import(pathToFileURL(path.join(DIST, "xbox360/engine.js")).href)).default();
  const console = createConsole(mod, getModel("xbox360"), 44100);
  expect(console.loadCartridge(tic)).toBe(true);
  const offset = inputBlockAddress(layout) - layout.pmemAddress;
  let last = 0;
  const tick = (buttons: number, actions = 0) => {
    const bytes = console.ramView(offset, INPUT_BLOCK_BYTES)!;
    writeInputBlock(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), actions, last);
    last = actions;
    console.tick(buttons);
  };
  const probeWords = () => {
    const words = console.netWords()!;
    return [words[117]!, words[118]!] as const;
  };
  for (let i = 0; i < 3; i += 1) tick(0);
  for (const b of titlePresses) {
    tick(b);
    tick(0);
  }
  tick(1 << 4); // Free for All
  for (let i = 0; i < 40; i += 1) tick(i % 2 ? 1 << 4 : 0); // past the intro
  for (let i = 0; i < 3; i += 1) tick(0);
  return { tick, probe: probeWords };
}

// The player's height (cm, low half) and fuel (high half), and whether it's jetting (pmem 118).
const HEIGHT = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and p then
    pmem(117, (math.floor(p.y*100 + 0.5) & 0xffff) | ((math.floor(p.fuel or 0) & 0xffff) << 16))
    pmem(118, (p.jetting and 1 or 0) | ((p.eq == "jetpack") and 2 or 0))
  end
end
end)()`;
const s16 = (v: number) => ((v & 0xffff) >= 32768 ? (v & 0xffff) - 65536 : v & 0xffff) / 100;

describe.skipIf(!existsSync(path.join(DIST, "xbox360/engine.js")))("E1: loadouts and the Jetpack", () => {
  it("spawns a Jetpack loadout with the Jetpack, which lifts while its fuel lasts and refills on the ground", async () => {
    const g = await offline(`loadout_pick = 2\n${HEIGHT}`);
    const [a0, b0] = g.probe();
    expect(b0 & 2).toBe(2); // the loadout's equipment
    const ground = s16(a0);
    expect(a0 >>> 16).toBe(150); // full
    for (let i = 0; i < 45; i += 1) g.tick(0, ACT.equipment!);
    const [a1, b1] = g.probe();
    expect(b1 & 1).toBe(1); // jetting
    expect(s16(a1) - ground).toBeGreaterThan(2);
    expect(a1 >>> 16).toBeLessThan(150 - 40);
    // Held until the fuel's gone: it stops lifting and comes down.
    for (let i = 0; i < 140; i += 1) g.tick(0, ACT.equipment!);
    expect(g.probe()[0] >>> 16).toBe(0);
    for (let i = 0; i < 200; i += 1) g.tick(0, ACT.equipment!);
    const [a2, b2] = g.probe();
    expect(b2 & 1).toBe(0); // no fuel, no thrust
    expect(Math.abs(s16(a2) - ground)).toBeLessThan(0.05); // landed
    // On the ground the fuel refills.
    for (let i = 0; i < 120; i += 1) g.tick(0);
    expect(g.probe()[0] >>> 16).toBe(150);
  });

  it("picks the loadout on the title screen with Left/Right, and cycles the next life's with swap while dead", async () => {
    const RIGHT = 1 << 3;
    const g = await offline(`${HEIGHT}
;(function()
local _T = TIC
function TIC() _T(); if phase == "play" and p then pmem(118, (pmem(118) & 3) | (loadout_pick << 4)) end end
end)()`, [RIGHT]);
    expect(g.probe()[1] & 2).toBe(2); // Right on the title: the Jetpack loadout
    expect(g.probe()[1] >> 4).toBe(2);
    // Killed (by the probe), swap picks the next life's loadout; the respawn wears it.
    const d = await offline(`${HEIGHT}
;(function()
local _T, n = TIC, 0
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    if n == 5 then p.hp = 0; kill_ent(p, p, false) end
    pmem(118, (pmem(118) & 3) | (loadout_pick << 4) | ((p.dead and 1 or 0) << 8))
  end
end
end)()`);
    for (let i = 0; i < 4; i += 1) d.tick(0);
    expect((d.probe()[1] >> 8) & 1).toBe(1);
    expect(d.probe()[1] & 2).toBe(0); // a Standard life
    d.tick(0, ACT.swap!);
    d.tick(0);
    expect((d.probe()[1] >> 4) & 15).toBe(2);
    for (let i = 0; i < 120 && (d.probe()[1] >> 8) & 1; i += 1) d.tick(0);
    expect(d.probe()[1] & 2).toBe(2); // the next life wears the Jetpack
  });

  it("leaves a Standard spawn as it always was: nothing in the slot, the button does nothing", async () => {
    const g = await offline(HEIGHT);
    const [a0, b0] = g.probe();
    expect(b0 & 2).toBe(0);
    for (let i = 0; i < 45; i += 1) g.tick(0, ACT.equipment!);
    expect(Math.abs(s16(g.probe()[0]) - s16(a0))).toBeLessThan(0.01);
  });
});

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("E1 online: a guest's Jetpack (two engines, one room)", () => {
  it("flies a guest on the host just as the guest predicts itself, and shows its flames there", async () => {
    // The guest's equipment button, held for a second and a half from its
    // 120th tick in the match (the room harness has no input block); the
    // host's bots out of it.
    const guestProbe = `loadout_pick = 2
;(function()
local _a, n = cartbox.action, 0
cartbox.action = function(name) if name == "equipment" then return phase == "play" and n > 120 and n < 210 end return _a(name) end
local _T = TIC
function TIC()
  if phase == "play" then n = n + 1 end
  _T()
  if phase == "play" and p then pmem(117, (math.floor(p.y*100 + 0.5) & 0xffff) | ((p.corrections or 0) << 16)); pmem(118, p.jetting and 1 or 0) end
end
end)()`;
    const hostProbe = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 then
    for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end
    for _,o in ipairs(bots) do if o.human then pmem(117, math.floor(o.y*100 + 0.5) & 0xffff); pmem(118, o.jetting and 1 or 0) end end
  end
end
end)()`;
    const { host, guest, both } = await lockoutRoom("", { guestProbe, hostProbe });
    const guestY: number[] = [];
    const hostY: number[] = [];
    let hostSawJet = false;
    for (let f = 0; f < 420; f += 1) {
      both(0, 0);
      guestY.push(s16(guest.probe()[0]));
      hostY.push(s16(host.probe()[0]));
      if (host.probe()[1] & 1) hostSawJet = true;
    }
    const corrections = guest.probe()[0] >>> 16;
    // The host flies the guest a few ticks behind the guest's own prediction
    // (its inputs take that long to arrive): the same flight, shifted in time.
    let best = { lag: 0, gap: Infinity };
    for (let lag = 0; lag <= 10; lag += 1) {
      let gap = 0;
      for (let f = 100; f < 400; f += 1) gap = Math.max(gap, Math.abs(guestY[f]! - hostY[f + lag]!));
      if (gap < best.gap) best = { lag, gap };
    }
    const top = Math.max(...guestY);
    console.log(`E1: guest's top ${top.toFixed(2)} m; the host's flight of it is the same ${best.lag} ticks later, to ${best.gap.toFixed(3)} m; ${corrections} corrections`);
    expect(top).toBeGreaterThan(2);
    expect(best.gap).toBeLessThan(0.03);
    expect(corrections).toBeLessThan(3);
    expect(hostSawJet).toBe(true);
  }, 300_000);
});
