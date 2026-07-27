/**
 * /api/carts/[cartId]/voxel — save a cartridge's 3D voxel sculpt.
 *
 * The Voxel tab authors a sculpt that has nowhere to live in the .tic banks, so
 * it rides alongside the cart row like the rig, FX and material sidecars: the
 * editor PUTs `{ voxel: "<payload>" }`, we authenticate the caller, confirm they
 * own the cart, bound and structurally validate the payload, and store it.
 *
 * The payload is the editor's own serialized voxel grid, optionally wrapped with
 * the sprite materials that skin it, and is stored as the opaque string the
 * editor round-trips (see lib/voxelSidecar.ts). Existing owner-write /
 * public-read policies on carts already cover the column.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { parseVoxelPayload } from "@/lib/voxelSidecar";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save this sculpt." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Voxel body must be JSON." }, { status: 400 });
  }

  // An empty sculpt is a legitimate save (the author cleared it), and clears the
  // column rather than storing a placeholder.
  const raw = (body as { voxel?: unknown } | null)?.voxel ?? null;
  const voxel = raw === null || raw === "" ? null : parseVoxelPayload(raw);
  if (raw !== null && raw !== "" && voxel === null) {
    return NextResponse.json({ error: "Voxel sculpt is malformed or too large." }, { status: 400 });
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

  const { error: updateError } = await db.from("carts").update({ voxel }).eq("id", cart.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
