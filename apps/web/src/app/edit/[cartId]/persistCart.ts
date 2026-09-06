"use client";

/**
 * Saving a cartridge, and saying honestly what happened.
 *
 * The old save fired thirteen requests — the .tic plus a PUT per sidecar plus
 * one for the details — and collapsed every possible failure into a button that
 * read "Retry save". A signed-out creator was told to retry, forever, over a
 * 401 whose body already said "Sign in to save this cartridge."
 *
 * Now it is two requests: the bytes, then the whole sidecar bundle in one
 * write. Both report the server's own message, and the result distinguishes the
 * failure a creator can act on (sign in) from the one they cannot (a 500).
 */

import { authHeaders } from "@/lib/supabase-browser";
import { saveCartDraft } from "@/lib/localCartStore";
import type { CartMeta } from "@/lib/cartMeta";
import type { Sidecars } from "@/lib/sidecars";

export interface SaveRequest {
  cartId: string;
  modelId: string;
  bytes: Uint8Array;
  sidecars: Sidecars;
  meta: CartMeta;
  /** Also list the cart in the marketplace. */
  publish: boolean;
}

export type SaveOutcome =
  | { ok: true; skipped: string[] }
  | { ok: false; reason: "auth" | "denied" | "failed"; message: string };

/** Pull the server's own message out of a failed response. */
async function errorFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Non-JSON body (a proxy error page, say) — fall through.
  }
  return fallback;
}

function reasonFor(status: number): "auth" | "denied" | "failed" {
  if (status === 401) return "auth";
  if (status === 403) return "denied";
  return "failed";
}

/**
 * Save to the account: the .tic bytes first (they create the row on a brand-new
 * cart, which the sidecar write then needs), the bundle second.
 */
export async function saveCartToAccount(request: SaveRequest): Promise<SaveOutcome> {
  const { cartId, modelId, bytes, sidecars, meta, publish } = request;

  // Tag the save with the model so the cart row persists console_model (the URL
  // param that opened a new Pro cart becomes durable on first save), and with
  // the title so a new cart's first row carries the author's name rather than
  // the "Untitled cartridge" default.
  const query = new URLSearchParams({ model: modelId });
  if (publish) query.set("publish", "1");
  const trimmedTitle = meta.title.trim();
  if (trimmedTitle) query.set("title", trimmedTitle);

  let bytesResponse: Response;
  try {
    bytesResponse = await fetch(`/api/carts/${cartId}?${query.toString()}`, {
      method: "PUT",
      headers: await authHeaders({ "Content-Type": "application/octet-stream" }),
      body: bytes.buffer as ArrayBuffer,
    });
  } catch {
    return { ok: false, reason: "failed", message: "Could not reach the server. Your work is kept in this browser." };
  }
  if (!bytesResponse.ok) {
    return {
      ok: false,
      reason: reasonFor(bytesResponse.status),
      message: await errorFrom(bytesResponse, "The cartridge could not be saved."),
    };
  }

  // One request for every sidecar and the marketplace details, written in one
  // statement — so a save can no longer land a new backdrop beside an old
  // collision layer.
  let bundleResponse: Response;
  try {
    bundleResponse = await fetch(`/api/carts/${cartId}/sidecars`, {
      method: "PUT",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sidecars, meta }),
    });
  } catch {
    return { ok: false, reason: "failed", message: "The cartridge saved, but its layers did not reach the server." };
  }
  if (!bundleResponse.ok) {
    return {
      ok: false,
      reason: reasonFor(bundleResponse.status),
      message: await errorFrom(bundleResponse, "The cartridge's layers could not be saved."),
    };
  }

  let skipped: string[] = [];
  try {
    const body = (await bundleResponse.json()) as { skipped?: unknown };
    if (Array.isArray(body.skipped)) skipped = body.skipped.filter((key): key is string => typeof key === "string");
  } catch {
    // A success with an unreadable body is still a success.
  }
  return { ok: true, skipped };
}

/**
 * Save to this browser. The static demo build's only save, and everywhere else
 * the crash-recovery copy that makes a closed tab survivable.
 */
export function saveCartLocally(request: SaveRequest & { saved: boolean }): SaveOutcome {
  const stored = saveCartDraft(request.cartId, {
    model: request.modelId,
    bytes: request.bytes,
    sidecars: request.sidecars,
    meta: request.meta,
    saved: request.saved,
  });
  return stored
    ? { ok: true, skipped: [] }
    : {
        ok: false,
        reason: "failed",
        message: "This browser's storage is full, so the cartridge could not be saved here.",
      };
}
