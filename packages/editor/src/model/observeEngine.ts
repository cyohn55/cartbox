/**
 * observeEngine — wraps a CartEngine so a host learns when the cartridge changes
 * without every editor having to report its own edits. The editors keep talking
 * to the same live cart memory through the SpriteSheet/TileMap/etc. views; the
 * proxy simply fires `onMutate` after any cart-mutating call runs.
 *
 * This keeps undo/redo decoupled from the individual tabs: the sprite, map,
 * code, SFX and music editors need no knowledge that history exists — they call
 * the same engine they always did, and the workbench coalesces the resulting
 * signals into undo steps.
 */

import type { CartEngine } from "../engine/CartEngine";

/**
 * The CartEngine methods that mutate cart data. Only these fire `onMutate`.
 * `setBank` is intentionally excluded — switching banks is navigation, not an
 * edit — as are all read accessors.
 */
const MUTATING_METHODS: ReadonlySet<PropertyKey> = new Set<keyof CartEngine>([
  "setPixel",
  "setPaletteColor",
  "setMapCell",
  "setCode",
  "setLanguage",
  "setSfxVolume",
  "setSfxWave",
  "setWaveformSample",
  "setSfxLoopStart",
  "setSfxLoopSize",
  "setMusicNoteField",
  "setMusicOctave",
  "setMusicSfx",
  "setMusicCommand",
  "setMusicParam",
  "setMusicFramePattern",
  "setNormal",
  "setMaterial",
]);

/**
 * Returns a CartEngine that forwards every call to `engine`, additionally
 * invoking `onMutate` after any cart-mutating method. Instance identity and the
 * prototype chain are preserved, so `instanceof` checks against the underlying
 * engine class still hold.
 */
export function observeEngine(engine: CartEngine, onMutate: () => void): CartEngine {
  return new Proxy(engine, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = value.bind(target);
      if (!MUTATING_METHODS.has(property)) return method;
      return (...args: unknown[]) => {
        const result = method(...args);
        onMutate();
        return result;
      };
    },
  });
}
