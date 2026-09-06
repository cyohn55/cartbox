/**
 * The one request handler behind every sidecar endpoint.
 *
 * Each of the eleven sidecar routes used to be its own ~70-line file that
 * authenticated the caller, looked the cart up, checked ownership, validated
 * the body and wrote one column — the same five steps, copy-pasted eleven
 * times, differing only in a parser and a couple of error strings. Both live
 * here now, driven by the registry, so the routes are one line each and a
 * twelfth sidecar needs no route at all.
 */

import { NextResponse } from "next/server";

import { getSessionUserId } from "./auth";
import { serviceClient } from "./supabase";
import { storeSidecar } from "./sidecarStorage";
import { SIDECARS, type SidecarKey, type SidecarUpdate } from "./sidecars";

/** A cart the caller is allowed to write, or the response explaining why not. */
export type CartGuard = { cartId: string } | { response: NextResponse };

/**
 * Authenticate the caller and confirm they own the cart. Every sidecar write
 * passes through here, so the ownership rule lives in exactly one place.
 */
export async function guardCartWrite(request: Request, cartId: string, what: string): Promise<CartGuard> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return { response: NextResponse.json({ error: `Sign in to save ${what}.` }, { status: 401 }) };
  }

  const db = serviceClient();
  const { data: cart, error } = await db.from("carts").select("id, owner_id").eq("id", cartId).maybeSingle();
  if (error) {
    return { response: NextResponse.json({ error: error.message }, { status: 500 }) };
  }
  if (!cart) {
    return { response: NextResponse.json({ error: "Cartridge not found." }, { status: 404 }) };
  }
  if (cart.owner_id !== userId) {
    return {
      response: NextResponse.json({ error: "You can only save your own cartridges." }, { status: 403 }),
    };
  }
  return { cartId: cart.id };
}

/**
 * Decide what a request body means for one sidecar's column.
 *
 * Bodies arrive in two historical shapes — the bare value, and `{ key: value }`
 * for the opaque-string sidecars — so both are accepted. An absent or empty
 * payload clears the column; anything else must parse.
 */
export function resolveSidecarBody<K extends SidecarKey>(key: K, body: unknown): SidecarUpdate<unknown> {
  const def = SIDECARS[key];
  const wrapped =
    body !== null && typeof body === "object" && !Array.isArray(body) && key in (body as Record<string, unknown>);
  const raw = wrapped ? (body as Record<string, unknown>)[key] : body;

  if (raw === null || raw === undefined || raw === "") {
    return { value: null };
  }
  if (def.resolveUpdate) {
    return def.resolveUpdate(raw) as SidecarUpdate<unknown>;
  }
  const parsed = def.parse(raw);
  if (parsed === null) {
    return { error: `${capitalise(def.label)} is malformed.` };
  }
  return { value: parsed };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Handle `PUT /api/carts/:id/<sidecar>` for any sidecar in the registry.
 *
 * The endpoints remain per-sidecar because they are a stable URL contract (and
 * the verify scripts drive them directly); the editor itself now saves the
 * whole bundle through `/api/carts/:id/sidecars` in a single write.
 */
export async function handleSidecarPut(
  request: Request,
  cartId: string,
  key: SidecarKey,
): Promise<NextResponse> {
  const def = SIDECARS[key];

  const guard = await guardCartWrite(request, cartId, `this cartridge's ${def.label}`);
  if ("response" in guard) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: `${capitalise(def.label)} body must be JSON.` }, { status: 400 });
  }

  const update = resolveSidecarBody(key, body);
  if ("error" in update) {
    return NextResponse.json({ error: update.error }, { status: 400 });
  }

  // Route through the shared writer so the mesh offload and the
  // column-not-provisioned fallback behave identically here and on a full save.
  const result = await storeSidecar(guard.cartId, key, update.value);

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not save." }, { status: 500 });
  }
  if (result.skipped.includes(key)) {
    return NextResponse.json({ ok: true, skipped: `${def.column} column not provisioned` });
  }
  return NextResponse.json({ ok: true });
}
