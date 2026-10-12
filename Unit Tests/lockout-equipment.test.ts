/**
 * Lockout's equipment (LOCKOUT_EQUIPMENT_ROADMAP.md), on the real engine.
 *
 * E1, loadouts and the Jetpack: a loadout gives its equipment at spawn, and
 * the equipment action works it. Holding it on a Jetpack lifts the soldier
 * while fuel lasts, and the fuel refills on the ground. Standard spawns as
 * Lockout always did, with nothing in the slot. Online, the host flies a
 * guest exactly as the guest predicts itself, and everyone sees its flames.
 *
 * E2, the Grappleshot and the Repulsor: a grapple holds where the aim meets a
 * surface and pulls its wearer there, for a charge that comes back; a blast
 * throws a soldier in front away, or its wearer off the floor it's aimed at.
 * Online, the host pulls a guest the same way the guest predicts itself, and
 * a guest the host's blast throws throws itself the same way.
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
 * test reads into pmem 117 and 118. (A probe that sets QUIET_KEEP = n keeps
 * the first n bots in play.)
 */
async function offline(probe: string, titlePresses: number[] = []) {
  const layout = RAM_LAYOUTS.xbox360;
  const quiet = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" then for i,o in ipairs(bots) do if i > (QUIET_KEEP or 0) then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end end
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
  }, 60_000); // (the first loads the engine: slow on a busy CI runner)

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
  }, 60_000);

  it("leaves a Standard spawn as it always was: nothing in the slot, the button does nothing", async () => {
    const g = await offline(HEIGHT);
    const [a0, b0] = g.probe();
    expect(b0 & 2).toBe(0);
    for (let i = 0; i < 45; i += 1) g.tick(0, ACT.equipment!);
    expect(Math.abs(s16(g.probe()[0]) - s16(a0))).toBeLessThan(0.01);
  }, 60_000);
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

// A direction from the player whose line meets a surface 3..22 m off and well
// above the eye (a global function, for the probes that aim the player that way).
const AIM_HIGH = `;(function()
function find_high_hook(e)
  for j = 1, 9 do for i = 0, 63 do
    local yaw, pitch = i*math.pi/32, j*0.1
    local cp = math.cos(pitch)
    local fx, fy, fz = cp*math.sin(yaw), math.sin(pitch), cp*math.cos(yaw)
    local x0, y0, z0 = e.x, e.y + 1.5, e.z
    local t = seg_first(x0, y0, z0, x0+fx*25, y0+fy*25, z0+fz*25)
    if t and t*25 > 3 and t*25 < 22 and fy*t*25 > 2.2 then return { yaw, pitch, x0+fx*25*t, y0+fy*25*t, z0+fz*25*t } end
  end end
end
end)()`;

