/**
 * Browser-local cart persistence for the static "demo" build
 * (src/lib/staticSite.ts).
 *
 * The demo build has no API or database, so Save in the editor lands here:
 * the serialised .tic bytes plus the same sidecars the server would persist
 * (console model, character rig, FX stack), keyed by cart id in localStorage.
 * Client-only — every entry point guards on `typeof window`.
 */

const STORAGE_KEY_PREFIX = "cartbox.demo.cart.";

export interface StoredCartDraft {
  /** Console model the cart was authored on ("classic" | "pro"). */
  model: string;
  /** Base64-encoded .tic bytes. */
  bytesBase64: string;
  /** JSON-serialised character rig, as the rig API endpoint would receive. */
  rigJson: string | null;
  /** JSON-serialised post-processing stack, as the fx endpoint would receive. */
  fxJson: string | null;
  /** ISO timestamp of the save, for future "last edited" UI. */
  savedAt: string;
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

export function loadCartDraft(cartId: string): StoredCartDraft | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey(cartId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredCartDraft>;
    if (typeof parsed.model !== "string" || typeof parsed.bytesBase64 !== "string") {
      return null;
    }
    return {
      model: parsed.model,
      bytesBase64: parsed.bytesBase64,
      rigJson: typeof parsed.rigJson === "string" ? parsed.rigJson : null,
      fxJson: typeof parsed.fxJson === "string" ? parsed.fxJson : null,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function draftBytes(draft: StoredCartDraft): Uint8Array {
  return fromBase64(draft.bytesBase64);
}

export interface SaveCartDraftInput {
  model: string;
  bytes: Uint8Array;
  rig: unknown;
  fx: unknown;
}

/** Returns false when the write failed (e.g. localStorage quota exceeded). */
export function saveCartDraft(cartId: string, input: SaveCartDraftInput): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const draft: StoredCartDraft = {
    model: input.model,
    bytesBase64: toBase64(input.bytes),
    rigJson: input.rig == null ? null : JSON.stringify(input.rig),
    fxJson: input.fx == null ? null : JSON.stringify(input.fx),
    savedAt: new Date().toISOString(),
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
