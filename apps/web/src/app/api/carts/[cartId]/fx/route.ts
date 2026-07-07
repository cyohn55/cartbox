/**
 * /api/carts/[cartId]/fx — save a cartridge's post-processing effect stack.
 *
 * The editor's FX tab PUTs the settings as JSON here; we authenticate the
 * caller, confirm they own the cart, validate/clamp the shape with the shared
 * parser from @cartbox/player (the same model the runtime consumes), and store
 * it on the cart row. Unlike the rig, the FX stack is not editor-only: the
 * play and playtest routes hand it to the player's PostFxSurface at runtime.
 */

import { NextResponse } from "next/server";
import { parsePostFxSettings } from "@cartbox/player";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save effects." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "FX body must be JSON." }, { status: 400 });
  }

  const fx = parsePostFxSettings(body);
  if (!fx) {
    return NextResponse.json({ error: "FX settings are malformed." }, { status: 400 });
  }

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

  const { error: updateError } = await db.from("carts").update({ fx }).eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