describe.skipIf(!existsSync(path.join(DIST, "xbox360/engine.js")))("E2: the Grappleshot and the Repulsor", () => {
  it("grapples to where the aim meets a surface, pulls the soldier up there for a charge, and the charge comes back", async () => {
    const g = await offline(`loadout_pick = 3
${AIM_HIGH}
;(function()
local _T, n, aim, y0, best = TIC, 0, nil, nil, 1e9
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    if not aim and n % 10 == 0 then aim, y0 = find_high_hook(p), p.y end
    if aim then
      p.ay, p.ap, p.manualpitch = aim[1], aim[2], true
      best = math.min(best, math.sqrt((aim[3]-p.x)^2 + (aim[4]-(p.y+0.6))^2 + (aim[5]-p.z)^2))
    end
    pmem(117, (math.min(65535, math.floor(best*100)) & 0xffff) | ((p.charges or 0) << 16) | ((aim and 1 or 0) << 20) | ((p.hooked and 1 or 0) << 21))
    pmem(118, math.max(0, math.floor((p.y - (y0 or p.y))*100 + 0.5)) & 0xffff)
  end
end
end)()`);
    for (let i = 0; i < 4; i += 1) g.tick(0);
    const charges = (w: number) => (w >>> 16) & 15;
    expect((g.probe()[0] >>> 20) & 1).toBe(1); // a high surface in reach
    expect(charges(g.probe()[0])).toBe(3);
    g.tick(0, ACT.equipment!);
    g.tick(0);
    expect((g.probe()[0] >>> 21) & 1).toBe(1); // the line holds
    expect(charges(g.probe()[0])).toBe(2);
    let rose = 0;
    for (let i = 0; i < 130; i += 1) {
      g.tick(0);
      rose = Math.max(rose, g.probe()[1] / 100);
    }
    const best = (g.probe()[0] & 0xffff) / 100;
    console.log(`E2: grappled to within ${best.toFixed(2)} m of where it held, rising ${rose.toFixed(2)} m`);
    expect(best).toBeLessThan(1.5);
    expect(rose).toBeGreaterThan(2);
    expect((g.probe()[0] >>> 21) & 1).toBe(0); // let go
    for (let i = 0; i < 420; i += 1) g.tick(0);
    expect(charges(g.probe()[0])).toBe(3); // back in 7 s
  }, 60_000);

  it("grapples a bot up to a target well above it, and puts it back on its agent once it's down", async () => {
    const g = await offline(`loadout_pick = 3
QUIET_KEEP = 1
${AIM_HIGH}
;(function()
local _T, n, aim, y0, top, flew = TIC, 0, nil, nil, 0, false
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    local o = bots[1]
    if not o.dead and not o.flying and not aim and n % 10 == 0 then
      aim, y0 = find_high_hook(o), o.y
      if aim then o.eq, o.charges = "grappleshot", 3 end
    end
    -- (a stand-in target just above where the line would hold)
    if aim and not flew then bot_take_off(o, { x = aim[3], y = aim[4] + 0.3, z = aim[5], dead = false }) end
    if o.flying then flew = true end
    if flew then top = math.max(top, o.y - y0) end
    pmem(117, (aim and 1 or 0) | ((flew and 1 or 0) << 1) | ((o.flying and 1 or 0) << 2) | ((o.agent and 1 or 0) << 3) | ((o.charges or 0) << 4))
    pmem(118, math.floor(top*100) & 0xffff)
  end
end
end)()`);
    let flew = false;
    for (let i = 0; i < 200 && !flew; i += 1) {
      g.tick(0);
      flew = ((g.probe()[0] >> 1) & 1) === 1;
    }
    expect(flew).toBe(true);
    for (let i = 0; i < 240; i += 1) g.tick(0);
    const [w, top] = g.probe();
    console.log(`E2: a bot grappled up ${(top / 100).toFixed(2)} m`);
    expect(top / 100).toBeGreaterThan(2);
    expect((w >> 2) & 3).toBe(2); // down, and on its agent again
  }, 60_000);

  it("throws a soldier in front of a Repulsor away, and a bot takes its agent up again once it's down", async () => {
    const g = await offline(`loadout_pick = 4
QUIET_KEEP = 1
;(function()
local _T, n, o, d0 = TIC, 0, nil, nil
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    o = bots[1]
    if n == 3 then
      -- a way ahead clear for 8 m with floor 3 m out: the bot there, facing it
      for i = 0, 31 do
        local yaw = i*math.pi/16
        local fx, fz = math.sin(yaw), math.cos(yaw)
        local bx, bz = p.x + fx*3, p.z + fz*3
        if not d0 and not seg_first(p.x, p.y + 1.2, p.z, p.x + fx*8, p.y + 1.2, p.z + fz*8) and seg_first(bx, p.y + 0.5, bz, bx, p.y - 0.5, bz) then
          p.ay, p.ap, p.manualpitch = yaw, 0, true
          nav_drop(o); o.x, o.y, o.z, o.dead, o.hp, o.sh, o.respawn, o.vy = bx, p.y, bz, false, 100, 100, 0, 0
          o.eq = nil; nav_place(o); d0 = 3
        end
      end
    end
    local d = math.sqrt((o.x - p.x)^2 + (o.z - p.z)^2)
    pmem(117, (math.floor(d*100) & 0xffff) | ((o.flying and 1 or 0) << 16) | ((o.agent and 1 or 0) << 17) | ((p.charges or 0) << 18) | ((d0 and 1 or 0) << 20))
  end
end
end)()`);
    for (let i = 0; i < 4; i += 1) g.tick(0);
    expect((g.probe()[0] >>> 20) & 1).toBe(1);
    const before = (g.probe()[0] & 0xffff) / 100;
    g.tick(0, ACT.equipment!);
    expect((g.probe()[0] >>> 16) & 1).toBe(1); // thrown off its agent
    expect((g.probe()[0] >>> 18) & 3).toBe(0); // the charge spent
    let far = 0;
    for (let i = 0; i < 40; i += 1) {
      g.tick(0);
      far = Math.max(far, (g.probe()[0] & 0xffff) / 100);
    }
    console.log(`E2: a Repulsor threw a bot from ${before.toFixed(2)} m to ${far.toFixed(2)} m`);
    expect(far - before).toBeGreaterThan(2);
    for (let i = 0; i < 60; i += 1) g.tick(0);
    expect((g.probe()[0] >>> 16) & 3).toBe(2); // down: on its agent again
  }, 60_000);

  it("throws its wearer off the floor it's aimed at", async () => {
    const g = await offline(`loadout_pick = 4
;(function()
local _T, n, x0, y0, z0, top, far = TIC, 0, nil, nil, nil, 0, 0
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    if n == 3 then p.ap, p.manualpitch, x0, y0, z0 = -1.0, true, p.x, p.y, p.z end
    if y0 then top = math.max(top, p.y - y0); far = math.max(far, math.sqrt((p.x-x0)^2 + (p.z-z0)^2)) end
    pmem(117, math.floor(top*100) & 0xffff)
    pmem(118, math.floor(far*100) & 0xffff)
  end
end
end)()`);
    for (let i = 0; i < 4; i += 1) g.tick(0);
    g.tick(0, ACT.equipment!);
    for (let i = 0; i < 60; i += 1) g.tick(0);
    const [top, far] = g.probe().map((v) => v / 100);
    console.log(`E2: a Repulsor at the feet threw its wearer ${top.toFixed(2)} m up and ${far.toFixed(2)} m back`);
    expect(top).toBeGreaterThan(1.2);
    expect(far).toBeGreaterThan(0.8);
  }, 60_000);
});

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("E2 online: a guest's grapple, and a guest thrown (two engines, one room)", () => {
  const lagGap = (a: number[], b: number[], from: number, to: number) => {
    let best = { lag: 0, gap: Infinity };
    for (let lag = 0; lag <= 10; lag += 1) {
      let gap = 0;
      for (let f = from; f < to; f += 1) gap = Math.max(gap, Math.abs(a[f]! - b[f + lag]!));
      if (gap < best.gap) best = { lag, gap };
    }
    return best;
  };
  const hostQuiet = `for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end`;

  it("pulls a guest on the host just as the guest predicts itself", async () => {
    // The guest aims high from its 100th tick in the match and presses equipment on its 120th.
    const guestProbe = `loadout_pick = 3
${AIM_HIGH}
;(function()
local _ap, n, aim = cartbox.actionp, 0, nil
cartbox.actionp = function(name) if name == "equipment" then return phase == "play" and n == 120 end return _ap(name) end
local _T = TIC
function TIC()
  if phase == "play" then n = n + 1 end
  _T()
  if phase == "play" and p then
    if n == 100 then aim = find_high_hook(p) end
    if aim then p.ay, p.ap, p.manualpitch = aim[1], aim[2], true end
    pmem(117, (math.floor(p.y*100 + 0.5) & 0xffff) | ((math.floor(p.x*100 + 0.5) & 0xffff) << 16))
    pmem(118, (p.corrections or 0) | ((aim and 1 or 0) << 8) | ((p.hooked and 1 or 0) << 9))
  end
end
end)()`;
    const hostProbe = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 then
    ${hostQuiet}
    for _,o in ipairs(bots) do if o.human then pmem(117, (math.floor(o.y*100 + 0.5) & 0xffff) | ((math.floor(o.x*100 + 0.5) & 0xffff) << 16)); pmem(118, o.hooked and 1 or 0) end end
  end
end
end)()`;
    const { host, guest, both } = await lockoutRoom("", { guestProbe, hostProbe });
    const gy: number[] = [], gx: number[] = [], hy: number[] = [], hx: number[] = [];
    let hostSawLine = false, guestHooked = false, aimed = false;
    for (let f = 0; f < 420; f += 1) {
      both(0, 0);
      const [g0, g1] = guest.probe();
      const [h0, h1] = host.probe();
      gy.push(s16(g0)); gx.push(s16(g0 >>> 16)); hy.push(s16(h0)); hx.push(s16(h0 >>> 16));
      if (h1 & 1) hostSawLine = true;
      if ((g1 >> 9) & 1) guestHooked = true;
      if ((g1 >> 8) & 1) aimed = true;
    }
    const corrections = guest.probe()[1] & 255;
    const y = lagGap(gy, hy, 100, 400), x = lagGap(gx, hx, 100, 400);
    const rise = Math.max(...gy.slice(150)) - Math.min(...gy.slice(100, 150));
    console.log(`E2: guest grappled up ${rise.toFixed(2)} m; the host's pull of it is the same ${y.lag} ticks later, to ${y.gap.toFixed(3)} m up and ${x.gap.toFixed(3)} m across; ${corrections} corrections`);
    expect(aimed && guestHooked).toBe(true);
    expect(rise).toBeGreaterThan(2);
    expect(y.gap).toBeLessThan(0.03);
    expect(x.gap).toBeLessThan(0.03);
    expect(corrections).toBeLessThan(3);
    expect(hostSawLine).toBe(true);
  }, 300_000);

  it("throws a guest the host's Repulsor hits, where the host throws it", async () => {
    // The host steps up beside the guest on its 150th tick in the match, facing it, and blasts on its 160th.
    const hostProbe = `loadout_pick = 4
;(function()
local _ap, n = cartbox.actionp, 0
cartbox.actionp = function(name) if name == "equipment" then return phase == "play" and n == 160 end return _ap(name) end
local _T = TIC
function TIC()
  if phase == "play" then n = n + 1 end
  _T()
  if phase == "play" and NETMODE == 2 then
    ${hostQuiet}
    for _,o in ipairs(bots) do if o.human and not o.dead then
      if n == 150 then
        for i = 0, 15 do
          local yaw = i*math.pi/8
          local fx, fz = math.sin(yaw), math.cos(yaw)
          local px, pz = o.x - fx*2.5, o.z - fz*2.5
          local floor = seg_first(px, o.y + 0.5, pz, px, o.y - 0.5, pz)
          for k = 2, 8, 2 do floor = floor and seg_first(o.x + fx*k, o.y + 0.5, o.z + fz*k, o.x + fx*k, o.y - 0.5, o.z + fz*k) end
          if not placed and floor and not seg_first(px, o.y + 1.2, pz, o.x + fx*8, o.y + 1.2, o.z + fz*8) then
            p.x, p.y, p.z, p.vy, p.ay, p.ap, p.manualpitch, placed = px, o.y, pz, 0, yaw, 0, true, true
          end
        end
      end
      pmem(117, (math.floor(o.x*100 + 0.5) & 0xffff) | ((math.floor(o.z*100 + 0.5) & 0xffff) << 16))
      pmem(118, placed and 1 or 0)
    end end
  end
end
end)()`;
    const guestProbe = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and p then
    pmem(117, (math.floor(p.x*100 + 0.5) & 0xffff) | ((math.floor(p.z*100 + 0.5) & 0xffff) << 16))
    pmem(118, p.corrections or 0)
  end
end
end)()`;
    const { host, guest, both } = await lockoutRoom("", { guestProbe, hostProbe });
    const gx: number[] = [], gz: number[] = [], hx: number[] = [], hz: number[] = [];
    let placed = false;
    for (let f = 0; f < 420; f += 1) {
      both(0, 0);
      const [g0] = guest.probe();
      const [h0, h1] = host.probe();
      gx.push(s16(g0)); gz.push(s16(g0 >>> 16)); hx.push(s16(h0)); hz.push(s16(h0 >>> 16));
      if (h1 & 1) placed = true;
    }
    const corrections = guest.probe()[1] & 255;
    const moved = Math.max(...gx.map((x, i) => Math.hypot(x - gx[100]!, gz[i]! - gz[100]!)));
    // (The guest hears of it only once the host has thrown it: from a little
    // after, its throw is the host's, shifted by the time its inputs take.)
    const x = lagGap(gx, hx, 200, 400), z = lagGap(gz, hz, 200, 400);
    console.log(`E2: the host's Repulsor threw the guest ${moved.toFixed(2)} m; its own throw matches the host's ${x.lag} ticks on, to ${Math.max(x.gap, z.gap).toFixed(3)} m; ${corrections} corrections`);
    expect(placed).toBe(true);
    expect(moved).toBeGreaterThan(1.5);
    expect(x.gap).toBeLessThan(0.05);
    expect(z.gap).toBeLessThan(0.05);
    expect(corrections).toBeLessThan(3);
  }, 300_000);
});

// The first bot, put `dist` m ahead of the player on clear, floored ground,
// the player facing it (a global function, for the probes).
const BOT_AHEAD = `;(function()
function bot_ahead(o, dist)
  for i = 0, 31 do
    local yaw = i*math.pi/16
    local fx, fz = math.sin(yaw), math.cos(yaw)
    local ok = not seg_first(p.x, p.y + 1.2, p.z, p.x + fx*(dist+1), p.y + 1.2, p.z + fz*(dist+1), true)
    for k = 1, math.floor(dist) do ok = ok and seg_first(p.x + fx*k, p.y + 0.5, p.z + fz*k, p.x + fx*k, p.y - 0.5, p.z + fz*k, true) end
    if ok then
      p.ay, p.ap, p.manualpitch = yaw, 0, true
      nav_drop(o); o.x, o.y, o.z, o.dead, o.hp, o.sh, o.respawn, o.vy, o.eq = p.x + fx*dist, p.y, p.z + fz*dist, false, 100, 100, 0, 0, nil
      nav_place(o)
      return true
    end
  end
end
end)()`;

describe.skipIf(!existsSync(path.join(DIST, "xbox360/engine.js")))("E3: the Drop Wall and the Hologram", () => {
  it("sets a Drop Wall down that takes a bot's rounds meant for the player, until it breaks", async () => {
    const g = await offline(`loadout_pick = 5
QUIET_KEEP = 1
${BOT_AHEAD}
;(function()
local _T, n, placed = TIC, 0, false
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    local o = bots[1]
    if n == 3 then placed = bot_ahead(o, 9) end
    if placed then p.ay = math.atan(o.x - p.x, o.z - p.z) end
    p.hp, p.calm = math.max(p.hp, 1), 0   -- (kept alive, its shield never recharging)
    local wl = DEPLOY[1]
    pmem(117, (math.floor(p.hp + (p.sh or 0)) & 0xffff) | ((wl and 1 or 0) << 16) | ((wl and math.max(0, math.floor(wl.hp)) or 0) << 17) | ((placed and 1 or 0) << 25))
    pmem(118, wl and (wall_cross(o.x, o.y + 1.4, o.z, p.x, p.y + 1.2, p.z) and 1 or 0) or 0)
  end
end
end)()`);
    for (let i = 0; i < 4; i += 1) g.tick(0);
    expect((g.probe()[0] >>> 25) & 1).toBe(1);
    g.tick(0, ACT.equipment!);
    const [w0, between] = g.probe();
    expect((w0 >>> 16) & 1).toBe(1); // a wall
    expect(between).toBe(1); // ... between them
    const life0 = w0 & 0xffff;
    let soaked = 0;
    let broke = -1;
    for (let i = 0; i < 560 && broke < 0; i += 1) {
      g.tick(0);
      const w = g.probe()[0];
      if ((w >>> 16) & 1) soaked = 150 - ((w >>> 17) & 255);
      else broke = i;
    }
    const life1 = g.probe()[0] & 0xffff;
    console.log(`E3: the wall soaked ${soaked} and broke after ${broke} ticks; the player went ${life0} -> ${life1} meanwhile`);
    expect(broke).toBeGreaterThan(0); // broken by the bot's rounds, before its 10 s ran out
    expect(life1).toBe(life0); // none of them reached the player
    for (let i = 0; i < 240; i += 1) g.tick(0);
    expect(g.probe()[0] & 0xffff).toBeLessThan(life0); // with it gone, they do
  });

  it("sends a Hologram running the way the player faces, which a bot fires on and pops", async () => {
    const g = await offline(`loadout_pick = 6
QUIET_KEEP = 1
${BOT_AHEAD}
;(function()
local _T, n, placed, h, x0, z0, ran, fooled = TIC, 0, false, nil, 0, 0, 0, false
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    local o = bots[1]
    if n == 3 then placed = bot_ahead(o, 14); x0, z0 = p.x, p.z end
    if n < 6 then p.ay = math.atan(o.x - p.x, o.z - p.z) + 0.5 end   -- (off to one side of the bot)
    p.hp = math.max(p.hp, 1)
    if DEPLOY[1] then h = DEPLOY[1]; ran = math.max(ran, math.sqrt((h.x - x0)^2 + (h.z - z0)^2)) end
    if o.target and o.target.holo then fooled = true end
    pmem(117, ((h and 1 or 0)) | ((DEPLOY[1] and 1 or 0) << 1) | ((fooled and 1 or 0) << 2) | ((placed and 1 or 0) << 3) | ((h and math.min(h.t, 4095) or 0) << 4))
    pmem(118, math.floor(ran*100) & 0xffff)
  end
end
end)()`);
    for (let i = 0; i < 6; i += 1) g.tick(0);
    expect((g.probe()[0] >> 3) & 1).toBe(1);
    g.tick(0, ACT.equipment!);
    expect(g.probe()[0] & 3).toBe(3); // set down
    let gone = -1;
    for (let i = 0; i < 400 && gone < 0; i += 1) {
      g.tick(0);
      if (!((g.probe()[0] >> 1) & 1)) gone = i;
    }
    const [w, ran] = g.probe();
    console.log(`E3: the hologram ran ${(ran / 100).toFixed(2)} m and was popped after ${w >> 4} ticks (of 360)`);
    expect(ran / 100).toBeGreaterThan(1);
    expect((w >> 2) & 1).toBe(1); // the bot went for it
    expect(w >> 4).toBeLessThan(360); // popped, not run out
  });

  it("pops an enemy's Hologram with the player's shot", async () => {
    const g = await offline(`${BOT_AHEAD}
;(function()
local _T, n, popped = TIC, 0, false
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    if n == 3 then
      local o = bots[1]
      if bot_ahead(o, 10) then o.ay = math.atan(p.x - o.x, p.z - o.z) + math.pi; deploy(o, "holo") end
    end
    local h = DEPLOY[1]
    if h then
      local dx, dy, dz = h.x - p.x, (h.y + 1.2) - (p.y + 1.5), h.z - p.z
      p.ay, p.ap, p.manualpitch = math.atan(dx, dz), math.atan(dy, math.sqrt(dx*dx + dz*dz)), true
    end
    pmem(117, (h and 1 or 0) | ((n > 3 and not h) and 2 or 0))
  end
end
end)()`);
    for (let i = 0; i < 4; i += 1) g.tick(0);
    expect(g.probe()[0] & 1).toBe(1);
    for (let i = 0; i < 60 && g.probe()[0] & 1; i += 1) g.tick(0, ACT.fire!);
    expect(g.probe()[0] & 3).toBe(2); // popped
  });
});

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("E3 online: a guest's Drop Wall and Hologram (two engines, one room)", () => {
  const hostQuiet = `for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end`;
  const press = (n: number) => `local _ap, n = cartbox.actionp, 0
cartbox.actionp = function(name) if name == "equipment" then return phase == "play" and n == ${n} end return _ap(name) end`;

  it("sets a guest's wall down on the host where the guest did, stops the host's shots with it, and breaks it everywhere", async () => {
    const guestProbe = `loadout_pick = 5
;(function()
${press(120)}
local _T = TIC
function TIC()
  if phase == "play" then n = n + 1 end
  _T()
  if phase == "play" and p then
    local d = DEPLOY[1]
    pmem(117, d and ((math.floor(d.x*100 + 0.5) & 0xffff) | ((math.floor(d.z*100 + 0.5) & 0xffff) << 16)) or 0)
    pmem(118, (d and 1 or 0) | ((n > 130) and 2 or 0))
  end
end
end)()`;
    const hostProbe = `;(function()
local _T, seen, blocked = TIC, 0, false
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 then
    ${hostQuiet}
    local d = DEPLOY[1]
    if d then
      seen = seen + 1
      local nx, nz = math.sin(d.yaw), math.cos(d.yaw)
      -- a round from 3 m before it to 3 m behind it, chest high: stopped
      blocked = seg_blocked(d.x - nx*3, d.y + 1.2, d.z - nz*3, d.x + nx*3, d.y + 1.2, d.z + nz*3, 1)
      if seen == 60 then shot_wall(d.x - nx*3, d.y + 1.2, d.z - nz*3, nx, 0, nz, 6, 200) end
    end
    pmem(117, d and ((math.floor(d.x*100 + 0.5) & 0xffff) | ((math.floor(d.z*100 + 0.5) & 0xffff) << 16)) or 0)
    pmem(118, (d and 1 or 0) | ((blocked and 1 or 0) << 1) | ((d and d.owner and d.owner.human and 1 or 0) << 2) | ((seen > 0) and 8 or 0))
  end
end
end)()`;
    const { host, guest, both } = await lockoutRoom("", { guestProbe, hostProbe });
    let match = false, blocked = false, owner = false;
    for (let f = 0; f < 300; f += 1) {
      both(0, 0);
      const [g0, g1] = guest.probe();
      const [h0, h1] = host.probe();
      if (g1 & 1 && h1 & 1) {
        match = g0 === h0;
        if (h1 & 2) blocked = true;
        if (h1 & 4) owner = true;
      }
    }
    const [, g1] = guest.probe();
    const [, h1] = host.probe();
    console.log(`E3: the guest's wall stood at the same spot on the host (${match}), stopped its shots (${blocked}), and broke on both (${!(g1 & 1) && !(h1 & 1)})`);
    expect(match).toBe(true);
    expect(owner).toBe(true);
    expect(blocked).toBe(true);
    expect(h1 & 8).toBe(8); // the host had it ...
    expect(h1 & 1).toBe(0); // ... and broke it
    expect(g1 & 3).toBe(2); // and the guest's went with it
  }, 300_000);

  it("runs a guest's Hologram on the host the same way", async () => {
    const guestProbe = `loadout_pick = 6
;(function()
${press(120)}
local _T, aim = TIC, nil
function TIC()
  if phase == "play" then n = n + 1 end
  _T()
  if phase == "play" and p then
    local d = DEPLOY[1]
    -- (facing a run of open, floored deck, so it doesn't run off the edge)
    if n == 100 then
      for i = 0, 63 do
        local yaw = i*math.pi/32
        local fx, fz = math.sin(yaw), math.cos(yaw)
        local ok = not seg_first(p.x, p.y + 1.2, p.z, p.x + fx*15, p.y + 1.2, p.z + fz*15, true)
        for k = 1, 14 do ok = ok and seg_first(p.x + fx*k, p.y + 0.5, p.z + fz*k, p.x + fx*k, p.y - 0.5, p.z + fz*k, true) end
        if ok then aim = yaw end
      end
    end
    if aim then p.ay = aim end
    if d and d.t == 90 then pmem(117, (math.floor(d.x*100 + 0.5) & 0xffff) | ((math.floor(d.z*100 + 0.5) & 0xffff) << 16)); pmem(118, 1) end
  end
end
end)()`;
    const hostProbe = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 then
    ${hostQuiet}
    local d = DEPLOY[1]
    if d and d.t == 90 then pmem(117, (math.floor(d.x*100 + 0.5) & 0xffff) | ((math.floor(d.z*100 + 0.5) & 0xffff) << 16)); pmem(118, d.holo and 1 or 0) end
  end
end
end)()`;
    const { host, guest, both } = await lockoutRoom("", { guestProbe, hostProbe });
    for (let f = 0; f < 450; f += 1) both(0, 0);
    expect(guest.probe()[1]).toBe(1);
    expect(host.probe()[1]).toBe(1);
    expect(host.probe()[0]).toBe(guest.probe()[0]); // 90 ticks into its run, at the same spot
  }, 300_000);
});
