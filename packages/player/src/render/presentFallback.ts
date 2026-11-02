/**
 * A browser where presenting from the GPU went wrong falls back to the byte
 * path from then on (DEMO_QUALITY_ROADMAP.md R4).
 *
 * The HD tiers present from the GPU wherever WebGPU is. Its presenter's
 * pipelines are built as its first frames draw, and WebGPU reports what it
 * rejects asynchronously, as an uncaptured error, never by throwing. A
 * browser that rejected one would show a blank game with nothing to say why.
 * So for its first seconds a GPU-presented frame watches its device; an error
 * there is remembered in this browser, and the next mount takes the byte path
 * (each frame read back and composited on the CPU), which has run on every
 * WebGPU browser since the tier shipped.
 */

/** The key the failure is remembered under, in this origin's storage. */
export const PRESENT_FALLBACK_KEY = "cartbox.gpuPresent";
/** How long (ms) a new GPU-presented frame is watched: its pipelines are all built by then. */
export const PRESENT_WATCH_MS = 8000;

/** The bits of `localStorage` this needs (so tests can hand in their own). */
export interface FallbackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** This origin's storage, or null where there is none (or it throws: a private window, blocked site data). */
export function browserStorage(): FallbackStorage | null {
  try {
    return (globalThis as { localStorage?: FallbackStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether presenting from the GPU failed in this browser before. */
export function gpuPresentFailed(storage: FallbackStorage | null): boolean {
  try {
    return storage?.getItem(PRESENT_FALLBACK_KEY) === "failed";
  } catch {
    return false;
  }
}

/** The part of a GPUDevice this needs. */
export interface WatchedDevice {
  addEventListener?(type: "uncapturederror", listener: (event: { error?: { message?: string } }) => void): void;
  removeEventListener?(type: "uncapturederror", listener: (event: { error?: { message?: string } }) => void): void;
}

/**
 * Watch `device` for `ms` after a GPU-presented frame comes up: the first
 * uncaptured error is remembered (and logged), so the next mount presents the
 * byte path's way. Returns a function that stops watching early.
 */
export function watchGpuPresent(
  device: WatchedDevice | null | undefined,
  storage: FallbackStorage | null,
  ms = PRESENT_WATCH_MS,
  schedule: (fn: () => void, ms: number) => unknown = (fn, wait) => setTimeout(fn, wait),
): () => void {
  if (!device?.addEventListener) return () => {};
  let watching = true;
  const listener = (event: { error?: { message?: string } }) => {
    if (!watching) return;
    stop();
    try {
      storage?.setItem(PRESENT_FALLBACK_KEY, "failed");
    } catch {
      // No storage: nothing to remember it in.
    }
    console.warn(`[cartbox] Presenting from the GPU failed (${event.error?.message ?? "a WebGPU error"}); this browser will use the byte path from the next load.`);
  };
  const stop = () => {
    if (!watching) return;
    watching = false;
    device.removeEventListener?.("uncapturederror", listener);
  };
  device.addEventListener("uncapturederror", listener);
  schedule(stop, ms);
  return stop;
}
