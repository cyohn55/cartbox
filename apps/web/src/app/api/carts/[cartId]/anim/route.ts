/**
 * /api/carts/[cartId]/anim — save a cartridge's animation timeline.
 *
 * A cart can declare ambient motion (sprite-frame clips as foreground placements
 * plus keyframed tracks driving scene-layer channels, post-FX values, and
 * placement transforms); the player plays it back host-side at run time. The
 * editor PUTs the animation as JSON here; we authenticate the caller, confirm they
 * own the cart, validate/clamp the shape with the shared parser from
 * @cartbox/player (the same model the runtime consumes), and store it on the cart
 * row. Like the FX and scene sidecars, the animation is handed to the player at
 * play time via its `anim` mount option. Existing owner-write / public-read
 * policies on carts already cover the column.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { resolveAnimUpdate } from "@/lib/anim";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this animation." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Animation body must be JSON." }, { status: 400 });
  }

  // An explicit null clears the animation; anything else is validated by the shared
  // runtime parser (an empty animation is rejected, not silently stored empty).
  const update = resolveAnimUpdate(body);
  if ("error" in update) {
    return NextResponse.json({ error: update.error }, { status: 400 });
  }
  const { anim } = update;

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

  const { error: updateError } = await db.from("carts").update({ anim }).eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
