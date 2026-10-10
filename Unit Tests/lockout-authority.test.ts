/**
 * Authoritative hits with lag compensation (LOCKOUT_MULTIPLAYER_ROADMAP.md L6):
 * a guest sends its shot — which way, when it fired, how far behind it drew
 * the others — and the host rewinds everyone to what that guest saw, decides
 * the hit, and owns health, shields, kills and scores. The guest's hit marker
 * shows at once as its own guess, until the host's verdict. The host also
 * refuses what no honest guest could claim: an impossible move, a shot faster
 * than its weapon, refusing to die. Two real engines in a room, over the
 * network lab's simulated links.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LOCKOUT_ENGINE } from "./helpers/lockoutNetLab";
import { lockoutRoom } from "./helpers/lockoutRoom";

// On the guest: the hits it predicted, how many the host confirmed and denied
// (pmem 117: predicted, low 10 bits; confirmed, next 10; denied, next 10), and
// the verdicts it got (118).
const VERDICTS = `;(function()
local _send, _events = cartbox.netsend, cartbox.netevents
local predicted, confirmed, denied, verdicts, mine = 0, 0, 0, 0, {}
cartbox.netsend = function(a, b)
  if (a & 15) == 11 and ((b >> 27) & 1) == 1 then predicted = predicted + 1; mine[b & 255] = true end
  return _send(a, b)
end
cartbox.netevents = function()
  local evs = _events()
  for _, ev in ipairs(evs) do
    local a = ev[1]
    if (a & 15) == 12 and ev[3] == 0 and ((a >> 4) & 7) == MYSLOT then
      verdicts = verdicts + 1
      local seq = (a >> 16) & 255
      if mine[seq] then
        if ((a >> 7) & 1) == 1 then confirmed = confirmed + 1 else denied = denied + 1 end
        mine[seq] = nil
      end
    end
  end
  return evs
end
local _T = TIC
function TIC()
  _T()
  if NETMODE == 1 then pmem(117, math.min(1023, predicted) | (math.min(1023, confirmed) << 10) | (math.min(1023, denied) << 20)); pmem(118, verdicts) end
end
end)()`;

// The guest fights: runs, turns and fires (auto-aim locks onto whoever is in front).
const fight = (f: number) => (f % 240 < 150 ? 0x01 : 0x08) | (f % 6 === 0 ? 0x10 : 0);

// A duel across the central floor: the host's bots are out of it, the guest
// stands 8.8 m from the host's player and fires (auto-aim locks onto it), and
// the host's player strafes either way at full run, never dying. The host
// puts both in place, the guest as the host's own correction would.
const DUEL = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  if NETMODE == 2 then
    for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end
    p.hp, p.sh = 100, 100
    if tick == 10 then p.x, p.y, p.z, p.ay = 4.4, 0, 0, -math.pi/2 end
    -- (again every half second until it's there: over a slow link the guest
    -- joins the match a moment later)
    local o = ent_by_slot(1)
    if tick % 30 == 10 and o and math.abs(o.x + 4.4) + math.abs(o.z) > 0.5 then
      o.hist = nil
      cartbox.netsend(EV.WARP | (1 << 4) | (u16(-440) << 16), 0)
    end
  elseif NETMODE == 1 then
    p.ay = math.pi/2
  end
end
end)()`;
const strafe = (f: number) => 0x40 | (Math.floor((f + 13) / 27) % 2 === 0 ? 0x04 : 0x08);
const shoot = (f: number) => (f % 8 === 0 ? 0x10 : 0);

async function duel(latencyMs: number, hostProbe = "") {
  const { both, guest } = await lockoutRoom(`${VERDICTS}\n${DUEL}`, { link: { latencyMs, jitterMs: latencyMs / 10, direct: true }, hostProbe });
  for (let f = 0; f < 1800; f += 1) both(strafe(f), shoot(f));
  // Let the last verdicts come back.
  for (let f = 0; f < 60; f += 1) both(0, 0);
  const [w, verdicts] = guest.probe();
  return { predicted: w & 1023, confirmed: (w >> 10) & 1023, denied: (w >> 20) & 1023, verdicts };
}

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("the host's word on every hit (two engines, one room)", () => {
  it("confirms the hits a guest saw land on a running target, as surely at 150 ms as at 0, and only with lag compensation", async () => {
    const near = await duel(0);
    const far = await duel(150);
    const blind = await duel(150, "NET_LAG_COMP = false");
    const rate = (r: { predicted: number; confirmed: number }) => r.confirmed / r.predicted;
    for (const r of [near, far, blind]) {
      expect(r.predicted).toBeGreaterThan(20);
      expect(r.confirmed + r.denied).toBe(r.predicted); // every guess answered
    }
    expect(rate(near)).toBeGreaterThan(0.9);
    expect(rate(far)).toBeGreaterThan(0.9);
    expect(Math.abs(rate(far) - rate(near))).toBeLessThan(0.08);
    // Judged on the host's present instead, a guest at 150 ms misses most of what it saw hit.
    expect(rate(blind)).toBeLessThan(rate(far) - 0.3);
    console.log(
      `L6: hits confirmed of those predicted — 0 ms ${near.confirmed}/${near.predicted}, 150 ms ${far.confirmed}/${far.predicted}, ` +
        `150 ms without lag compensation ${blind.confirmed}/${blind.predicted}`,
    );
  }, 600_000);

  it("puts back a guest that moves where no soldier could", async () => {
    // At tick 400 of the match the guest's player jumps 12 m sideways. pmem
    // 117/118 on the guest: its x and z (cm); on the host, 118: moves refused.
    const probe = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  if NETMODE == 1 then
    if tick == 400 then p.x = p.x + 12 end
    pmem(117, (math.floor(p.x*100+0.5) & 0xffff) | ((math.floor(p.z*100+0.5) & 0xffff) << 16))
  elseif NETMODE == 2 then
    local o = ent_by_slot(1)
    pmem(118, o and (o.bad_moves or 0) or 0)
  end
end
end)()`;
    const { both, guest, host } = await lockoutRoom(probe, { link: { latencyMs: 60, jitterMs: 5, direct: true } });
    const s16 = (v: number) => ((v & 0xffff) >= 32768 ? (v & 0xffff) - 65536 : v & 0xffff) / 100;
    const xs: number[] = [];
    for (let f = 0; f < 700; f += 1) {
      both(0, 0); // standing still: only the jump moves it
      xs.push(s16(guest.probe()[0]));
    }
    const jump = xs.findIndex((x, i) => i > 0 && x - xs[i - 1]! > 10);
    expect(jump).toBeGreaterThan(0);
    const before = xs[jump - 1]!;
    // The host refused it and put the guest back within a quarter of a second.
    expect(host.probe()[1]).toBeGreaterThan(0);
    const back = xs.slice(jump).findIndex((x) => Math.abs(x - before) < 0.5);
    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(16);
    expect(Math.abs(xs.at(-1)! - before)).toBeLessThan(0.5);
  }, 300_000);

  it("refuses a guest's shots faster than its weapon fires, and a guest that won't die", async () => {
    // The guest is modified twice over: each shot it sends goes twice (a fire
    // rate its rifle can't have), and it ignores being killed. On the host,
    // pmem 117: its shots refused; 118: whether the host has it dead (bit 0),
    // and how many ticks it has stayed dead while saying it's alive (above).
    const probe = `;(function()
local _send = cartbox.netsend
local _kill = register_kill
local cheat = false
local _T = TIC
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  if NETMODE == 1 and not cheat then
    cheat = true
    cartbox.netsend = function(a, b)
      local ok = _send(a, b)
      if (a & 15) == 11 then _send(a, (b & ~255) | (((b & 255) + 128) & 255)) end
      return ok
    end
    register_kill = function(k, v, h) if v == p then return end; return _kill(k, v, h) end
  elseif NETMODE == 2 then
    local o = ent_by_slot(1)
    if o then
      local s = o.snaps and o.snaps[#o.snaps]
      local says_alive = s ~= nil and (s.w2 & (1 << 17)) == 0
      o.cheat_dead = (o.dead and says_alive) and (o.cheat_dead or 0) + 1 or 0
      pmem(117, o.rejected or 0)
      pmem(118, (o.dead and 1 or 0) | ((o.cheat_dead & 0xffff) << 1))
    end
  end
end
end)()`;
    const { both, host } = await lockoutRoom(probe, { link: { latencyMs: 50, jitterMs: 5, direct: true } });
    let longestDead = 0;
    for (let f = 0; f < 3000; f += 1) {
      both(0, fight(f));
      longestDead = Math.max(longestDead, (host.probe()[1] >>> 1) & 0xffff);
    }
    // Every doubled shot was refused (each second copy came at once, faster than any weapon).
    expect(host.probe()[0]).toBeGreaterThan(20);
    // Killed by the host's bots, it stayed dead there however long it went on
    // saying it was alive: long past any respawn.
    expect(longestDead).toBeGreaterThan(300);
  }, 300_000);
});
