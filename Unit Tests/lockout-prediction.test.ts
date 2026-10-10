/**
 * Predicted, reconciled movement (LOCKOUT_MULTIPLAYER_ROADMAP.md L7): a guest
 * sends its inputs, the host moves every Spartan by them, and the guest
 * predicts its own soldier with the very same steps — moving the tick it
 * presses — then, each time the host says which of its inputs it has
 * applied, takes the host's state and replays the rest. A prediction that
 * matched costs nothing; one that didn't is corrected, and the correction
 * eased into the view over a few frames. Two real engines over the lab's links.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LOCKOUT_ENGINE } from "./helpers/lockoutNetLab";
import { lockoutRoom } from "./helpers/lockoutRoom";

// The host's bots out of the way (dead, far below), so only the two humans move.
const QUIET = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 then
    for _,o in ipairs(bots) do if not o.human then o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end end
  end
end
end)()`;

// On the guest, pmem 117: its soldier's x and z (cm, low and high halves);
// 118: corrections so far (low byte), and the eased-in offset still showing
// (mm, above). On the host, 117: its copy of the guest's x and z.
const TRACK = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  local o = NETMODE == 1 and p or ent_by_slot(1)
  if not o then return end
  pmem(117, (math.floor(o.x*100+0.5) & 0xffff) | ((math.floor(o.z*100+0.5) & 0xffff) << 16))
  if NETMODE == 1 then
    local off = math.sqrt((p.vox or 0)^2 + (p.voy or 0)^2 + (p.voz or 0)^2)
    pmem(118, ((p.corrections or 0) & 255) | (math.min(0xffffff, math.floor(off*1000)) << 8))
  end
end
end)()`;

// The host stands the guest's soldier on the central floor, facing along it.
const PLACE = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase ~= "play" then return end
  if NETMODE == 2 and tick == 10 then local o = ent_by_slot(1); if o then o.x, o.y, o.z = -4.4, 0, 0 end end
  if NETMODE == 1 and tick < 60 then p.ay = math.pi/2 end
end
end)()`;

// Loops round the central floor: runs (now and then jumping), turns, and
// every fourth lap strafes instead of running.
function lap(f: number): number {
  const cycle = Math.floor(f / 50);
  const t = f % 50;
  if (t >= 30) return 0x08;
  if (cycle % 4 === 3) return 0x40 | 0x08;
  return 0x01 | (t === 15 && cycle % 2 === 0 ? 0x20 : 0);
}

const s16 = (v: number) => ((v & 0xffff) >= 32768 ? (v & 0xffff) - 65536 : v & 0xffff) / 100;
const xz = (w: number): [number, number] => [s16(w), s16(w >>> 16)];

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("a guest's own movement (two engines over the lab's links)", () => {
  it("moves the tick it's told to, and the host, a moment later, agrees to the centimetre all the way", async () => {
    const { both, guest, host } = await lockoutRoom(`${QUIET}\n${PLACE}\n${TRACK}`, { link: { latencyMs: 80, jitterMs: 10, direct: true } });
    // Settle (the first word from the host moves the guest to where the host spawned it).
    for (let f = 0; f < 60; f += 1) both(0, 0);
    const startCorrections = guest.probe()[1] & 255;
    const guestPath: [number, number][] = [];
    const hostPath: [number, number][] = [];
    let firstMove = -1;
    for (let f = 0; f < 1500; f += 1) {
      const buttons = lap(f);
      const before = xz(guest.probe()[0]);
      both(0, buttons);
      const after = xz(guest.probe()[0]);
      if (firstMove < 0 && buttons & 0x01 && Math.hypot(after[0] - before[0], after[1] - before[1]) > 0.1) firstMove = f;
      guestPath.push(after);
      hostPath.push(xz(host.probe()[0]));
    }
    // As responsive as offline: it moved on the very tick it pressed forward.
    expect(firstMove).toBe(0);
    // Not one correction: every input the host applied put it where the guest had guessed.
    expect((guest.probe()[1] & 255) - startCorrections).toBe(0);
    // The host's copy follows the same path a few ticks behind (the inputs' trip).
    const lagFor = (k: number) => {
      let worst = 0;
      for (let f = 100; f < guestPath.length; f += 1) {
        const g = guestPath[f - k]!;
        const h = hostPath[f]!;
        worst = Math.max(worst, Math.hypot(g[0] - h[0], g[1] - h[1]));
      }
      return worst;
    };
    const ks = Array.from({ length: 20 }, (_, i) => i + 1);
    const k = ks.reduce((best, c) => (lagFor(c) < lagFor(best) ? c : best), ks[0]!);
    expect(lagFor(k)).toBeLessThan(0.02);
    console.log(`L7: the host's copy follows the guest's predicted path ${k} ticks behind, to within ${lagFor(k).toFixed(3)} m`);
  }, 300_000);

  it("eases in a correction from the host over a few frames, without a visible snap", async () => {
    // At its tick 600 the host moves its copy of the guest 60 cm sideways: its
    // word is final, and the guest must come round to it.
    const nudge = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase == "play" and NETMODE == 2 and tick == 600 then local o = ent_by_slot(1); if o then o.x = o.x + 0.6 end end
end
end)()`;
    const { both, guest } = await lockoutRoom(`${QUIET}\n${TRACK}\n${nudge}`, { link: { latencyMs: 80, jitterMs: 10, direct: true } });
    const xs: number[] = [];
    const shown: number[] = [];
    const offsets: number[] = [];
    let corrections = 0;
    let before = 0;
    for (let f = 0; f < 900; f += 1) {
      both(0, 0); // standing still: only the host's correction moves it
      const [w, c] = guest.probe();
      if (f === 400) before = c & 255;
      corrections = c & 255;
      xs.push(xz(w)[0]);
      offsets.push((c >>> 8) / 1000);
      shown.push(xz(w)[0] + 0); // the soldier itself; what's drawn is it plus the offset, below
    }
    expect(corrections - before).toBe(1);
    const at = xs.findIndex((x, i) => i > 400 && Math.abs(x - xs[i - 1]!) > 0.3);
    expect(at).toBeGreaterThan(0);
    expect(Math.abs(xs[at]! - xs[at - 1]!)).toBeCloseTo(0.6, 1);
    // What's drawn starts where it was (the full 60 cm held back as an offset)...
    expect(offsets[at]!).toBeGreaterThan(0.55);
    // ... and closes in a tenth of the way or more a frame: most of it gone in
    // ten frames, all of it in twenty, the drawn view never stepping more
    // than 13 cm in a frame.
    expect(offsets[at + 10]!).toBeLessThan(0.08);
    expect(offsets[at + 20]!).toBeLessThan(0.01);
    for (let f = at; f < at + 20; f += 1) expect(offsets[f]! - offsets[f + 1]!).toBeLessThan(0.13);
    void shown;
  }, 300_000);
});
