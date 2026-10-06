/**
 * `/api/carts/[cartId]/snapshots/[snapshotId]` — one snapshot
 * (ENGINE_PARITY_ROADMAP.md EP19), for the cart's owner only.
 *
 *   GET     -> the gzipped snapshot
 *   DELETE  -> { deleted: true }
 */

import { NextResponse } from "next/server";

import { base64ToBytes } from "@cartbox/editor";

import { isValidCartId } from "@/lib/cartDraft";
import { guardCartWrite } from "@/lib/sidecarRoute";
import { deleteObject, getObject } from "@/lib/storage";
import { collectStorageGarbage } from "@/lib/storageGarbage";
import { serviceClient } from "@/lib/supabase";

type Params = { params: { cartId: string; snapshotId: string } };

async function find(request: Request, { cartId, snapshotId }: Params["params"]) {
  if (!isValidCartId(cartId) || !isValidCartId(snapshotId)) return { response: NextResponse.json({ error: "Snapshot not found." }, { status: 404 }) };
  const guard = await guardCartWrite(request, cartId, "snapshots");
  if ("response" in guard) return guard;
  const { data, error } = await serviceClient()
    .from("cart_snapshots")
    .select("id, object_key, payload")
    .eq("id", snapshotId)
    .eq("cart_id", guard.cartId)
    .maybeSingle();
  if (error) return { response: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!data) return { response: NextResponse.json({ error: "Snapshot not found." }, { status: 404 }) };
  return { row: data as { id: string; object_key: string | null; payload: string | null } };
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const found = await find(request, params);
  if ("response" in found) return found.response;
  const bytes = found.row.object_key ? await getObject(found.row.object_key) : found.row.payload ? base64ToBytes(found.row.payload) : null;
  if (!bytes) return NextResponse.json({ error: "The snapshot's contents are missing." }, { status: 404 });
  return new Response(bytes.buffer as ArrayBuffer, { headers: { "Content-Type": "application/gzip", "Cache-Control": "private, no-store" } });
}

export async function DELETE(request: Request, { params }: Params): Promise<NextResponse> {
  const found = await find(request, params);
  if ("response" in found) return found.response;
  const { error } = await serviceClient().from("cart_snapshots").delete().eq("id", found.row.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (found.row.object_key) {
    try {
      await deleteObject(found.row.object_key);
    } catch {
      // The row is gone; a stray object costs only storage.
    }
  }
  await collectStorageGarbage();
  return NextResponse.json({ deleted: true });
}
