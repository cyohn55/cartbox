/**
 * /api/carts — publish a cartridge (POST) and list published cartridges (GET).
 *
 * Publishing: validates the uploaded .tic, stores the bytes in R2, and inserts
 * a row via the service client. Thumbnail rendering is enqueued separately (a
 * headless render worker reads r2_key and writes thumb_key) to keep the request
 * fast.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { serviceClient } from "@/lib/supabase";
import { putObject, publicUrl } from "@/lib/storage";
import { slugify } from "@/lib/slug";
import { getSessionUserId } from "@/lib/auth";

/** A .tic cartridge is small; reject anything implausibly large early. */
const MAX_CART_BYTES = 2 * 1024 * 1024;

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const tag = searchParams.get("tag");
  const limit = Math.min(Number(searchParams.get("limit") ?? 40), 100);

  const db = serviceClient();
  let query = db
    .from("carts")
    .select("id, title, slug, tags, price_cents, thumb_key, plays, owner_id")
    .eq("published", true)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (tag) {
    query = query.contains("tags", [tag]);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const carts = data.map((cart) => ({
    ...cart,
    thumbUrl: cart.thumb_key ? publicUrl(cart.thumb_key) : null,
  }));
  return NextResponse.json({ carts });
}

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("cart");
  const title = String(form.get("title") ?? "").trim();
  const priceCents = Number(form.get("priceCents") ?? 0);

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing cartridge file" }, { status: 400 });
  }
  if (title.length === 0) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_CART_BYTES) {
    return NextResponse.json({ error: "Cartridge is empty or too large" }, { status: 400 });
  }
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    return NextResponse.json({ error: "Invalid price" }, { status: 400 });
  }

  const cartId = randomUUID();
  const r2Key = `carts/${cartId}.tic`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await putObject(r2Key, bytes, "application/octet-stream");

  const db = serviceClient();
  const { data, error } = await db
    .from("carts")
    .insert({
      id: cartId,
      owner_id: userId,
      title,
      slug: slugify(title),
      price_cents: priceCents,
      r2_key: r2Key,
      published: true,
    })
    .select("id, slug")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ cart: data }, { status: 201 });
}
