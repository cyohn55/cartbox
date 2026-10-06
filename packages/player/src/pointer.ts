/**
 * The pointer for carts: where the mouse (or a finger) is over the console's
 * screen, in console pixels, and its clicks. The UI system (uiSdk.ts) reads it
 * so its documents work with a mouse or a tap as well as the d-pad: pointing
 * at a button or a list row focuses it, a click presses it.
 *
 * The host writes it before every tick into 16 bytes of the debug block's
 * header (debugBlock.ts) that the debugger leaves unused. That block's place is
 * reserved on every core, so the pointer moves nothing else in RAM:
 *
 *   +48  magic ("CBPT")   +52  x (int16)   +54  y (int16)
 *   +56  flags (1 over the screen, 2 held down)   +57  clicks (a counter, mod 256)
 *
 * Clicks are a counter rather than a flag, so a click shorter than a frame is
 * still seen. Like the analog sticks, the pointer isn't recorded in replays: in
 * playback the host writes it as off the screen.
 */

import type { ConsoleModel } from "./models.js";

export const POINTER_AT = 48;
export const POINTER_MAGIC = 0x54504243; // "CBPT"
export const POINTER_X = 52;
export const POINTER_Y = 54;
export const POINTER_FLAGS = 56;
export const POINTER_CLICKS = 57;

export interface PointerState {
  x: number;
  y: number;
  /** Over the console's screen. */
  over: boolean;
  down: boolean;
  /** Clicks so far (the cart compares it with the last tick's). */
  clicks: number;
}

/** Write the pointer into the debug block (a view of it from its start). */
export function writePointer(debugBlock: DataView, state: PointerState | null): void {
  const s = state ?? { x: 0, y: 0, over: false, down: false, clicks: 0 };
  debugBlock.setUint32(POINTER_AT, POINTER_MAGIC, true);
  debugBlock.setInt16(POINTER_X, Math.max(-32768, Math.min(32767, Math.floor(s.x))), true);
  debugBlock.setInt16(POINTER_Y, Math.max(-32768, Math.min(32767, Math.floor(s.y))), true);
  debugBlock.setUint8(POINTER_FLAGS, (s.over ? 1 : 0) | (s.down ? 2 : 0));
  debugBlock.setUint8(POINTER_CLICKS, s.clicks & 0xff);
}

/** The console pixel under a point on the page, given the screen's on-page rectangle. */
export function toConsolePixel(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, model: Pick<ConsoleModel, "width" | "height">): { x: number; y: number; over: boolean } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0, over: false };
  const x = ((clientX - rect.left) / rect.width) * model.width;
  const y = ((clientY - rect.top) / rect.height) * model.height;
  return { x, y, over: x >= 0 && y >= 0 && x < model.width && y < model.height };
}

/**
 * Tracks the pointer over a player's container. The console's screen is the
 * largest canvas in it (the 2D surface, or the post-effect one that replaces
 * it; the 3D overlay sits exactly over it).
 */
export class PointerInput implements PointerState {
  x = 0;
  y = 0;
  over = false;
  down = false;
  clicks = 0;
  private readonly onMove = (e: PointerEvent) => this.track(e);
  private readonly onDown = (e: PointerEvent) => {
    this.track(e);
    if (this.over && e.button === 0) {
      this.down = true;
      this.clicks = (this.clicks + 1) & 0xff;
    }
  };
  private readonly onUp = (e: PointerEvent) => {
    this.track(e);
    this.down = false;
  };
  private readonly onLeave = (e: PointerEvent) => {
    this.down = false;
    // A finger "leaves" the moment it lifts, before the cart's next tick reads
    // the tap; with no hover to lose, its place stays until the next touch.
    if (e.pointerType !== "touch") this.over = false;
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly model: Pick<ConsoleModel, "width" | "height">,
  ) {
    // Capture: the touch pad's overlay sits above the screen and may stop the event.
    container.addEventListener("pointermove", this.onMove, true);
    container.addEventListener("pointerdown", this.onDown, true);
    container.addEventListener("pointerup", this.onUp, true);
    container.addEventListener("pointerleave", this.onLeave, true);
  }

  private screen(): DOMRect | null {
    let best: DOMRect | null = null;
    for (const canvas of Array.from(this.container.querySelectorAll("canvas"))) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && (!best || rect.width * rect.height > best.width * best.height)) best = rect;
    }
    return best;
  }

  private track(e: PointerEvent): void {
    const rect = this.screen();
    if (!rect) return;
    const p = toConsolePixel(e.clientX, e.clientY, rect, this.model);
    this.x = p.x;
    this.y = p.y;
    this.over = p.over;
  }

  destroy(): void {
    this.container.removeEventListener("pointermove", this.onMove, true);
    this.container.removeEventListener("pointerdown", this.onDown, true);
    this.container.removeEventListener("pointerup", this.onUp, true);
    this.container.removeEventListener("pointerleave", this.onLeave, true);
  }
}
