/**
 * Lockout's arsenal (LOCKOUT_ARSENAL_ROADMAP.md), on the real engine.
 *
 * A1: every new weapon fires and wounds; plasma bites shields harder than
 * flesh; an overcharged Plasma Pistol strips a shield in one; needles
 * supercombine; the pads turn through their weapons. Online, a weapon past
 * the first eight travels in the net state, and so does how far round each
 * pad has come.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, LOCKOUT_INPUT_ACTIONS, LOCKOUT_VIEWMODELS, lockoutMeshSidecar } from "@cartbox/editor";
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

/** Lockout on one engine with the host's input block, every bot but the first out of it, and `probe` appended (pmem 117, 118). */
async function offline(probe: string) {
  const layout = RAM_LAYOUTS.xbox360;
  const quiet = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" then for i,o in ipairs(bots) do if i > 1 then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end end
end
end)()`;
  let tic = prependLuaCode(codeChunks(new TextEncoder().encode(`${LOCKOUT_CODE}\n${quiet}\n${probe}`)), actionsSdkLua(LOCKOUT_INPUT_ACTIONS, layout));
  tic = injectSdk(prependLuaCode(tic, uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
  const mod = await (await import(pathToFileURL(path.join(DIST, "xbox360/engine.js")).href)).default();
  const console = createConsole(mod, getModel("xbox360"), 44100);
  expect(console.loadCartridge(tic)).toBe(true);
  const offset = inputBlockAddress(layout) - layout.pmemAddress;
  let last = 0;
  const tick = (actions = 0) => {
    const bytes = console.ramView(offset, INPUT_BLOCK_BYTES)!;
    writeInputBlock(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), actions, last);
    last = actions;
    console.tick(0);
  };
  const words = () => {
    const w = console.netWords()!;
    return [w[117]!, w[118]!] as const;
  };
  for (let i = 0; i < 3; i += 1) tick();
  console.tick(1 << 4); // Free for All
  for (let i = 0; i < 40; i += 1) console.tick(i % 2 ? 1 << 4 : 0); // past the intro
  for (let i = 0; i < 3; i += 1) tick();
  return { tick, probe: words };
}

/**
 * The first bot stood `d` m ahead of the player on clear, floored deck, still
 * (it never fires, never moves), at full health and shield unless the probe
 * says otherwise; the player holding `gun` and aimed at its chest. pmem 117:
 * the bot's health (low byte) and shield (next byte); 118: the player's rounds.
 */
const TARGET = (gun: string, d: number, extra = "") => `;(function()
local _T, n, placed = TIC, 0, false
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    local o = bots[1]
    if n == 3 then
      for i = 0, 31 do
        local yaw = i*math.pi/16
        local fx, fz = math.sin(yaw), math.cos(yaw)
        local ok = not placed and not seg_first(p.x, p.y + 1.2, p.z, p.x + fx*(${d}+1), p.y + 1.2, p.z + fz*(${d}+1), true)
        for k = 1, ${d} do ok = ok and seg_first(p.x + fx*k, p.y + 0.5, p.z + fz*k, p.x + fx*k, p.y - 0.5, p.z + fz*k, true) end
        if ok then
          placed = true
          nav_drop(o); o.x, o.y, o.z, o.dead, o.hp, o.sh, o.respawn, o.vy = p.x + fx*${d}, p.y, p.z + fz*${d}, false, 100, 100, 0, 0
        end
      end
      give(p, 1, "${gun}"); p.slot, p.d1, p.cool = 1, nil, 0
    end
    if placed then
      nav_drop(o); o.cool, o.target, o.calm = 1e9, nil, 0
      local dx, dz = o.x - p.x, o.z - p.z
      p.ay = math.atan(dx, dz)
      p.ap, p.manualpitch = math.atan((o.y + 1.2) - (p.y + 1.5), math.sqrt(dx*dx + dz*dz)), true
    end
    ${extra}
    pmem(117, (math.max(0, math.floor(o.hp)) & 255) | ((math.max(0, math.floor(o.sh or 0)) & 255) << 8) | ((placed and 1 or 0) << 16) | ((o.dead and 1 or 0) << 17))
    pmem(118, p.slot == 1 and (p.a1 or 0) or (p.a2 or 0))
  end
end
end)()`;
const hp = (w: number) => w & 255;
const sh = (w: number) => (w >> 8) & 255;

const ENGINE_OK = existsSync(path.join(DIST, "xbox360/engine.js"));

describe.skipIf(!ENGINE_OK)("A1: the dual wielders and the rifles", () => {
  const A1 = ["ar", "dmr", "carbine", "needlerifle", "beamrifle", "plasmapistol", "plasmarifle", "needler", "spiker", "mauler"];

  it("knows every weapon, in the order of its viewmodels", () => {
    expect(LOCKOUT_VIEWMODELS.slice(6)).toEqual(A1);
    expect(LOCKOUT_VIEWMODELS.length).toBeLessThanOrEqual(32); // (5 bits in the net state)
  });

  it("fires every new weapon at a soldier ahead, and wounds it", async () => {
    const hurt: Record<string, number> = {};
    for (const gun of A1) {
      const g = await offline(TARGET(gun, 6));
      for (let i = 0; i < 4; i += 1) g.tick();
      expect((g.probe()[0] >> 16) & 1).toBe(1);
      const rounds0 = g.probe()[1];
      for (let i = 0; i < 90; i += 1) g.tick(i % 12 < 6 ? ACT.fire! : 0);
      const [w, rounds] = g.probe();
      hurt[gun] = (w >> 17) & 1 ? 200 : 200 - hp(w) - sh(w);
      expect(rounds, gun).toBeLessThan(rounds0);
    }
    console.log(`A1: damage in a second and a half, from 6 m: ${JSON.stringify(hurt)}`);
    for (const gun of A1) expect(hurt[gun], gun).toBeGreaterThan(10);
  }, 120_000);

  it("bites shields harder with plasma, and flesh less", async () => {
    // One Plasma Rifle bolt into a full shield, then one into a bare body.
    // (zoom held: the test strips the bot's shield -- the Plasma Rifle has no zoom of its own)
    const g = await offline(TARGET("plasmarifle", 5, "if cartbox.action('zoom') then o.sh = 0 end"));
    for (let i = 0; i < 4; i += 1) g.tick();
    g.tick(ACT.fire!);
    g.tick();
    // (7 × 1.5 = 10.5 off the shield; whole points read back)
    expect(100 - sh(g.probe()[0])).toBeGreaterThanOrEqual(10);
    expect(100 - sh(g.probe()[0])).toBeLessThanOrEqual(11);
    g.tick(ACT.zoom!);
    for (let i = 0; i < 10; i += 1) g.tick();
    expect(sh(g.probe()[0])).toBe(0);
    const before = hp(g.probe()[0]);
    g.tick(ACT.fire!);
    g.tick();
    // (7 × 0.7 = 4.9 off its health)
    expect(before - hp(g.probe()[0])).toBeGreaterThanOrEqual(4);
    expect(before - hp(g.probe()[0])).toBeLessThanOrEqual(5);
  }, 60_000);

  it("strips a full shield with one overcharged Plasma Pistol bolt", async () => {
    const g = await offline(TARGET("plasmapistol", 5));
    for (let i = 0; i < 4; i += 1) g.tick();
    for (let i = 0; i < 50; i += 1) g.tick(ACT.fire!); // pressed (a plain bolt), then held to charge
    const mid = g.probe();
    g.tick(); // let go: the charged bolt
    g.tick();
    const [w, rounds] = g.probe();
    console.log(`A1: overcharged: shield ${sh(mid[0])} -> ${sh(w)}, health ${hp(w)}, rounds ${mid[1]} -> ${rounds}`);
    expect(sh(w)).toBe(0);
    expect(hp(w)).toBeGreaterThan(90);
    expect(mid[1] - rounds).toBe(10);
  }, 60_000);

  it("sets needles off together: seven from a Needler supercombine", async () => {
    const g = await offline(TARGET("needler", 5));
    for (let i = 0; i < 4; i += 1) g.tick();
    for (let i = 0; i < 38; i += 1) g.tick(ACT.fire!); // eight needles, five ticks apart
    const w = g.probe()[0];
    const dealt = (w >> 17) & 1 ? 200 : 200 - hp(w) - sh(w);
    console.log(`A1: eight needles dealt ${dealt}`);
    expect(dealt).toBeGreaterThan(8 * 6 + 40); // well past eight needles' worth: the supercombine went off
  }, 60_000);

  it("dual wields the new one-handers: Dual Needlers, the left one on the grenade action", async () => {
    const g = await offline(`;(function()
for i, lo in ipairs(LOADOUTS) do if lo.key == "dualneedler" then loadout_pick = i end end
local _T = TIC
function TIC()
  _T()
  if phase == "play" and p then
    pmem(117, ((p.g1 == "needler" and p.d1 == "needler") and 1 or 0) | ((p.ad or 0) << 1) | ((VM_LEFT.needler or 0) << 9))
    pmem(118, (p.a1 or 0) | ((p.nade or 0) << 8))
  end
end
end)()`);
    const [w0, r0] = g.probe();
    expect(w0 & 1).toBe(1);
    expect((w0 >> 9) & 255).toBeGreaterThan(0); // its left-hand viewmodel
    for (let i = 0; i < 20; i += 1) g.tick(ACT.grenade!);
    const [w1, r1] = g.probe();
    expect((w1 >> 1) & 255).toBeLessThan((w0 >> 1) & 255); // the left needler fired
    expect(r1 & 255).toBe(r0 & 255); // the right didn't
    expect((r1 >> 8) & 15).toBe((r0 >> 8) & 15); // and no grenade went
  }, 60_000);

  it("turns each pad through its weapons as they're taken, shown one at a time", async () => {
    // The player stood on the central walkway's pad (the fifth: SMG, AR, Plasma Rifle, ...).
    const g = await offline(`;(function()
local _T, n = TIC, 0
function TIC()
  _T()
  if phase == "play" and p then
    n = n + 1
    if n == 3 then give(p, 1, "br") end
    if n == 5 or n == 700 then p.x, p.y, p.z, p.vy = MRK[13], MRK[14] - 1, MRK[15], 0 end
    if n == 6 or n == 701 then p.x, p.z = p.x + 4, p.z end
    local up = 0
    for k, e in ipairs(PICKUPS) do if pickup_ready(k) and e.pad == 5 then up = up + 1 end end
    pmem(117, (pad_rot[5] or 0) | (up << 4) | ((WIDX_OF and 0 or 0)))
    pmem(118, (p.g1 == "smg" and 1 or 0) | ((p.g1 == "ar" and 1 or 0) << 1) | ((pickup_ready(11) and 1 or 0) << 2))
  end
end
end)()`);
    for (let i = 0; i < 4; i += 1) g.tick();
    expect(g.probe()[1] & 1).toBe(1); // took the SMG
    expect(g.probe()[0] & 15).toBe(1); // the pad moves on to its next...
    expect(g.probe()[1] & 4).toBe(0); // ...out of sight while it recharges
    for (let i = 0; i < 560; i += 1) g.tick();
    expect(g.probe()[1] & 4).toBe(4); // the Assault Rifle, up
    expect((g.probe()[0] >> 4) & 15).toBe(1); // alone over the pad
    for (let i = 0; i < 140; i += 1) g.tick();
    expect(g.probe()[1] & 2).toBe(2); // and taken
    expect(g.probe()[0] & 15).toBe(2);
  }, 60_000);
});

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("A1 online (two engines, one room)", () => {
  it("shows a guest the host's weapon past the first eight, and every browser the pads' turns", async () => {
    // The host takes the SMG off the walkway pad on its 100th tick in the match,
    // then holds a Needler (its 14th weapon: the net state's two extra bits), turning.
    const hostProbe = `;(function()
local _T, n = TIC, 0
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 then
    n = n + 1
    for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end
    if n == 100 then p.x, p.y, p.z, p.vy = MRK[13], MRK[14] - 1, MRK[15], 0 end
    if n == 101 then p.x = p.x + 4 end
    if n == 150 then give(p, 1, "needler"); p.slot = 1 end
    pmem(117, (pad_rot[5] or 0) | (math.floor((wrap_angle(p.ay) + 4)*1000) << 4))
  end
end
end)()`;
    const guestProbe = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and p then
    local h = ent_by_slot(HOSTSLOT)
    local g = h and (WIDX_OF[h.g1] or 0) or 31
    pmem(117, (pad_rot[5] or 0) | (g << 4) | (math.floor((wrap_angle(h and h.face or 0) + 4)*1000) << 9))
  end
end
end)()`;
    const { host, guest, both } = await lockoutRoom("", { guestProbe, hostProbe });
    for (let f = 0; f < 300; f += 1) both(f % 3 === 0 ? 0x04 : 0, 0); // the host turning
    for (let f = 0; f < 20; f += 1) both(0, 0); // (and still, for the snapshots to catch up)
    const [h] = host.probe();
    const [g] = guest.probe();
    expect((g >> 4) & 31).toBe(LOCKOUT_VIEWMODELS.indexOf("needler"));
    expect(h & 15).toBe(1); // the host's pad moved on...
    expect(g & 15).toBe(1); // ...and the guest's with it
    // The host's facing as the guest sees it, to the 1/2500 rad the net state carries now.
    expect(Math.abs((g >> 9) / 1000 - (h >> 4) / 1000)).toBeLessThan(0.002);
  }, 300_000);
});
