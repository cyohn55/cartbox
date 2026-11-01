/**
 * `/api/carts/[cartId]/assets/direct` — an upload straight to storage
 * (AAA_FIDELITY_ROADMAP.md F9e), past the 4.5 MB body a serverless deploy
 * takes. Two calls, JSON both:
 *
 * 1. `{ phase: "begin", name, hash, bytes, contentType }`: the same checks as a
 *    multipart upload (name, type, the model's budget), against the larger
 *    direct ceiling. Bytes already in the store (by hash, from any cart) are
 *    deduplicated at once: the manifest takes them and no upload is needed.
 *    Otherwise the answer is a presigned PUT, bound to the hash by a SHA-256
 *    checksum storage verifies, so the bytes under a hash can only be those.
 * 2. `{ phase: "commit", name, hash, bytes, contentType }` after the browser's
 *    PUT: the object is confirmed at its size, its row written, and only then
 *    the manifest updated (blob, row, manifest, as the multipart path orders them).
 */

import { NextResponse } from "next/server";

import {
  EMPTY_CART_ASSETS,
  MAX_DIRECT_ASSET_BYTES,
  checkAssetUpload,
  describeRejection,
  isValidHash,
  parseCartAssets,
  serializeCartAssets,
  withAsset,
} from "@/lib/cartAssetStore";
import { cartAssetUrl, confirmCartAsset, findCartAsset, presignCartAssetUpload } from "@/lib/cartAssetStorage";
import { guardCartWrite } from "@/lib/sidecarRoute";
import { resolveModelId } from "@/lib/consoleModel";
import { serviceClient } from "@/lib/supabase";
import { getModel } from "@cartbox/player";

interface DirectRequest {
  readonly phase: "begin" | "commit";
  readonly name: string;
  readonly hash: string;
  readonly bytes: number;
  readonly contentType: string;
}

function readRequest(body: unknown): DirectRequest | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if ((b.phase !== "begin" && b.phase !== "commit") || typeof b.name !== "string" || !isValidHash(b.hash) || typeof b.contentType !== "string") return null;
  if (typeof b.bytes !== "number" || !Number.isInteger(b.bytes)) return null;
  return { phase: b.phase, name: b.name, hash: b.hash as string, bytes: b.bytes, contentType: b.contentType };
}

async function saveManifest(cartId: string, assets: ReturnType<typeof withAsset>) {
  return serviceClient().from("carts").update({ assets: serializeCartAssets(assets) }).eq("id", cartId);
}

export async function POST(request: Request, { params }: { params: { cartId: string } }): Promise<NextResponse> {
  const guard = await guardCartWrite(request, params.cartId, "assets");
  if ("response" in guard) return guard.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const req = readRequest(body);
  if (!req) return NextResponse.json({ error: "Expected `phase`, `name`, `hash`, `bytes` and `contentType`." }, { status: 400 });

  const { data, error: readError } = await serviceClient().from("carts").select("assets, console_model").eq("id", params.cartId).maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  const assets = parseCartAssets(data?.assets) ?? EMPTY_CART_ASSETS;
  const model = getModel(resolveModelId(data?.console_model as string | null));

  const rejection = checkAssetUpload(req.name, req.hash, req.bytes, req.contentType, assets, model.assetBudgetBytes, MAX_DIRECT_ASSET_BYTES);
  if (rejection) {
    const status = rejection.reason === "over-budget" || rejection.reason === "too-large" ? 413 : 400;
    return NextResponse.json({ error: describeRejection(rejection) }, { status });
  }

  if (req.phase === "begin") {
    // Already stored (any cart's): reference it, nothing to send.
    const existing = await findCartAsset(req.hash);
    if (existing) {
      const { error } = await saveManifest(params.cartId, withAsset(assets, req.name, existing));
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ name: req.name, ...existing, url: cartAssetUrl(existing), deduplicated: true });
    }
    try {
      const upload = await presignCartAssetUpload(req.hash, req.bytes, req.contentType);
      return NextResponse.json({ upload });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Could not prepare the upload." }, { status: 500 });
    }
  }

  let ref;
  try {
    ref = await confirmCartAsset(req.hash, req.bytes, req.contentType);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record the asset." }, { status: 500 });
  }
  if (!ref) return NextResponse.json({ error: "The upload hasn't reached storage (or arrived at another size)." }, { status: 409 });
  const { error } = await saveManifest(params.cartId, withAsset(assets, req.name, ref));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ name: req.name, ...ref, url: cartAssetUrl(ref), deduplicated: false });
}
