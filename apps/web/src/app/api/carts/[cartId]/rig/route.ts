/**
 * /api/carts/[cartId]/rig — save a cartridge's character rig.
 *
 * The editor PUTs the rig as JSON here; we authenticate the caller, confirm they
 * own the cart, validate the shape, and store it on the cart row. The rig is
 * editor-only metadata (multi-plane sprite layering for the parallax preview),
 * so it lives beside the cart rather than in the .tic bytes.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { parseRig } from "@/lib/rig";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this rig." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Rig body must be JSON." }, { status: 400 });
  }

  const rig = parseRig(body);
  if (!rig) {
    return NextResponse.json({ error: "Rig is malformed." }, { status: 400 });
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

  const { error: updateError } = await db.from("carts").update({ rig }).eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
