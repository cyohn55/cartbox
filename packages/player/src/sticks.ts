/**
 * Analog sticks for carts. TIC-80 carts see eight digital buttons; a cart that
 * wants analog input calls `cartbox.stick(n)`, which reads two pmem words the
 * host page fills in before every tick:
 *
 *   pmem 68  the sticks, one signed byte per axis: left x, left y, right x, right y
 *            (−127..127; x right-positive, y down-positive, like the Gamepad API)
 *   pmem 69  the cart's opt-in: the SDK writes {@link STICK_OPTIN_MAGIC} here the
 *            first time it reads a stick, and only then does the host write word 68
 *
 * A cart that also wants look speed from the player (CONTROLLER_SETTINGS_ROADMAP.md
 * C2) calls `cartbox.lookgain(zoomed)`, which writes {@link LOOK_GAIN_OPTIN_MAGIC}
 * to word 69 instead. From then on the host stops scaling the look stick by the
 * player's sensitivity and writes the gains into word 69 for the cart to multiply
 * its turn and pitch rates by (see {@link packLookGain}):
 *
 *   byte 0  horizontal gain ×32    byte 1  vertical gain ×32
 *   byte 2  zoom multiplier ×32    byte 3  {@link LOOK_GAIN_MARKER} in its top six bits
 *                                          (the low two are kept for the host)
 *
 * so sensitivity above 1 really turns faster than the game's own maximum, and
 * zoom sensitivity and look acceleration reach the game. A cart that only
 * reads sticks keeps the old contract: the stick arrives pre-scaled.
 *
 * Both sit in the gap between the netplay inbox (0..67) and outbox (70..), so a
 * netplay cart already keeps them free; and because the host writes nothing
 * until the cart opts in, a cart keeping save data there is never touched.
 */

import { ConsoleButton } from "./types.js";

export const STICK_WORD = 68;
export const STICK_OPTIN_WORD = 69;
/** "STK1" — written by the SDK's cartbox.stick on first use. */
export const STICK_OPTIN_MAGIC = 0x53544b31;

/** "STK2" — written by the SDK's cartbox.lookgain: the cart scales look itself. */
export const LOOK_GAIN_OPTIN_MAGIC = 0x53544b32;
/** The top byte of word 69 once the host has written gains there ("L"), its low two bits aside. */
export const LOOK_GAIN_MARKER = 0x4c;
const isGainWord = (w: number) => w >>> 26 === LOOK_GAIN_MARKER >>> 2;
/**
 * Gains travel as ×32 in a byte: 1/32 steps up to 255/32 (≈ ×7.97), room for
 * the top sensitivity (×3) at full look acceleration (×2).
 */
const GAIN_SCALE = 32;

/** What the cart has asked of the stick channel, from word 69. */
export type StickChannel = "off" | "sticks" | "gain";

export function stickChannel(optIn: number): StickChannel {
  const w = optIn >>> 0;
  if (w === LOOK_GAIN_OPTIN_MAGIC || isGainWord(w)) return "gain";
  return w === STICK_OPTIN_MAGIC ? "sticks" : "off";
}

/** The look gains a cart reads through cartbox.lookgain. */
export interface LookGain {
  readonly x: number;
  readonly y: number;
  /** Multiplies both while the game says it is zoomed. */
  readonly zoom: number;
}

const gainByte = (v: number) => Math.max(1, Math.min(255, Math.round((Number.isFinite(v) ? v : 1) * GAIN_SCALE)));

/** Pack look gains (each clamped to 1/32..≈7.97) into word 69, marked as the host's. */
export function packLookGain(gain: LookGain): number {
  return (gainByte(gain.x) | (gainByte(gain.y) << 8) | (gainByte(gain.zoom) << 16) | (LOOK_GAIN_MARKER << 24)) >>> 0;
}

/** Unpack word 69 back into gains (for tests and tooling); null when it holds none. */
export function unpackLookGain(word: number): LookGain | null {
  const w = word >>> 0;
  if (!isGainWord(w)) return null;
  return { x: (w & 0xff) / GAIN_SCALE, y: ((w >>> 8) & 0xff) / GAIN_SCALE, zoom: ((w >>> 16) & 0xff) / GAIN_SCALE };
}

/** How far (0..1) a stick must lean before it also presses a D-pad direction. */
export const STICK_DPAD_THRESHOLD = 0.4;

const byte = (v: number) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 127) & 0xff;

/** Pack [lx, ly, rx, ry] (each −1..1) into the word the cart reads. */
export function packSticks(axes: readonly number[]): number {
  return (byte(axes[0]!) | (byte(axes[1]!) << 8) | (byte(axes[2]!) << 16) | (byte(axes[3]!) << 24)) >>> 0;
}

/** Unpack a stick word back into [lx, ly, rx, ry] (for tests and tooling). */
export function unpackSticks(word: number): [number, number, number, number] {
  const axis = (shift: number) => {
    const b = (word >>> shift) & 0xff;
    return (b >= 128 ? b - 256 : b) / 127;
  };
  return [axis(0), axis(8), axis(16), axis(24)];
}

/**
 * The D-pad bits a stick leaning (x, y) presses — eight-way, so every cart that
 * only reads buttons still steers (and walks its menus) with the left stick.
 */
export function stickDirections(x: number, y: number, threshold = STICK_DPAD_THRESHOLD): number {
  let bits = 0;
  if (y < -threshold) bits |= 1 << ConsoleButton.Up;
  if (y > threshold) bits |= 1 << ConsoleButton.Down;
  if (x < -threshold) bits |= 1 << ConsoleButton.Left;
  if (x > threshold) bits |= 1 << ConsoleButton.Right;
  return bits;
}
