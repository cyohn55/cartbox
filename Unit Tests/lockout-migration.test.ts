/**
 * Host migration and joining mid-match (LOCKOUT_MULTIPLAYER_ROADMAP.md L8).
 * Slots stick, so nobody's soldier changes hands when another player leaves;
 * when the host leaves, the player next in line takes over the whole match —
 * the bots where they stand, the objective, every score, the clock — and a
 * player joining a match under way is told what it can't see for itself.
 * Real Lockout engines in one room over the lab's links.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LOCKOUT_ENGINE } from "./helpers/lockoutNetLab";
import { lockoutParty } from "./helpers/lockoutRoom";

// pmem 117: net mode (bits 0-1), my slot (2-4), in a match (5), the ball's
// carrier's slot or 15 (6-9), blue's and red's team scores (10-17, 18-25);
// 118: the scores of slots 0-3, a byte each.
const PROBE = `;(function()
local _T = TIC
function TIC()
  _T()
  local carrier = 15
  if phase == "play" and MODE.obj == "ball" and ball and ball.carrier then carrier = ball.carrier.ns end
  pmem(117, (NETMODE & 3) | ((MYSLOT & 7) << 2) | ((phase == "play" and 1 or 0) << 5) | ((carrier & 15) << 6)
    | ((math.floor(team.blue or 0) & 255) << 10) | ((math.floor(team.red or 0) & 255) << 18))
  if phase == "play" and p then
    local s = {}
    for _,o in ipairs(all_players()) do s[o.ns+1] = math.floor(o.score or 0) & 255 end
    pmem(118, (s[1] or 0) | ((s[2] or 0) << 8) | ((s[3] or 0) << 16) | ((s[4] or 0) << 24))
  end
end
end)()`;

const read = (w: [number, number]) => ({
  mode: w[0] & 3,
  slot: (w[0] >> 2) & 7,
  playing: ((w[0] >> 5) & 1) === 1,
  carrier: (w[0] >> 6) & 15,
  blue: (w[0] >> 10) & 255,
  red: (w[0] >> 18) & 255,
  scores: [w[1] & 255, (w[1] >>> 8) & 255, (w[1] >>> 16) & 255, w[1] >>> 24],
});

/** The host starts a game type from its menu (`downs` presses, then fire). */
function start(room: Awaited<ReturnType<typeof lockoutParty>>, host: string, downs: number) {
  for (let i = 0; i < 4; i += 1) room.step();
  for (let i = 0; i < downs; i += 1) {
    room.step({ [host]: 0x02 });
    room.step();
  }
  room.step({ [host]: 0x10 });
  room.step({ [host]: 0x10 });
  for (let i = 0; i < 30; i += 1) room.step();
}

const run = (f: number) => (f % 240 < 150 ? 0x01 : 0x08) | (f % 7 === 0 ? 0x10 : 0);

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("a match that outlives its host, and takes newcomers", () => {
  it("carries on through Oddball when the host leaves: the next in line hosts, slots stay put, scores and the ball intact", async () => {
    const room = await lockoutParty(PROBE);
    for (const id of ["a", "b", "c"]) await room.join(id);
    start(room, "a", 4); // Oddball
    for (let f = 0; f < 1200; f += 1) room.step({ b: run(f), c: run(f + 100) });
    const before = { b: read(room.probe("b")), c: read(room.probe("c")) };
    expect(before.b.slot).toBe(1);
    expect(before.c.slot).toBe(2);
    expect(Math.max(...before.b.scores)).toBeGreaterThan(0);
    room.leave("a");
    for (let f = 0; f < 120; f += 1) room.step({ b: run(f), c: run(f + 100) });
    const after = { b: read(room.probe("b")), c: read(room.probe("c")) };
    // b took over in its own slot; c kept its slot; both still in the match.
    expect(after.b.mode).toBe(2);
    expect(after.b.slot).toBe(1);
    expect(after.c.mode).toBe(1);
    expect(after.c.slot).toBe(2);
    expect(after.b.playing && after.c.playing).toBe(true);
    // No score went backwards in the handover, and the two agree (a score
    // update a third of a second apart at most).
    for (let s = 0; s < 4; s += 1) {
      expect(after.b.scores[s]!).toBeGreaterThanOrEqual(before.b.scores[s]! - 0);
      expect(Math.abs(after.b.scores[s]! - after.c.scores[s]!)).toBeLessThanOrEqual(1);
    }
    expect(after.c.carrier).toBe(after.b.carrier);
    // And it goes on: someone keeps scoring under the new host.
    for (let f = 0; f < 900; f += 1) room.step({ b: run(f), c: run(f + 100) });
    const later = { b: read(room.probe("b")), c: read(room.probe("c")) };
    expect(later.b.scores.reduce((x, y) => x + y)).toBeGreaterThan(after.b.scores.reduce((x, y) => x + y));
    for (let s = 0; s < 4; s += 1) expect(Math.abs(later.b.scores[s]! - later.c.scores[s]!)).toBeLessThanOrEqual(1);
  }, 600_000);

  it("brings a player joining Team Slayer under way up to date within a second", async () => {
    const room = await lockoutParty(PROBE);
    await room.join("a");
    await room.join("b");
    start(room, "a", 1); // Team Slayer
    for (let f = 0; f < 1800; f += 1) room.step({ b: run(f) });
    const host = read(room.probe("a"));
    expect(host.blue + host.red).toBeGreaterThan(0);
    await room.join("c");
    let caughtUp = -1;
    for (let f = 0; f < 240 && caughtUp < 0; f += 1) {
      room.step({ b: run(f) });
      const a = read(room.probe("a"));
      const c = read(room.probe("c"));
      if (c.playing && c.slot === 2 && c.blue === a.blue && c.red === a.red && c.scores.every((s, i) => Math.abs(s - a.scores[i]!) <= 0)) caughtUp = f;
    }
    expect(caughtUp).toBeGreaterThanOrEqual(0);
    expect(caughtUp).toBeLessThan(60);
  }, 600_000);

  it("gives a player who drops its own slot back, and its score", async () => {
    const room = await lockoutParty(PROBE);
    for (const id of ["a", "b", "c"]) await room.join(id);
    start(room, "a", 0); // Free for All
    for (let f = 0; f < 1500; f += 1) room.step({ b: run(f), c: run(f + 50) });
    const scoreBefore = read(room.probe("a")).scores[2]!;
    room.leave("c");
    for (let f = 0; f < 120; f += 1) room.step({ b: run(f) });
    await room.join("c");
    for (let f = 0; f < 90; f += 1) room.step({ b: run(f) });
    const back = read(room.probe("c"));
    expect(back.slot).toBe(2);
    expect(back.playing).toBe(true);
    expect(back.scores[2]).toBe(read(room.probe("a")).scores[2]);
    expect(back.scores[2]!).toBeGreaterThanOrEqual(scoreBefore);
  }, 600_000);
});
