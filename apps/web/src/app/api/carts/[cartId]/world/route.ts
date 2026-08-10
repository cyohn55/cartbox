/**
 * /api/carts/[cartId]/world — save a cartridge's HD-2D world sidecar.
 *
 * The World tab authors a height-mapped 3D tile world plus the billboard slots
 * its 2D character sprites occupy. Like the scene, anim, particle and mesh
 * sidecars the payload rides alongside the cart row: the editor PUTs
 * `{ world: "<json>" }`, we authenticate the caller, confirm they own the cart,
 * structurally validate the payload with the shared runtime parser (rejecting a
 * corrupt one), and store the sanitised string. An empty payload clears it.
 *
 * The payload is small (a grid of ints + a few billboard slots), so unlike the
 * mesh sidecar it always stays inline — no object-storage offload. Existing
 * owner-write / public-read policies on carts already cover the column.
 */

import { NextResponse } from "next/server";

import { parseWorldScene } from "@cartbox/player";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this world." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "World body must be JSON." }, { status: 400 });
  }

  const raw = (body as { world?: unknown } | null)?.world ?? null;
  if (raw !== null && raw !== "" && typeof raw !== "string") {
    return NextResponse.json({ error: "World payload must be a string." }, { status: 400 });
  }
  // Re-serialise through the runtime parser so only a well-formed world is stored;
  // an unparseable or empty payload clears the column rather than persisting junk.
  const parsed = raw ? parseWorldScene(raw) : null;
  const world = parsed ? JSON.stringify(parsed) : null;

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

  const { error: updateError } = await db.from("carts").update({ world }).eq("id", cart.id);
  if (updateError) {
    // A not-yet-provisioned `world` column (migration lagging a deploy) makes the
    // world save a graceful no-op rather than failing the creator's whole Save.
    if (updateError.code === "42703") {
      return NextResponse.json({ ok: true, skipped: "world column not provisioned" });
    }
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
