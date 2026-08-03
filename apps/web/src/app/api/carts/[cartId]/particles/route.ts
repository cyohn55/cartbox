/**
 * /api/carts/[cartId]/particles — save a cartridge's weather/particle system.
 *
 * A cart can declare a set of emitters (rain/snow/embers/fog); the player
 * composites them over each frame at runtime from a stateless field. The editor
 * PUTs the spec as JSON here; we authenticate the caller, confirm they own the
 * cart, validate/clamp the shape with the shared parser from @cartbox/player (the
 * same model the runtime consumes), and store it on the cart row. Like the FX,
 * scene, and anim sidecars it is handed to the player at play time via its
 * `particles` mount option. Existing owner-write / public-read policies on carts
 * already cover the column.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { resolveParticlesUpdate } from "@/lib/particles";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this weather." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Weather body must be JSON." }, { status: 400 });
  }

  // An explicit null clears the weather; anything else is validated by the shared
  // runtime parser (an emitter-less spec is rejected, not silently stored empty).
  const update = resolveParticlesUpdate(body);
  if ("error" in update) {
    return NextResponse.json({ error: update.error }, { status: 400 });
  }
  const { particles } = update;

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

  const { error: updateError } = await db.from("carts").update({ particles }).eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
