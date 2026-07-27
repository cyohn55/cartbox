/**
 * Remember what the player built in the explorable world, so blocks placed in one
 * visit are still standing on the next.
 *
 * The serialization itself lives on {@link BuildLayer} (pure, testable); this
 * module is only the browser boundary — which key, and how to survive a missing or
 * refusing storage (server render, private mode, a full quota). The store is an
 * injected {@link KeyValueStore} rather than a direct `localStorage` reference, so
 * the round trip can be exercised with a real in-memory store instead of a mock.
 */

import type { BuildLayer } from "./worldEdit";

/** Where a world's build layer is remembered. */
export const BUILD_LAYER_KEY = "cartbox.world.build";

/** The slice of the Web Storage API this module needs. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser's `localStorage`, or `null` where there is none (server render) or
 * where merely touching it throws (some privacy modes). Callers treat `null` as
 * "this visit simply isn't remembered".
 */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Save the layer's blocks. An emptied layer removes the entry rather than storing
 * an empty grid, so tearing your build down is itself remembered. Returns whether
 * the store accepted the write.
 */
export function saveBuildLayer(layer: BuildLayer, store: KeyValueStore | null = browserStore()): boolean {
  if (!store) return false;
  try {
    if (layer.count === 0) store.removeItem(BUILD_LAYER_KEY);
    else store.setItem(BUILD_LAYER_KEY, layer.serialize());
    return true;
  } catch {
    return false; // quota exceeded or storage refused; the build just isn't kept
  }
}

/**
 * Restore a previously saved build into `layer`. Returns whether anything was
 * loaded — `false` covers no save, unreadable storage, and a save from a
 * differently sized world (which {@link BuildLayer.restore} rejects).
 */
export function loadBuildLayer(layer: BuildLayer, store: KeyValueStore | null = browserStore()): boolean {
  if (!store) return false;
  let payload: string | null;
  try {
    payload = store.getItem(BUILD_LAYER_KEY);
  } catch {
    return false;
  }
  if (!payload) return false;
  return layer.restore(payload);
}
