/**
 * Persistence for the handheld pixel editor's working document, so a page reload
 * — or a switch to another device — resumes the drawing (layers and all) rather
 * than only the flattened result.
 *
 * The document is serialised, gzip-compressed, and kept in localStorage; when the
 * player is signed in it is also mirrored to their profile (via the draft API) so
 * it follows them across devices. Raw it would blow the ~5 MB localStorage budget
 * (a full opaque layer is megabytes), but a flat handheld render compresses to
 * well within it. Every step is guarded: a quota error, an oversize payload, an
 * offline/unauthenticated request, or a corrupt entry degrades to "no saved
 * draft" rather than throwing into the onboarding flow.
 */

import { serializeDoc, deserializeDoc, type PaintDoc } from "@cartbox/editor";

import { gzipToBase64, base64GunzipToText } from "./gzip";
import { isStaticExport } from "./staticSite";
import { authHeaders } from "./supabase-browser";

/** The editor's working copy: the animation's frames and their shared timing. */
export interface HandheldDraft {
  /** One paint document per animation frame (at least one). */
  frames: PaintDoc[];
  /** Per-frame duration in ms, shared across the animation. */
  frameMs: number;
}

/** localStorage key for the compressed working document. */
const DRAFT_KEY = "cartbox.handheld.draft";
/** Cap on the stored (compressed, base64) draft, kept under the storage budget. */
const MAX_DRAFT_CHARS = 3_000_000;
/** Profile-backed draft endpoint (absent in the static demo, which is local-only). */
const DRAFT_ENDPOINT = "/api/console/me/handheld/draft";

/** Mirror the draft to the signed-in profile; a no-op offline/guest/static. */
async function saveRemoteDraft(packed: string | null): Promise<void> {
  if (isStaticExport) return;
  try {
    await fetch(DRAFT_ENDPOINT, {
      method: "PUT",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ draft: packed }),
    });
  } catch {
    // Offline or unauthenticated — the local copy still holds the draft.
  }
}

/** Fetch the profile-backed draft, or null when there is none/offline/guest. */
async function loadRemoteDraft(): Promise<string | null> {
  if (isStaticExport) return null;
  try {
    const response = await fetch(DRAFT_ENDPOINT, { headers: await authHeaders() });
    if (!response.ok) return null;
    const body = (await response.json()) as { draft?: unknown };
    return typeof body.draft === "string" ? body.draft : null;
  } catch {
    return null;
  }
}

/**
 * Persist the editor's working document. Silently keeps nothing when the
 * compressed payload would exceed the budget or storage rejects the write, so
 * the in-memory session draft still works even if reload-persistence can't.
 */
export async function saveHandheldDraft(draft: HandheldDraft): Promise<void> {
  let packed: string;
  try {
    const payload = { frames: draft.frames.map((frame) => serializeDoc(frame)), frameMs: draft.frameMs };
    packed = await gzipToBase64(JSON.stringify(payload));
  } catch {
    clearHandheldDraft();
    return;
  }
  if (packed.length > MAX_DRAFT_CHARS) {
    clearHandheldDraft();
    return;
  }
  try {
    window.localStorage.setItem(DRAFT_KEY, packed);
  } catch {
    // localStorage full/unavailable — the remote copy below still persists it.
  }
  await saveRemoteDraft(packed);
}

/**
 * Restore the saved working document, or null when there is none or it doesn't
 * match the current canvas size (deserializeDoc validates dimensions and shape).
 */
export async function loadHandheldDraft(width: number, height: number): Promise<HandheldDraft | null> {
  // Prefer the profile-backed copy so a new device resumes the drawing; fall
  // back to localStorage for guests, offline use, and the static demo.
  let localPacked: string | null = null;
  try {
    localPacked = window.localStorage.getItem(DRAFT_KEY);
  } catch {
    localPacked = null;
  }
  const packed = (await loadRemoteDraft()) ?? localPacked;
  if (!packed) return null;
  try {
    const payload = JSON.parse(await base64GunzipToText(packed)) as { frames?: unknown; frameMs?: unknown; layers?: unknown };
    // Accept the multi-frame shape, or an older single-document draft as one frame.
    const serialFrames = Array.isArray(payload.frames)
      ? payload.frames
      : Array.isArray(payload.layers)
        ? [payload]
        : [];
    const frames: PaintDoc[] = [];
    for (const serial of serialFrames) {
      const doc = deserializeDoc(serial, width, height);
      if (!doc) return null; // any bad frame invalidates the whole draft
      frames.push(doc);
    }
    if (frames.length === 0) return null;
    const frameMs = typeof payload.frameMs === "number" && payload.frameMs > 0 ? payload.frameMs : 100;

    // Cache a freshly-fetched remote draft locally for the next (offline) load.
    if (packed !== localPacked) {
      try {
        window.localStorage.setItem(DRAFT_KEY, packed);
      } catch {
        /* localStorage full — the remote copy remains the source of truth */
      }
    }
    return { frames, frameMs };
  } catch {
    return null;
  }
}

/** Forget any saved draft (called when the design changes another way). */
export function clearHandheldDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable — nothing to forget */
  }
  void saveRemoteDraft(null);
}
