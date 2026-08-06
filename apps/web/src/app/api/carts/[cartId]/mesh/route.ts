/**
 * /api/carts/[cartId]/mesh — save a cartridge's imported 3D meshes.
 *
 * The Mesh tab imports triangle meshes (OBJ / glTF-GLB) that have nowhere to live
 * in the .tic banks, so — like the voxel, scene, anim and particle sidecars — the
 * payload rides alongside the cart row: the editor PUTs `{ mesh: "<payload>" }`,
 * we authenticate the caller, confirm they own the cart, structurally validate
 * the payload with the shared sidecar reader (dropping any corrupt entry), and
 * store the sanitised string. An empty payload clears the column.
 *
 * The payload is the editor's own mesh sidecar (see lib/meshSidecar.ts), stored
 * as the opaque string the editor round-trips. Existing owner-write /
 * public-read policies on carts already cover the column.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { decodeMeshSidecar, encodeMeshSidecar } from "@/lib/meshSidecar";
import { storeMeshSidecar, deleteMeshObject, parseMeshReference } from "@/lib/meshStorage";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Sign in to save these meshes." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Mesh body must be JSON." }, { status: 400 });
  }

  // Accept a payload string (or null/empty to clear). Re-decode and re-encode so
  // only well-formed geometry is stored — a corrupt entry is dropped, and a
  // sidecar with no meshes clears the column rather than storing a placeholder.
  const raw = (body as { mesh?: unknown } | null)?.mesh ?? null;
  if (raw !== null && raw !== "" && typeof raw !== "string") {
    return NextResponse.json({ error: "Mesh payload must be a string." }, { status: 400 });
  }
  const encoded = raw === null || raw === "" ? null : encodeMeshSidecar(decodeMeshSidecar(raw));

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

  // Large sidecars offload to object storage, leaving only a reference in the
  // column; small ones (and any save when R2 isn't configured) stay inline.
  const mesh = await storeMeshSidecar(cart.id, encoded);
  const { error: updateError } = await db.from("carts").update({ mesh }).eq("id", cart.id);
  if (updateError) {
    // A not-yet-provisioned `mesh` column (migration lagging this deploy) makes
    // mesh saves a graceful no-op rather than failing the creator's whole Save.
    if (updateError.code === "42703") {
      return NextResponse.json({ ok: true, skipped: "mesh column not provisioned" });
    }
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // When this save didn't offload (cleared, or shrank back under the inline
  // limit), drop any object a previous offloaded save left behind. A re-offload
  // reuses the same deterministic key, so only these transitions can orphan one.
  if (!parseMeshReference(mesh)) {
    await deleteMeshObject(cart.id);
  }

  return NextResponse.json({ ok: true });
}
