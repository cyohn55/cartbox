/**
 * /api/carts/[cartId]/collision — save a cartridge's per-cell collision layer.
 *
 * The Map tab lets an author mark which map cells are solid; that layer is stored
 * on the cart row as a packed JSON payload (see @cartbox/editor's CollisionMap).
 * The editor PUTs it here; we authenticate the caller, confirm they own the cart,
 * validate the shape with the shared parser, and store it on the cart row. Like
 * the scene and voxel sidecars it cannot live in the frozen .tic, so it rides
 * alongside the cart row as JSON. Existing owner-write / public-read policies on
 * carts already cover the column.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { resolveCollisionUpdate } from "@/lib/collision";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this collision layer." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Collision body must be JSON." }, { status: 400 });
  }

  const update = resolveCollisionUpdate(body);
  if ("error" in update) {
    return NextResponse.json({ error: update.error }, { status: 400 });
  }
  const { collision } = update;

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

  const { error: updateError } = await db.from("carts").update({ collision }).eq("id", cart.id);
  if (updateError) {
    // Tolerate the `collision` column not existing yet: on a deployment where
    // migration 0020 has not been applied, the layer simply is not stored rather
    // than failing the whole save (the .tic and other sidecars still persist).
    // Postgres reports an undefined column as 42703.
    if (updateError.code === "42703") {
      return NextResponse.json({ ok: true, stored: false });
    }
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stored: true });
}
