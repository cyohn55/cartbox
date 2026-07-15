/**
 * Persistence for the handheld pixel editor's working document, so a page reload
 * resumes the drawing (layers and all) rather than only the flattened result.
 *
 * The document is serialised, gzip-compressed, and kept in localStorage. Raw it
 * would blow the ~5 MB budget (a full opaque layer is megabytes), but a flat
 * handheld render compresses to well within it. Every step is guarded: a quota
 * error, an oversize payload, or a corrupt entry degrades to "no saved draft"
 * rather than throwing into the onboarding flow.
 */

import { serializeDoc, deserializeDoc, type PaintDoc } from "@cartbox/editor";

import { gzipToBase64, base64GunzipToText } from "./gzip";

/** localStorage key for the compressed working document. */
const DRAFT_KEY = "cartbox.handheld.draft";
/** Cap on the stored (compressed, base64) draft, kept under the storage budget. */
const MAX_DRAFT_CHARS = 3_000_000;

/**
 * Persist the editor's working document. Silently keeps nothing when the
 * compressed payload would exceed the budget or storage rejects the write, so
 * the in-memory session draft still works even if reload-persistence can't.
 */
export async function saveHandheldDraft(doc: PaintDoc): Promise<void> {
  try {
    const packed = await gzipToBase64(JSON.stringify(serializeDoc(doc)));
    if (packed.length > MAX_DRAFT_CHARS) {
      clearHandheldDraft();
      return;
    }
    window.localStorage.setItem(DRAFT_KEY, packed);
  } catch {
    clearHandheldDraft();
  }
}

/**
 * Restore the saved working document, or null when there is none or it doesn't
 * match the current canvas size (deserializeDoc validates dimensions and shape).
 */
export async function loadHandheldDraft(width: number, height: number): Promise<PaintDoc | null> {
  try {
    const packed = window.localStorage.getItem(DRAFT_KEY);
    if (!packed) return null;
    return deserializeDoc(JSON.parse(await base64GunzipToText(packed)), width, height);
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
}
