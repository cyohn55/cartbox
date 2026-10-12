/**
 * Camera bookmarks (ENGINE_PARITY_ROADMAP.md EP26): Unreal's Ctrl+1–9 and
 * 1–9. Ctrl and a digit keeps the scene view's camera in that slot; the digit
 * alone takes the view back there. They are stored in the cart's scene, so
 * everyone who opens the cart finds the same viewpoints (a map's bases, its
 * middle, the view down its sniper lane). Pure.
 */

import type { ViewKind, ViewportCamera } from "./viewportCamera";

export interface CameraBookmark {
  /** 1–9: the digit that recalls it. */
  readonly slot: number;
  readonly camera: ViewportCamera;
}

const VIEWS: readonly ViewKind[] = ["perspective", "top", "front", "side"];
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(finite);

/** One stored camera read back, or null when malformed. */
function readCamera(value: unknown): ViewportCamera | null {
  const c = (value ?? {}) as Partial<Record<keyof ViewportCamera, unknown>>;
  if (!triple(c.position) || !finite(c.yaw) || !finite(c.pitch) || !finite(c.distance) || c.distance <= 0) return null;
  if (!VIEWS.includes(c.view as ViewKind) || !finite(c.orthoSize) || c.orthoSize <= 0) return null;
  return { position: [c.position[0], c.position[1], c.position[2]], yaw: c.yaw, pitch: c.pitch, distance: c.distance, view: c.view as ViewKind, orthoSize: c.orthoSize };
}

/** Stored bookmarks read back: malformed ones and repeated slots dropped, in slot order. */
export function readBookmarks(value: unknown): CameraBookmark[] {
  if (!Array.isArray(value)) return [];
  const bySlot = new Map<number, CameraBookmark>();
  for (const item of value.slice(0, 9)) {
    const b = (item ?? {}) as { slot?: unknown; camera?: unknown };
    const camera = readCamera(b.camera);
    if (typeof b.slot !== "number" || !Number.isInteger(b.slot) || b.slot < 1 || b.slot > 9 || !camera || bySlot.has(b.slot)) continue;
    bySlot.set(b.slot, { slot: b.slot, camera });
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

/** Keep `camera` in `slot`, replacing what was there. */
export function setBookmark(list: readonly CameraBookmark[], slot: number, camera: ViewportCamera): CameraBookmark[] {
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) return [...list];
  return [...list.filter((b) => b.slot !== slot), { slot, camera }].sort((a, b) => a.slot - b.slot);
}

/** The camera kept in `slot`, or null. */
export function bookmarkIn(list: readonly CameraBookmark[], slot: number): ViewportCamera | null {
  return list.find((b) => b.slot === slot)?.camera ?? null;
}

/** The digit a key event names as a bookmark slot (the top row or the keypad), or null. */
export function bookmarkSlot(event: { readonly key: string; readonly code?: string }): number | null {
  const fromCode = event.code?.match(/^(?:Digit|Numpad)([1-9])$/)?.[1];
  const digit = fromCode ?? (/^[1-9]$/.test(event.key) ? event.key : null);
  return digit ? Number(digit) : null;
}
