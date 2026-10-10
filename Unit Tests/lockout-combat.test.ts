/**
 * Replicated combat (LOCKOUT_MULTIPLAYER_ROADMAP.md L5): every shot, melee
 * swing, grenade and pickup is an event every browser sees. A shot arrives
 * with its direction, how far it went and what it hit, and is shown — sound,
 * muzzle flash, tracer, sparks — from where its shooter is drawn, in step with
 * it. A grenade is thrown from a start state every browser reproduces to the
 * bit, so each simulates the same arc. Checked on two real engines in a room.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LOCKOUT_ENGINE } from "./helpers/lockoutNetLab";
import { lockoutRoom } from "./helpers/lockoutRoom";

// Counts, each tick, the shots this browser sent (its player's, or its bots'
// as host) and the others' shots it showed — a shot shown is its sound played
// at a remote soldier's eye, which only a replayed shot does (counted once,
// however many soldiers stand on that spot) — into pmem 117 (shown, low half;
// sent, high half).
const SHOTS = `
local _send, _sound = cartbox.netsend, cartbox.sound
local sent, shown = 0, 0
cartbox.netsend = function(a, b)
  if (a & 15) == 5 then sent = sent + 1 end
  return _send(a, b)
end
cartbox.sound = function(name, x, y, z, ...)
  if x and string.sub(name, 1, 5) == "fire_" and phase == "play" then
    for _,o in ipairs(bots) do
      if o.remote and math.abs(o.x - x) < 1e-6 and math.abs(o.z - z) < 1e-6 and math.abs(o.y + EYE - y) < 1e-6 then shown = shown + 1; break end
    end
  end
  return _sound(name, x, y, z, ...)
end
local _T = TIC
function TIC() _T(); pmem(117, (shown & 0xffff) | ((sent & 0xffff) << 16)) end`;

// Records each grenade's blast: the newest at pmem 117 (x and z, cm) and 118
// (y, cm; the count in the high half).
const BLASTS = `
local _burst = cartbox.burst
local n = 0
cartbox.burst = function(name, x, y, z, ...)
  if name == "plasmablast" then
    n = n + 1
    pmem(117, (math.floor(x*100+0.5) & 0xffff) | ((math.floor(z*100+0.5) & 0xffff) << 16))
    pmem(118, (math.floor(y*100+0.5) & 0xffff) | (n << 16))
  end
  return _burst(name, x, y, z, ...)
end`;

// Which weapon pads stand empty (pmem 117, a bit a pad).
const PADS = `
local _T = TIC
function TIC()
  _T()
  if phase == "play" then
    local m = 0
    for i = 1, math.min(31, #MRK // 3) do if (mtimer[i] or 0) > 0 then m = m | (1 << (i-1)) end end
    pmem(117, m)
  end
end`;

const s16 = (v: number) => ((v & 0xffff) >= 32768 ? (v & 0xffff) - 65536 : v & 0xffff) / 100;
const runAndTurn = (f: number) => (f % 240 < 150 ? 0x01 : 0x08);

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("Lockout's fight, seen by everyone (two engines, one room)", () => {
  it("shows every shot one browser fires on the other, both ways, a moment after it's fired", async () => {
    const { host, guest, both } = await room(SHOTS);
    const hostLog: [number, number][] = [];
    const guestLog: [number, number][] = [];
    for (let f = 0; f < 1500; f += 1) {
      // The guest runs and turns, firing in bursts (its rifle and whatever it picks up).
      both(0, runAndTurn(f) | (f % 100 < 40 && f % 4 === 0 ? 0x10 : 0));
      const [h] = host.probe();
      const [g] = guest.probe();
      hostLog.push([h & 0xffff, h >>> 16]);
      guestLog.push([g & 0xffff, g >>> 16]);
    }
    const end = hostLog.length - 1;
    const guestSent = guestLog[end]![1];
    const botsSent = hostLog[end]![1];
    expect(guestSent).toBeGreaterThan(30);
    expect(botsSent).toBeGreaterThan(30);
    // Every shot sent a third of a second ago or more has been shown, and none twice.
    for (let f = 20; f <= end; f += 1) {
      expect(hostLog[f]![0]).toBeGreaterThanOrEqual(guestLog[f - 20]![1]);
      expect(hostLog[f]![0]).toBeLessThanOrEqual(guestLog[f]![1]);
      expect(guestLog[f]![0]).toBeGreaterThanOrEqual(hostLog[f - 20]![1]);
      expect(guestLog[f]![0]).toBeLessThanOrEqual(hostLog[f]![1]);
    }
    console.log(`L5: the guest fired ${guestSent} shots and the host showed ${hostLog[end]![0]}; the host's bots fired ${botsSent}, the guest showed ${guestLog[end]![0]}`);
  }, 300_000);

  it("lands a guest's grenades where they land on the host, to the centimetre", async () => {
    const { host, guest, both } = await room(BLASTS);
    const blasts = { host: [] as [number, number, number][], guest: [] as [number, number, number][] };
    const seen = { host: 0, guest: 0 };
    for (let f = 0; f < 900; f += 1) {
      // Two throws (a double tap of A), at 1.7 s and 6.7 s.
      const tap = f === 100 || f === 102 || f === 400 || f === 402 ? 0x40 : 0;
      both(0, (f < 100 ? runAndTurn(f) : 0) | tap);
      for (const [side, engine] of [["host", host], ["guest", guest]] as const) {
        const [a, b] = engine.probe();
        if (b >>> 16 !== seen[side]) {
          seen[side] = b >>> 16;
          blasts[side].push([s16(a), s16(b), s16(a >>> 16)]);
        }
      }
    }
    expect(blasts.guest).toHaveLength(2);
    expect(blasts.host).toHaveLength(2);
    for (let i = 0; i < 2; i += 1) {
      const [g, h] = [blasts.guest[i]!, blasts.host[i]!];
      expect(Math.hypot(g[0] - h[0], g[1] - h[1], g[2] - h[2])).toBeLessThan(0.03);
    }
    console.log(`L5: grenade blasts, guest ${JSON.stringify(blasts.guest)}, host ${JSON.stringify(blasts.host)}`);
  }, 300_000);

  it("empties a weapon pad on every browser when anyone takes its weapon", async () => {
    const { host, guest, both } = await room(PADS);
    let agree = 0;
    let n = 0;
    let taken = 0;
    for (let f = 0; f < 1800; f += 1) {
      both(0, runAndTurn(f));
      const [h] = host.probe();
      const [g] = guest.probe();
      if (f < 60) continue;
      n += 1;
      if (h === g) agree += 1;
      if (h !== 0) taken += 1;
    }
    // The host's bots go for weapons now and then; the guest sees the pads they emptied.
    expect(taken).toBeGreaterThan(100);
    expect(agree / n).toBeGreaterThan(0.95);
  }, 300_000);
});

function room(probe: string) {
  return lockoutRoom(probe, 0);
}
