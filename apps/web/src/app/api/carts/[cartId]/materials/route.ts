/**
 * /api/carts/[cartId]/materials — save a cartridge's material swatch bindings.
 *
 * The editor PUTs the per-colour material profiles as JSON here; we authenticate
 * the caller, confirm they own the cart, validate the shape, and store it on the
 * cart row. The bindings are editor-only authoring metadata (which normal/height/
 * specular/roughness/emissive a colour stamps) — the painted channel pixels live
 * in the .tic banks; only the brush bindings ride alongside the cart row as JSON.
 * Existing owner-write / public-read policies on carts already cover it.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { parseMaterials } from "@/lib/materials";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save these materials." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Materials body must be JSON." }, { status: 400 });
  }

  const materials = parseMaterials(body);
  if (!materials) {
    return NextResponse.json({ error: "Materials are malformed." }, { status: 400 });
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

  const { error: updateError } = await db.from("carts").update({ materials }).eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
