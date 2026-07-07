/**
 * /api/carts/[cartId] — save (and optionally publish) an edited cartridge.
 *
 * The editor PUTs the serialised .tic bytes here; we authenticate the caller
 * and store the bytes in R2. A cart id minted by /edit/new has no row yet, so
 * the first save creates one — published, so every cart a user makes appears
 * in Browse immediately. Later saves confirm ownership and overwrite the
 * stored bytes in place (same r2_key), so the play page serves the new bytes
 * immediately; `?publish=1` additionally marks a previously hidden cart
 * published.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { putObject } from "@/lib/storage";
import { getSessionUserId } from "@/lib/auth";
import { resolveModelId } from "@/lib/consoleModel";
import { buildDefaultProfileRow, buildNewCartRow, isValidCartId } from "@/lib/cartDraft";

/** A .tic cartridge is small; reject anything implausibly large early. */
const MAX_CART_BYTES = 2 * 1024 * 1024;

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this cartridge." }, { status: 401 });
  }
  if (!isValidCartId(params.cartId)) {
    return NextResponse.json({ error: "Invalid cartridge id." }, { status: 400 });
  }

  const db = serviceClient();
  const { data: cart, error: lookupError } = await db
    .from("carts")
    .select("id, owner_id, r2_key, slug")
    .eq("id", params.cartId)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  if (cart && cart.owner_id !== userId) {
    return NextResponse.json({ error: "You can only save your own cartridges." }, { status: 403 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_CART_BYTES) {
    return NextResponse.json({ error: "Cartridge is empty or too large." }, { status: 400 });
  }

  const query = new URL(request.url).searchParams;
  const publish = query.get("publish") === "1";

  // First save of a cart minted by /edit/new: no row exists yet, so create it.
  // The row is published from birth so the cart shows up in Browse right away.
  if (!cart) {
    // Signup creates only the auth user; carts.owner_id references profiles,
    // so materialise a default profile for first-time savers. A duplicate-key
    // error just means a concurrent save already created it — not a failure.
    const { data: profile } = await db.from("profiles").select("id").eq("id", userId).maybeSingle();
    if (!profile) {
      const { error: profileError } = await db.from("profiles").insert(buildDefaultProfileRow(userId));
      if (profileError && profileError.code !== "23505") {
        return NextResponse.json({ error: profileError.message }, { status: 500 });
      }
    }

    const row = buildNewCartRow({
      cartId: params.cartId,
      ownerId: userId,
      title: query.get("title"),
      model: query.get("model"),
    });
    await putObject(row.r2_key, bytes, "application/octet-stream");

    const { error: insertError } = await db.from("carts").insert(row);
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, published: true, slug: row.slug }, { status: 201 });
  }

  await putObject(cart.r2_key, bytes, "application/octet-stream");

  // Persist the console model the editor was using (validated), and publish when
  // asked. Both are row updates, so batch them into one write.
  const update: Record<string, unknown> = {};
  if (publish) update.published = true;
  if (query.has("model")) update.console_model = resolveModelId(query.get("model"));

  if (Object.keys(update).length > 0) {
    const { error: updateError } = await db.from("carts").update(update).eq("id", cart.id);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, published: publish, slug: cart.slug });
}
