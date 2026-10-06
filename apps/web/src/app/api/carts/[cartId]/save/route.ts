/**
 * `/api/carts/[cartId]/save` — the signed-in player's save data for a cart
 * (ENGINE_PARITY_ROADMAP.md EP15b): what the cart last saved with
 * cartbox.save, so progress follows the player between browsers.
 *
 *   GET     -> { data, updatedAt } or { data: null }
 *   PUT     { data, updatedAt } — kept unless the stored save is newer
 *   DELETE  forget it (the cart called cartbox.erase)
 *
 * The player always comes from the session, never the body, so nobody can
 * read or write another player's saves; anonymous requests get 401.
 */

import { NextResponse } from "next/server";

import { getSessionUserId } from "@/lib/auth";
import { isValidCartId } from "@/lib/cartDraft";
import { MAX_SAVE_CHARS, parseCloudSaveBody } from "@/lib/saveData";
import { serviceClient } from "@/lib/supabase";

type Params = { params: { cartId: string } };

async function who(request: Request, cartId: string): Promise<{ userId: string } | NextResponse> {
  if (!isValidCartId(cartId)) return NextResponse.json({ error: "Unknown cart" }, { status: 404 });
  const userId = await getSessionUserId(request);
  if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  return { userId };
}

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const auth = await who(request, params.cartId);
  if (auth instanceof NextResponse) return auth;
  const { data, error } = await serviceClient()
    .from("cart_saves")
    .select("data, updated_at")
    .eq("profile_id", auth.userId)
    .eq("cart_id", params.cartId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ data: null });
  return NextResponse.json({ data: JSON.stringify(data.data), updatedAt: data.updated_at });
}

export async function PUT(request: Request, { params }: Params): Promise<NextResponse> {
  const auth = await who(request, params.cartId);
  if (auth instanceof NextResponse) return auth;
  const raw = await request.text();
  if (raw.length > MAX_SAVE_CHARS * 2) return NextResponse.json({ error: "Save too large" }, { status: 413 });
  const body = parseCloudSaveBody(raw);
  if (!body) return NextResponse.json({ error: "A save is { data: JSON text of an object or list, updatedAt }" }, { status: 400 });
  const db = serviceClient();
  // A save made later elsewhere stays: the newer one wins.
  const { data: existing } = await db.from("cart_saves").select("updated_at").eq("profile_id", auth.userId).eq("cart_id", params.cartId).maybeSingle();
  if (existing && Date.parse(existing.updated_at) > Date.parse(body.updatedAt)) {
    return NextResponse.json({ kept: false, updatedAt: existing.updated_at });
  }
  const { error } = await db
    .from("cart_saves")
    .upsert({ profile_id: auth.userId, cart_id: params.cartId, data: JSON.parse(body.data), updated_at: body.updatedAt });
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "23503" ? 404 : 500 });
  return NextResponse.json({ kept: true, updatedAt: body.updatedAt });
}

export async function DELETE(request: Request, { params }: Params): Promise<NextResponse> {
  const auth = await who(request, params.cartId);
  if (auth instanceof NextResponse) return auth;
  const { error } = await serviceClient().from("cart_saves").delete().eq("profile_id", auth.userId).eq("cart_id", params.cartId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
