/**
 * Browser-local cart persistence.
 *
 * Two jobs, one store:
 *
 * 1. **The static demo build** (src/lib/staticSite.ts) has no API and no
 *    database, so Save in the editor lands here — the serialised .tic bytes
 *    plus every sidecar the server would have persisted.
 * 2. **Crash recovery, everywhere.** The editor also writes a draft here after
 *    each committed edit, signed in or not, so a closed tab, a crashed browser
 *    or an expired session leaves the work recoverable rather than gone.
 *
 * The sidecars travel as one registry-parsed bundle rather than a field per
 * payload. The old shape had a hand-written field, a hand-written reader and a
 * hand-written writer for each of eleven sidecars — and had never grown the two
 * for `mesh` and `world`, so the demo build's Save reported success while
 * silently discarding every mesh and every HD-2D world a creator had built.
 *
 * Client-only — every entry point guards on `typeof window`.
 */

import { emptySidecars, parseSidecars, type Sidecars } from "./sidecars";
import type { CartMeta } from "./cartMeta";

const STORAGE_KEY_PREFIX = "cartbox.demo.cart.";

export interface StoredCartDraft {
  /** Console model the cart was authored on ("classic" | "pro"). */
  model: string;
  /** Base64-encoded .tic bytes. */
  bytesBase64: string;
  /** Every sidecar the cart carries, validated on read. */
  sidecars: Sidecars;
  /** Marketplace details, so a demo cart's title and tags survive a reload. */
  meta: CartMeta;
  /** ISO timestamp of the save, shown as "last edited". */
  savedAt: string;
  /**
   * False while this draft is only a crash-recovery copy of unsaved work — it
   * was written automatically, not by the creator pressing Save. The editor
   * uses it to offer recovery rather than silently resurrecting a draft the
   * creator had already abandoned.
   */
  saved: boolean;
}

function storageKey(cartId: string): string {
  return `${STORAGE_KEY_PREFIX}${cartId}`;
}

/** Encodes bytes chunk-wise; String.fromCharCode(...bytes) overflows the stack on large carts. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Read a stored draft.
 *
 * Drafts written before the sidecars became a bundle kept one `<key>Json`
 * string per payload; those are still read, so an in-progress cart survives the
 * upgrade rather than opening blank.
 */
export function loadCartDraft(cartId: string): StoredCartDraft | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey(cartId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.model !== "string" || typeof parsed.bytesBase64 !== "string") {
      return null;
    }
    const meta = parsed.meta as Partial<CartMeta> | undefined;
    return {
      model: parsed.model,
      bytesBase64: parsed.bytesBase64,
      sidecars: parsed.sidecars ? parseSidecars(parsed.sidecars) : legacySidecars(parsed),
      meta: {
        title: typeof meta?.title === "string" ? meta.title : "",
        description: typeof meta?.description === "string" ? meta.description : "",
        tags: Array.isArray(meta?.tags) ? meta.tags.filter((tag): tag is string => typeof tag === "string") : [],
      },
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
      saved: parsed.saved !== false,
    };
  } catch {
    return null;
  }
}

/** Read the pre-bundle draft shape: one JSON string per sidecar. */
function legacySidecars(parsed: Record<string, unknown>): Sidecars {
  const source: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.endsWith("Json") || typeof value !== "string") continue;
    const name = key.slice(0, -"Json".length);
    try {
      // The voxel sidecar was stored as its own already-serialised payload, not
      // as JSON of an object, so a parse failure means "use the string as-is".
      source[name] = JSON.parse(value);
    } catch {
      source[name] = value;
    }
  }
  return Object.keys(source).length > 0 ? parseSidecars(source) : emptySidecars();
}

export function draftBytes(draft: StoredCartDraft): Uint8Array {
  return fromBase64(draft.bytesBase64);
}

export interface SaveCartDraftInput {
  model: string;
  bytes: Uint8Array;
  sidecars: Sidecars;
  meta: CartMeta;
  /** False for an automatic crash-recovery write; true when the creator saved. */
  saved?: boolean;
}

/** Returns false when the write failed (e.g. localStorage quota exceeded). */
export function saveCartDraft(cartId: string, input: SaveCartDraftInput): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const draft: StoredCartDraft = {
    model: input.model,
    bytesBase64: toBase64(input.bytes),
    sidecars: input.sidecars,
    meta: input.meta,
    savedAt: new Date().toISOString(),
    saved: input.saved !== false,
  };
  try {
    window.localStorage.setItem(storageKey(cartId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearCartDraft(cartId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(storageKey(cartId));
}
