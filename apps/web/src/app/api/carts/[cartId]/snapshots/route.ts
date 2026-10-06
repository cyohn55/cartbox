/**
 * `/api/carts/[cartId]/snapshots` — the cart's named snapshots
 * (ENGINE_PARITY_ROADMAP.md EP19), for its owner only.
 *
 *   GET              -> { snapshots: [{ id, name, createdAt, size }] }, newest first
 *   POST ?name=…     body: the gzipped snapshot -> { snapshot }
 *
 * The payload goes to object storage when it's configured, else inline on the
 * row. The server keeps it as sent (the editor validates it when it restores).
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { bytesToBase64 } from "@cartbox/editor";

import { isValidCartId } from "@/lib/cartDraft";
import { defaultSnapshotName, snapshotName, snapshotObjectKey, snapshotUploadError } from "@/lib/cartSnapshots";
import { isObjectStorageConfigured } from "@/lib/meshStorage";
import { guardCartWrite } from "@/lib/sidecarRoute";
import { putObject } from "@/lib/storage";
import { serviceClient } from "@/lib/supabase";

type Params = { params: { cartId: string } };

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  if (!isValidCartId(params.cartId)) return NextResponse.json({ error: "Unknown cart" }, { status: 404 });
  const guard = await guardCartWrite(request, params.cartId, "snapshots");
  if ("response" in guard) return guard.response;
  const { data, error } = await serviceClient()
    .from("cart_snapshots")
    .select("id, name, created_at, size")
    .eq("cart_id", guard.cartId)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    snapshots: (data ?? []).map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, size: row.size })),
  });
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  if (!isValidCartId(params.cartId)) return NextResponse.json({ error: "Unknown cart" }, { status: 404 });
  const guard = await guardCartWrite(request, params.cartId, "snapshots");
  if ("response" in guard) return guard.response;
  const bytes = new Uint8Array(await request.arrayBuffer());
  const db = serviceClient();
  const { count, error: countError } = await db.from("cart_snapshots").select("id", { count: "exact", head: true }).eq("cart_id", guard.cartId);
  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });
  const problem = snapshotUploadError(bytes, count ?? 0);
  if (problem) return NextResponse.json({ error: problem.message }, { status: problem.status });

  const id = randomUUID();
  const name = snapshotName(new URL(request.url).searchParams.get("name")) ?? defaultSnapshotName();
  let objectKey: string | null = null;
  if (isObjectStorageConfigured()) {
    try {
      objectKey = snapshotObjectKey(guard.cartId, id);
      await putObject(objectKey, bytes, "application/gzip");
    } catch {
      objectKey = null; // kept inline instead
    }
  }
  const { data, error } = await db
    .from("cart_snapshots")
    .insert({ id, cart_id: guard.cartId, name, size: bytes.length, object_key: objectKey, payload: objectKey ? null : bytesToBase64(bytes) })
    .select("id, name, created_at, size")
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "The snapshot could not be saved." }, { status: 500 });
  return NextResponse.json({ snapshot: { id: data.id, name: data.name, createdAt: data.created_at, size: data.size } });
}
