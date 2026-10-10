/**
 * Two real Lockout engines — a host and a guest — in one room, as two browsers
 * would be: NetSessions over an in-memory hub on a virtual clock (a sixtieth
 * of a second a tick), with test-only Lua appended to the cart. The host picks
 * a game type from its menu (`downs` presses, then fire).
 */

import { pathToFileURL } from "node:url";

import { LOCKOUT_CODE, LOCKOUT_INPUT_ACTIONS } from "@cartbox/editor";
import { CARTBOX_SDK_LUA, MemoryNetHub, NET_WORDS, NetSession, RAM_LAYOUTS, actionsSdkLua, codeChunks, type NetTransport } from "@cartbox/player";
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

/** A host and a guest in one room, a match of the host's choosing under way. */
export async function lockoutRoom(probe: string, downs = 0, transport?: (hub: MemoryNetHub, id: string) => NetTransport) {
  const tic = codeChunks(new TextEncoder().encode(`${CARTBOX_SDK_LUA}\n${actionsSdkLua(LOCKOUT_INPUT_ACTIONS, RAM_LAYOUTS.xbox360)}\n${LOCKOUT_CODE}\n${probe}`));
  const hub = new MemoryNetHub();
  let clock = 0;
  const now = () => clock;
  const make = (id: string) => (transport ? transport(hub, id) : hub.transport(id));
  const hostSession = new NetSession(make("host"), now);
  await hostSession.connect("Host");
  await new Promise((r) => setTimeout(r, 3));
  const guestSession = new NetSession(make("guest"), now);
  await guestSession.connect("Guest");
  const host = await engine(tic, hostSession);
  const guest = await engine(tic, guestSession);
  const both = (hb: number, gb: number) => {
    host.step(hb);
    guest.step(gb);
    clock += 1000 / 60;
  };
  for (let i = 0; i < 4; i += 1) both(0, 0);
  for (let i = 0; i < downs; i += 1) {
    both(0x02, 0);
    both(0, 0);
  }
  both(0x10, 0);
  both(0x10, 0);
  both(0, 0);
  return { host, guest, both, hostSession, guestSession };
}
