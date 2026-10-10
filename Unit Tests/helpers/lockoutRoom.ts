/**
 * Two real Lockout engines — a host and a guest — in one room, as two browsers
 * would be: NetSessions on a virtual clock (a sixtieth of a second a tick),
 * with test-only Lua appended to the cart. The room is an in-memory hub, or,
 * given link conditions, the network lab's simulated network (latency, jitter,
 * loss). The host picks a game type from its menu (`downs` presses, then fire).
 *
 * Probes wrap themselves in a function of their own, `;(function() ... end)()`
 * (the semicolon keeps two in a row from reading as one call): the cart's main
 * chunk is close to Lua's 200 locals, so a probe's locals at
 * top level could tip it over and the cart would fail to load.
 */

import { pathToFileURL } from "node:url";

import { LOCKOUT_CODE, LOCKOUT_INPUT_ACTIONS } from "@cartbox/editor";
import { CARTBOX_SDK_LUA, MemoryNetHub, NET_WORDS, NetSession, RAM_LAYOUTS, SimulatedNetHub, actionsSdkLua, codeChunks, type LinkConditions } from "@cartbox/player";
import { LOCKOUT_ENGINE } from "./lockoutNetLab";

export interface RoomEngine {
  step(buttons: number): void;
  /** pmem 117 and 118: the words the netplay channel leaves to the cart (the probes write there). */
  probe(): [number, number];
}

async function engine(tic: Uint8Array, session: NetSession): Promise<RoomEngine> {
  const mod = await (await import(pathToFileURL(LOCKOUT_ENGINE).href)).default();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  if (mod._cbx_load(h, ptr, tic.length) !== 1) throw new Error("Lockout failed to load");
  mod._free(ptr);
  const net = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS);
  return {
    probe: () => [net()[117]!, net()[118]!],
    step(buttons) {
      session.beforeTick(net());
      mod._cbx_tick(h, buttons);
      session.afterTick(net());
    },
  };
}

export interface RoomOptions {
  /** Menu presses before the host starts (0 Free for All, 4 Oddball). */
  readonly downs?: number;
  /** Over the simulated network with these conditions (else an in-memory hub with no delay). */
  readonly link?: LinkConditions;
  /** Lua appended to the host's cart only (after `probe`). */
  readonly hostProbe?: string;
  /** Lua appended to the guest's cart only (after `probe`). */
  readonly guestProbe?: string;
}

/** A host and a guest in one room, a match of the host's choosing under way. */
export async function lockoutRoom(probe: string, options: RoomOptions | number = {}) {
  const { downs = 0, link, hostProbe = "", guestProbe = "" } = typeof options === "number" ? { downs: options } : options;
  const cart = (extra: string) =>
    codeChunks(new TextEncoder().encode(`${CARTBOX_SDK_LUA}\n${actionsSdkLua(LOCKOUT_INPUT_ACTIONS, RAM_LAYOUTS.xbox360)}\n${LOCKOUT_CODE}\n${probe}\n${extra}`));
  let clock = 0;
  const lab = link ? new SimulatedNetHub(link, 7) : null;
  const memory = lab ? null : new MemoryNetHub();
  const now = lab ? lab.now : () => clock;
  const make = (id: string) => (lab ? lab.transport(id) : memory!.transport(id));
  const hostSession = new NetSession(make("host"), now);
  await hostSession.connect("Host");
  await new Promise((r) => setTimeout(r, 3));
  const guestSession = new NetSession(make("guest"), now);
  await guestSession.connect("Guest");
  const host = await engine(cart(hostProbe), hostSession);
  const guest = await engine(cart(guestProbe), guestSession);
  const both = (hb: number, gb: number) => {
    host.step(hb);
    guest.step(gb);
    if (lab) lab.advance(1000 / 60);
    else clock += 1000 / 60;
  };
  for (let i = 0; i < 4; i += 1) both(0, 0);
  for (let i = 0; i < downs; i += 1) {
    both(0x02, 0);
    both(0, 0);
  }
  both(0x10, 0);
  both(0x10, 0);
  both(0, 0);
  // Over a slow link the guest joins the host's match a moment later: give it time.
  if (lab) for (let i = 0; i < 30; i += 1) both(0, 0);
  return { host, guest, both, hostSession, guestSession };
}

/**
 * Any number of Lockout engines in one room (L8), joining and leaving as the
 * test says: `join(id)` brings a player in (the same id again rejoins),
 * `leave(id)` takes one out, `step(buttons)` runs a tick for everyone (each
 * player's buttons by id, 0 for the rest).
 */
export async function lockoutParty(probe: string, link: LinkConditions = { latencyMs: 30, jitterMs: 5, direct: true }) {
  const tic = codeChunks(new TextEncoder().encode(`${CARTBOX_SDK_LUA}\n${actionsSdkLua(LOCKOUT_INPUT_ACTIONS, RAM_LAYOUTS.xbox360)}\n${LOCKOUT_CODE}\n${probe}`));
  const hub = new SimulatedNetHub(link, 11);
  const players = new Map<string, { session: NetSession; engine: RoomEngine }>();
  const join = async (id: string) => {
    const session = new NetSession(hub.transport(id), hub.now);
    await session.connect(id);
    players.set(id, { session, engine: await engine(tic, session) });
    await new Promise((r) => setTimeout(r, 2));
  };
  const leave = (id: string) => {
    players.get(id)?.session.close();
    players.delete(id);
  };
  const step = (buttons: Record<string, number> = {}) => {
    for (const [id, { engine }] of players) engine.step(buttons[id] ?? 0);
    hub.advance(1000 / 60);
  };
  return { join, leave, step, probe: (id: string) => players.get(id)!.engine.probe(), session: (id: string) => players.get(id)!.session };
}
