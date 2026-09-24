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
 * Both sit in the gap between the netplay inbox (0..67) and outbox (70..), so a
 * netplay cart already keeps them free; and because the host writes nothing
 * until the cart opts in, a cart keeping save data there is never touched.
 */

import { ConsoleButton } from "./types.js";

export const STICK_WORD = 68;
export const STICK_OPTIN_WORD = 69;
/** "STK1" — written by the SDK's cartbox.stick on first use. */
export const STICK_OPTIN_MAGIC = 0x53544b31;

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
