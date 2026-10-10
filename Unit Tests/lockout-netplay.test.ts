/**
 * Lockout online: two real Xbox 360 engines — a host and a guest — each running
 * the cart, relayed through NetSessions over an in-memory room exactly as two
 * browsers would be over the network. The guest must join the host's match,
 * mirror the host's bots, appear in the host's arena, and agree with the host
 * on every kill, score and objective. The room runs on a virtual clock, a
 * sixtieth of a second a tick, so the guest's drawing of the host's bots a
 * little in the past (L4) is measured against where the host had them then.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, LOCKOUT_INPUT_ACTIONS } from "@cartbox/editor";
import { CARTBOX_SDK_LUA, MemoryNetHub, NET_WORDS, NetSession, RAM_LAYOUTS, actionsSdkLua, codeChunks, decodeMeshPoses } from "@cartbox/player";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

// Test-only probe appended to the cart: after each tick in play it writes the
// scores of slots 0-3 to pmem 117, and to pmem 118 the kill count (bits 0-15),
// the ball carrier's slot (16-19) and everyone's scores summed (20-31) — words
// the netplay channel leaves free.
const PROBE = `
local _rk = register_kill
function register_kill(k, v, h) KILLS = (KILLS or 0) + 1; return _rk(k, v, h) end
local _T = TIC
function TIC()
  _T()
  if phase=="play" and p then
    local s = {}
    local total = 0
    for _,o in ipairs(all_players()) do s[o.ns+1] = math.floor(o.score or 0) & 255; total = total + math.floor(o.score or 0) end
    pmem(117, (s[1] or 0) | ((s[2] or 0) << 8) | ((s[3] or 0) << 16) | ((s[4] or 0) << 24))
    pmem(118, ((KILLS or 0) & 0xffff) | ((ball.carrier and ball.carrier.ns or 9) << 16) | ((math.min(total, 4095)) << 20))
  end
end`;

function cart(): Uint8Array {
  // Split across code banks as needed (the code with the SDK and probe runs past 64 KB).
  // With its input actions (EP15), as the player builds it; no host fills the
  // input block here, so each action answers from its console button.
  const actions = actionsSdkLua(LOCKOUT_INPUT_ACTIONS, RAM_LAYOUTS.xbox360);
  return codeChunks(new TextEncoder().encode(`${CARTBOX_SDK_LUA}\n${actions}\n${LOCKOUT_CODE}\n${PROBE}`));
}

interface Engine {
  step(buttons: number): void;
  net(): Uint32Array;
  poses(): ReturnType<typeof decodeMeshPoses>;
}

async function engine(tic: Uint8Array, session: NetSession): Promise<Engine> {
  const factory = (await import(pathToFileURL(ENGINE).href)).default;
  const mod = await factory();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
  mod._free(ptr);
  const net = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS);
  return {
    net,
    step(buttons) {
      session.beforeTick(net());
      mod._cbx_tick(h, buttons);
      session.afterTick(net());
    },
    poses: () =>
      decodeMeshPoses(new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice()),
  };
}

async function room(downs: number) {
  const hub = new MemoryNetHub();
  const tic = cart();
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
  // The host picks a game type from its menu (down `downs` times, then fire).
  for (let i = 0; i < downs; i += 1) {
    both(0x02, 0);
    both(0, 0);
  }
  both(0x10, 0);
  both(0x10, 0);
  both(0, 0);
  return { host, guest, both, guestSession };
}

const hidden = (y: number) => y < -10;

describe.skipIf(!existsSync(ENGINE))("Lockout over netplay (two engines, one room)", () => {
  it("the guest joins the host's match and both agree on the fight", async () => {
    const { host, guest, both, guestSession } = await room(0); // Free for All
    let guestSawBots = 0;
    let hostSawGuest = 0;
    let err = 0;
    let n = 0;
    const hostBot: ([number, number, number] | null)[] = [];
    for (let f = 0; f < 1500; f += 1) {
      both(0, f % 240 < 150 ? 0x01 : 0x08); // the guest runs and turns
      const hp = host.poses();
      const gp = guest.poses();
      const hb = hp.find((q) => q.index === 2);
      hostBot.push(hb && !hidden(hb.position[1]) ? hb.position : null);
      if (gp.some((q) => q.index >= 1 && q.index <= 7 && !hidden(q.position[1]))) guestSawBots += 1;
      // Slot 1 is the guest: on the host it's instance 1.
      const g = hp.find((q) => q.index === 1);
      if (g && !hidden(g.position[1])) hostSawGuest += 1;
      // Slot 2 is a host bot: instance 2 on both (the host's own slot 0 is the
      // guest's instance 1, so slots >= 2 line up). The guest draws it its view
      // lag and 100 ms in the past: compare with where the host had it then.
      const back = Math.round((guestSession.viewLagMs() + 100) / (1000 / 60));
      const a = hostBot[f - back];
      const b = gp.find((q) => q.index === 2);
      if (a && b && !hidden(b.position[1])) {
        err += Math.hypot(a[0] - b.position[0], a[2] - b.position[2]);
        n += 1;
      }
    }
    expect(guestSawBots).toBeGreaterThan(1400);
    expect(hostSawGuest).toBeGreaterThan(300);
    expect(n).toBeGreaterThan(500);
    expect(err / n).toBeLessThan(0.1); // the guest's copy of a host bot follows its path closely
    // Bots fight each other now: kills happen, and both browsers counted the same ones.
    const kills = host.net()[118]! & 0xffff;
    expect(kills).toBeGreaterThan(3);
    expect(guest.net()[118]! & 0xffff).toBe(kills);
    expect(guest.net()[117]).toBe(host.net()[117]); // same scores for slots 0-3
  }, 180_000);

  it("runs Oddball online with the host's objective mirrored on the guest", async () => {
    const { host, guest, both } = await room(4); // Oddball
    const samples: [number, number][] = [];
    for (let f = 0; f < 2000; f += 1) {
      both(0, f % 240 < 150 ? 0x01 : 0x08);
      if (f % 400 === 399) samples.push([host.net()[117]!, guest.net()[117]!]);
    }
    // Scores reach the guest within one score update (3 a second), so a sample
    // can catch the host a point ahead — never more.
    const unpack = (w: number) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24];
    for (const [a, b] of samples) {
      const host = unpack(a);
      unpack(b).forEach((score, slot) => expect(Math.abs(score - host[slot]!)).toBeLessThanOrEqual(1));
    }
    // Someone (in any slot) has scored by holding the ball, and the carrier matches.
    expect(host.net()[118]! >>> 20).toBeGreaterThan(0);
    expect((guest.net()[118]! >>> 16) & 15).toBe((host.net()[118]! >>> 16) & 15);
    // The match is still on (a point a second, not a point a tick).
    expect(host.poses().some((q) => q.index >= 1 && q.index <= 7 && !hidden(q.position[1]))).toBe(true);
  }, 180_000);
});
