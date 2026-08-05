/**
 * /api/carts/[cartId]/flags — save a cartridge's per-cell tile-flags layer.
 *
 * The Map tab lets an author tag map cells with up to eight gameplay flags
 * (hazard, ladder, one-way platform, water, trigger zones, …); that layer is
 * stored on the cart row as a packed JSON payload (see @cartbox/editor's
 * TileFlags). The editor PUTs it here; we authenticate the caller, confirm they
 * own the cart, validate the shape, and store it. Like the collision sidecar it
 * degrades gracefully if the column has not been migrated yet, so Save never
 * fails on it.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { resolveFlagsUpdate } from "@/lib/flags";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this flags layer." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Flags body must be JSON." }, { status: 400 });
  }

  const update = resolveFlagsUpdate(body);
  if ("error" in update) {
    return NextResponse.json({ error: update.error }, { status: 400 });
  }
  const { flags } = update;

  const db = serviceClient();
  const { data: cart, error: lookupError } = await db
    .from("carts")
    .select("id, owner_id")
    .eq("id", params.cartId)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  if (!cart) {
    return NextResponse.json({ error: "Cartridge not found." }, { status: 404 });
  }
  if (cart.owner_id !== userId) {
    return NextResponse.json({ error: "You can only save your own cartridges." }, { status: 403 });
  }

  const { error: updateError } = await db.from("carts").update({ flags }).eq("id", cart.id);
  if (updateError) {
    // Tolerate the `flags` column not existing yet (migration 0021 unapplied):
    // the layer simply is not stored rather than failing the whole save. Postgres
    // reports an undefined column as 42703.
    if (updateError.code === "42703") {
      return NextResponse.json({ ok: true, stored: false });
    }
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stored: true });
}
