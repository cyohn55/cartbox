/**
 * Snapshots and interpolation (LOCKOUT_MULTIPLAYER_ROADMAP.md L4): every
 * snapshot is stamped on a clock the room shares, and Lockout draws the other
 * Spartans 100 ms behind the newest snapshots to arrive, between real ones,
 * with a short capped extrapolation through loss. Measured in the network lab
 * against where each owner had its Spartan at that moment, and for snaps. The
 * state grew to carry what a Spartan is doing — pitch, airborne, firing,
 * reloading, a melee swing, grenades — so the others see it aim and move as
 * its owner does: checked on two real engines in one room.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, LOCKOUT_INPUT_ACTIONS } from "@cartbox/editor";
import { CARTBOX_SDK_LUA, MemoryNetHub, NET_WORDS, NetSession, RAM_LAYOUTS, actionsSdkLua, codeChunks, runNetLab, type LinkConditions } from "@cartbox/player";
import { LOCKOUT_ENGINE, LOCKOUT_PROBE, lockoutLabCart, lockoutLabInput } from "./helpers/lockoutNetLab";

const lab = (conditions: LinkConditions, players = 2, ticks = 600) =>
  runNetLab({ players, conditions, ticks, warmup: 30, seed: 3, cart: lockoutLabCart, input: lockoutLabInput(0), probe: LOCKOUT_PROBE, renderDelayMs: 100 });

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("Lockout's interpolation in the lab", () => {
  it("draws a remote Spartan within centimetres of its owner's path at 80 ms with 5% loss, and never snaps", async () => {
    const r = await lab({ latencyMs: 80, jitterMs: 20, loss: 0.05, direct: true });
    const lerp = r.interpolation!;
    expect(r.messages.lost).toBeGreaterThan(0);
    expect(lerp.humans.samples).toBeGreaterThan(1000);
    expect(lerp.humans.mean).toBeLessThan(0.03);
    expect(lerp.humans.p95).toBeLessThan(0.05);
    expect(lerp.snaps).toBe(0);
    expect(lerp.maxStep).toBeLessThan(0.3);
    console.log(
      `L4, 80 ms ±20 with 5% loss: interpolation error mean ${lerp.humans.mean} m, p95 ${lerp.humans.p95} m, largest extra step ${lerp.maxStep} m; ` +
        `drawn behind the owner's present by mean ${r.humans.mean} m`,
    );
  }, 600_000);

  it("holds up at 150 ms and in a full room of 8", async () => {
    const far = await lab({ latencyMs: 150, jitterMs: 30, loss: 0.05, direct: true });
    expect(far.interpolation!.humans.p95).toBeLessThan(0.05);
    expect(far.interpolation!.snaps).toBe(0);
    const full = await lab({ latencyMs: 80, jitterMs: 20, loss: 0.05, direct: true }, 8, 300);
    expect(full.interpolation!.humans.samples).toBeGreaterThan(10_000);
    expect(full.interpolation!.humans.p95).toBeLessThan(0.1);
    expect(full.interpolation!.snaps).toBe(0);
    for (const b of full.bytesPerSecond) expect(b.sent).toBeLessThan(2_000);
    console.log(
      `L4, 150 ms ±30 with 5% loss: error p95 ${far.interpolation!.humans.p95} m; 8 players at 80 ms: error p95 ${full.interpolation!.humans.p95} m, ` +
        `host sends ${full.bytesPerSecond[0]!.sent} B/s`,
    );
  }, 900_000);
});

// Appended to the cart: each tick in play it writes to pmem 117 what this
// browser has for slot 1 — on the guest its own player, on the host its copy
// of the guest: pitch (hundredths of a radian, 8 bits), airborne (bit 8),
// firing (bit 9), and a muzzle flash showing (bit 10).
const PROBE = `;(function()
local _T = TIC
function TIC()
  _T()
  if phase=="play" and p then
    local o = ent_by_slot(1)
    if o == p then
      pmem(117, (math.floor(p.ap*100 + 0.5) & 0xff) | ((p.grounded and 0 or 1) << 8) | ((p.fired_t and tick - p.fired_t < 6) and 1 << 9 or 0))
    elseif o then
      pmem(117, (math.floor((o.pitch or 0)*100 + 0.5) & 0xff) | ((o.air and 1 or 0) << 8) | ((o.firing and 1 or 0) << 9) | (((o.muzzle or 0) > 0) and 1 << 10 or 0))
    end
  end
end
end)()`;

async function engine(tic: Uint8Array, session: NetSession) {
  const mod = await (await import(pathToFileURL(LOCKOUT_ENGINE).href)).default();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
  mod._free(ptr);
  const net = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS);
  return {
    probe: () => net()[117]!,
    step(buttons: number) {
      session.beforeTick(net());
      mod._cbx_tick(h, buttons);
      session.afterTick(net());
    },
  };
}

const s8 = (w: number) => ((w & 0xff) >= 128 ? (w & 0xff) - 256 : w & 0xff) / 100;

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("what a remote Spartan is doing (two engines, one room)", () => {
  it("shows the host the guest's aim, jumps and shots, as the guest has them a moment before", async () => {
    const tic = codeChunks(new TextEncoder().encode(`${CARTBOX_SDK_LUA}\n${actionsSdkLua(LOCKOUT_INPUT_ACTIONS, RAM_LAYOUTS.xbox360)}\n${LOCKOUT_CODE}\n${PROBE}`));
    const hub = new MemoryNetHub();
    let clock = 0;
    const now = () => clock;
    const hostSession = new NetSession(hub.transport("host"), now);
    await hostSession.connect("Host");
    await new Promise((r) => setTimeout(r, 3));
    const guestSession = new NetSession(hub.transport("guest"), now);
    await guestSession.connect("Guest");
    const host = await engine(tic, hostSession);
    const guest = await engine(tic, guestSession);
    const both = (hb: number, gb: number) => {
      host.step(hb);
      guest.step(gb);
      clock += 1000 / 60;
    };
    for (let i = 0; i < 4; i += 1) both(0, 0);
    both(0x10, 0); // the host starts Free for All
    both(0x10, 0);
    both(0, 0);
    const guestSide: number[] = [];
    const hostSide: number[] = [];
    for (let f = 0; f < 1200; f += 1) {
      // The guest runs and turns, jumps every second and a half, and fires in bursts.
      let buttons = f % 240 < 150 ? 0x01 : 0x08;
      if (f % 90 === 0) buttons |= 0x20;
      if (f % 120 < 30) buttons |= 0x10;
      both(0, buttons);
      guestSide.push(guest.probe());
      hostSide.push(host.probe());
    }
    // The host's copy runs the guest's own record a fixed delay behind (its
    // view lag and the 100 ms buffer); find that delay, then compare.
    const air = (w: number) => (w >> 8) & 1;
    const firing = (w: number) => (w >> 9) & 1;
    const lagFor = (k: number) => {
      let miss = 0;
      for (let f = 200; f < guestSide.length; f += 1) miss += Math.abs(s8(hostSide[f]!) - s8(guestSide[f - k]!)) + Math.abs(air(hostSide[f]!) - air(guestSide[f - k]!));
      return miss;
    };
    const ks = Array.from({ length: 12 }, (_, i) => i + 2);
    const k = ks.reduce((best, c) => (lagFor(c) < lagFor(best) ? c : best), ks[0]!);
    expect(k).toBeGreaterThanOrEqual(6); // 100 ms or more behind
    expect(k).toBeLessThanOrEqual(10);
    let pitchErr = 0;
    let n = 0;
    for (let f = 200; f < guestSide.length; f += 1) {
      pitchErr += Math.abs(s8(hostSide[f]!) - s8(guestSide[f - k]!));
      n += 1;
    }
    const jumps = (side: number[]) => side.filter((w, f) => f > 0 && air(w) && !air(side[f - 1]!)).length;
    // The guest's aim moves (auto-aim pitches toward whoever it faces) and the host follows it.
    expect(Math.max(...guestSide.map((w) => Math.abs(s8(w))))).toBeGreaterThan(0.05);
    expect(pitchErr / n).toBeLessThan(0.02);
    // Every jump is seen, in the air about as long as the guest was (the host
    // sees it change at snapshots, 30 a second, so each edge can be a tick off).
    const guestAir = guestSide.filter(air).length;
    expect(guestAir).toBeGreaterThan(100);
    expect(Math.abs(jumps(hostSide) - jumps(guestSide))).toBeLessThanOrEqual(1);
    expect(Math.abs(hostSide.filter(air).length - guestAir)).toBeLessThan(guestAir * 0.1);
    // Its shots: the host sees it firing, with a flash at the muzzle.
    expect(hostSide.filter(firing).length).toBeGreaterThan(50);
    expect(hostSide.filter((w) => (w >> 10) & 1).length).toBeGreaterThan(5);
  }, 300_000);
});
