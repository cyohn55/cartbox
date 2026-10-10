/**
 * Authoritative hits with lag compensation (LOCKOUT_MULTIPLAYER_ROADMAP.md L6):
 * a guest sends its shot — which way, when it fired, how far behind it drew
 * the others — and the host rewinds everyone to what that guest saw, decides
 * the hit, and owns health, shields, kills and scores. The guest's hit marker
 * shows at once as its own guess, until the host's verdict. The host also
 * refuses what no honest guest could claim: a shot faster than its weapon, an
 * early return from the dead — and since L7, when the host moves every
 * Spartan, a guest's claims about where it is never reach it at all. Two real
 * engines in a room, over the network lab's simulated links.
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
// puts both in place (since L7 it moves the guest's soldier itself).
const DUEL = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  if NETMODE == 2 then
    for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end
    p.hp, p.sh = 100, 100
    if tick == 10 then
      p.x, p.y, p.z, p.ay = 4.4, 0, 0, -math.pi/2
      local o = ent_by_slot(1)
      o.x, o.y, o.z, o.hist = -4.4, 0, 0, nil
    end
  elseif NETMODE == 1 then
    p.ay = math.pi/2
  end
end
end)()`;
// The host's bots out of the way (dead, far below), for a quiet arena.
const NO_BOTS = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 then
    for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end
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

  it("keeps a guest where its own legs took it, however it claims to have moved", async () => {
    // At tick 400 of the match the guest's player jumps 12 m sideways. Since
    // L7 the host moves every Spartan by its inputs, so the claim never
    // reaches it: the guest's next word from the host puts it back. pmem 117
    // on each: x of the guest's soldier (cm) as that browser has it.
    const probe = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  local o = NETMODE == 1 and p or ent_by_slot(1)
  if NETMODE == 1 and tick == 400 then p.x = p.x + 12 end
  if o then pmem(117, (math.floor(o.x*100+0.5) & 0xffff) | ((math.floor(o.z*100+0.5) & 0xffff) << 16)) end
end
end)()`;
    const { both, guest, host } = await lockoutRoom(`${NO_BOTS}\n${probe}`, { link: { latencyMs: 60, jitterMs: 5, direct: true } });
    const s16 = (v: number) => ((v & 0xffff) >= 32768 ? (v & 0xffff) - 65536 : v & 0xffff) / 100;
    const xs: number[] = [];
    const hostXs: number[] = [];
    for (let f = 0; f < 700; f += 1) {
      both(0, 0); // standing still: only the jump moves it
      xs.push(s16(guest.probe()[0]));
      hostXs.push(s16(host.probe()[0]));
    }
    const jump = xs.findIndex((x, i) => i > 0 && x - xs[i - 1]! > 10);
    expect(jump).toBeGreaterThan(0);
    const before = xs[jump - 1]!;
    // The host's copy never moved; the guest was back within a quarter of a second.
    expect(Math.max(...hostXs.slice(100)) - Math.min(...hostXs.slice(100))).toBeLessThan(0.05);
    const back = xs.slice(jump).findIndex((x) => Math.abs(x - before) < 0.5);
    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(16);
    expect(Math.abs(xs.at(-1)! - before)).toBeLessThan(0.05);
  }, 300_000);

  it("refuses a guest's shots faster than its weapon fires, and a guest can't refuse to die", async () => {
    // The guest is modified: each shot it sends goes twice (a fire rate its
    // rifle can't have), and when it's dead it respawns itself at once and
    // carries on. On the host, pmem 117: its shots refused; 118: the
    // shortest the host has had it dead (ticks) and how many times.
    const probe = `;(function()
local _send = cartbox.netsend
local cheat = false
local _T = TIC
local dead_for, shortest, deaths = 0, 0xffff, 0
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  if NETMODE == 1 then
    if not cheat then
      cheat = true
      cartbox.netsend = function(a, b)
        local ok = _send(a, b)
        if (a & 15) == 11 then _send(a, (b & ~255) | (((b & 255) + 128) & 255)) end
        return ok
      end
    end
    if p.dead then respawn(p) end
  else
    local o = ent_by_slot(1)
    if o and o.dead then dead_for = dead_for + 1
    elseif dead_for > 0 then shortest, deaths, dead_for = math.min(shortest, dead_for), deaths + 1, 0 end
    pmem(117, o and o.rejected or 0)
    pmem(118, shortest | (deaths << 16))
  end
end
end)()`;
    const { both, host } = await lockoutRoom(probe, { link: { latencyMs: 50, jitterMs: 5, direct: true } });
    for (let f = 0; f < 3000; f += 1) both(0, fight(f));
    // Every doubled shot was refused (each second copy came at once, faster than any weapon).
    expect(host.probe()[0]).toBeGreaterThan(20);
    // Killed by the host's bots, it stayed dead there its full respawn time
    // each time, whatever it did on its own screen.
    const [, w] = host.probe();
    expect(w >>> 16).toBeGreaterThan(0);
    expect(w & 0xffff).toBeGreaterThanOrEqual(99);
  }, 300_000);
});
