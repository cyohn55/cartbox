/**
 * /api/carts/[cartId]/scene — save a cartridge's parallax-scene backdrop.
 *
 * A cart can declare a backdrop of depth layers (regions of its own sprite sheet)
 * plus an aerial-perspective atmosphere; the player composites them behind the
 * cart's interactive foreground at runtime. The editor PUTs the scene as JSON
 * here; we authenticate the caller, confirm they own the cart, validate/clamp the
 * shape with the shared parser from @cartbox/player (the same model the runtime
 * consumes), and store it on the cart row. Like the FX stack — and unlike the
 * editor-only rig — the scene is handed to the player at play time via its
 * `scene` mount option. Existing owner-write / public-read policies on carts
 * already cover the column.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { resolveSceneUpdate } from "@/lib/scene";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this scene." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Scene body must be JSON." }, { status: 400 });
  }

  // An explicit null clears the scene; anything else is validated by the shared
  // runtime parser (a layer-less scene is rejected, not silently stored empty).
  const update = resolveSceneUpdate(body);
  if ("error" in update) {
    return NextResponse.json({ error: update.error }, { status: 400 });
  }
  const { scene } = update;

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

  const { error: updateError } = await db.from("carts").update({ scene }).eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
