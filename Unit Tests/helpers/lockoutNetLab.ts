/**
 * Lockout in the network lab (LOCKOUT_MULTIPLAYER_ROADMAP.md L2): its cart on
 * the real Xbox 360 engine, how to read where a Spartan is from the state its
 * owner publishes (centimetres, as the cart packs it) and from an observer's
 * mesh poses, and inputs that keep every player running and turning.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { LOCKOUT_CODE, LOCKOUT_INPUT_ACTIONS } from "@cartbox/editor";
import { CARTBOX_SDK_LUA, NET_WORDS, RAM_LAYOUTS, actionsSdkLua, codeChunks, decodeMeshPoses, type LabCart, type LabProbe } from "@cartbox/player";

export const LOCKOUT_ENGINE = path.resolve(__dirname, "../../packages/engine/dist/xbox360/engine.js");

let tic: Uint8Array | null = null;

/** A fresh Lockout cart on the engine (the cart and the SDK, as the netplay tests build it). */
export async function lockoutLabCart(): Promise<LabCart> {
  tic ??= codeChunks(new TextEncoder().encode(`${CARTBOX_SDK_LUA}\n${actionsSdkLua(LOCKOUT_INPUT_ACTIONS, RAM_LAYOUTS.xbox360)}\n${LOCKOUT_CODE}`));
  const mod = await (await import(pathToFileURL(LOCKOUT_ENGINE).href)).default();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  if (mod._cbx_load(h, ptr, tic.length) !== 1) throw new Error("Lockout failed to load");
  mod._free(ptr);
  return {
    net: () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS),
    tick: (buttons) => mod._cbx_tick(h, buttons),
    mailbox: () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice(),
  };
}

const s16 = (v: number) => {
  const w = v & 0xffff;
  return w >= 32768 ? w - 65536 : w;
};

/**
 * Lockout's reading: a slot's state packs x and z (w0) and y (w1) in
 * centimetres, and "dead" in w2's bit 17. An observer draws slot `s` as bot
 * instance s + 1 below its own slot and s above it (its own slot is the
 * first-person player, not an instance); a hidden or dead one sits far below.
 */
export const LOCKOUT_PROBE: LabProbe = {
  owned([w0, w1, w2]) {
    if ((w2 >> 17) & 1) return null;
    return [s16(w0) / 100, s16(w1) / 100, s16(w0 >>> 16) / 100];
  },
  seen(mailbox, observerSlot, slot) {
    const index = slot < observerSlot ? slot + 1 : slot;
    const pose = decodeMeshPoses(mailbox).find((p) => p.index === index);
    if (!pose || pose.hidden || pose.position[1] < -10) return null;
    return pose.position;
  },
};

const UP = 0x01, RIGHT = 0x08, A = 0x10, DOWN = 0x02;

/**
 * Inputs for a lab match: the host (player 0) picks a game type from the menu
 * (`downs` presses, then fire) during the first ticks; then everyone runs
 * forward and turns, each on their own rhythm, so they cross the arena.
 */
export function lockoutLabInput(downs = 0): (player: number, tick: number) => number {
  return (player, tick) => {
    if (tick < 6 + downs * 2 + 3) {
      if (player !== 0 || tick < 6) return 0;
      const k = tick - 6;
      if (k < downs * 2) return k % 2 === 0 ? DOWN : 0;
      return k - downs * 2 < 2 ? A : 0;
    }
    const phase = (tick + player * 53) % (180 + player * 17);
    return phase < 120 ? UP : RIGHT;
  };
}
