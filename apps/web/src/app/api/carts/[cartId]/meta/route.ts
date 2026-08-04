/**
 * /api/carts/[cartId]/meta — save a cartridge's marketplace details.
 *
 * The editor's details panel PUTs the cart's title, description and tags here; we
 * authenticate the caller, confirm they own the cart, validate/normalise the
 * fields with the shared parser, and update the row. The slug is re-derived from
 * the (validated) title so the cart's Browse URL tracks its name, keeping the
 * `${slug}-${id8}` shape the first-save path mints so the (owner_id, slug) unique
 * constraint still holds. These are first-class columns, so unlike the render
 * sidecars there is no create path here — the cart row must already exist.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { resolveMetaUpdate } from "@/lib/cartMeta";
import { slugify } from "@/lib/slug";
import { isValidCartId } from "@/lib/cartDraft";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to edit this cartridge." }, { status: 401 });
  }
  if (!isValidCartId(params.cartId)) {
    return NextResponse.json({ error: "Invalid cartridge id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Details body must be JSON." }, { status: 400 });
  }

  const update = resolveMetaUpdate(body);
  if ("error" in update) {
    return NextResponse.json({ error: update.error }, { status: 400 });
  }
  const { title, description, tags } = update.meta;

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
    return NextResponse.json({ error: "You can only edit your own cartridges." }, { status: 403 });
  }

  // The id suffix keeps the slug unique per owner even when two carts share a
  // title — the same shape the first-save path mints.
  const slug = `${slugify(title)}-${params.cartId.slice(0, 8)}`;
  const { error: updateError } = await db
    .from("carts")
    .update({ title, slug, description, tags })
    .eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, slug });
}
