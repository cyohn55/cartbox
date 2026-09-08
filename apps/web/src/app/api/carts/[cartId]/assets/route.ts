/**
 * `/api/carts/[cartId]/assets` — upload one asset, or read the cart's manifest.
 *
 * The upload is a multipart POST rather than a JSON body carrying base64: an
 * asset is up to 16MB of binary, and base64 would inflate it by a third for
 * nothing.
 *
 * **The hash is recomputed from the bytes, never trusted from the client.** It
 * is the storage key, so a caller who could choose it could overwrite another
 * creator's asset — or make a cart reference bytes that were never uploaded.
 * The client may still *send* a hash: it is compared, and a mismatch is a
 * rejection rather than a silent correction, because it means one side is
 * confused about which bytes it holds.
 */

import { NextResponse } from "next/server";

import {
  checkAssetUpload,
  describeRejection,
  claimedHashAgrees,
  hashAsset,
  parseCartAssets,
  serializeCartAssets,
  withAsset,
  EMPTY_CART_ASSETS,
  MAX_ASSET_BYTES,
} from "@/lib/cartAssetStore";
import { cartAssetUrl, storeCartAsset } from "@/lib/cartAssetStorage";
import { guardCartWrite } from "@/lib/sidecarRoute";
import { resolveModelId } from "@/lib/consoleModel";
import { serviceClient } from "@/lib/supabase";
import { getModel } from "@cartbox/player";

/** Read a cart's current manifest and the model whose budget governs it. */
async function loadCartContext(cartId: string) {
  const { data, error } = await serviceClient()
    .from("carts")
    .select("assets, console_model")
    .eq("id", cartId)
    .maybeSingle();

  if (error) return { error: error.message };
  const assets = parseCartAssets(data?.assets) ?? EMPTY_CART_ASSETS;
  const model = getModel(resolveModelId(data?.console_model as string | null));
  return { assets, model };
}

export async function GET(
  _request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const context = await loadCartContext(params.cartId);
  if ("error" in context) return NextResponse.json({ error: context.error }, { status: 500 });

  return NextResponse.json({
    entries: Object.fromEntries(
      Object.entries(context.assets!.entries).map(([name, ref]) => [
        name,
        { ...ref, url: cartAssetUrl(ref) },
      ]),
    ),
    budgetBytes: context.model!.assetBudgetBytes,
  });
}

export async function POST(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  const guard = await guardCartWrite(request, params.cartId, "assets");
  if ("response" in guard) return guard.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const file = form.get("file");
  const name = form.get("name");
  if (!(file instanceof Blob) || typeof name !== "string") {
    return NextResponse.json({ error: "Expected `file` and `name` fields." }, { status: 400 });
  }

  // Checked before reading the body into memory, so an oversized upload costs
  // a header rather than 16MB of heap.
  if (file.size > MAX_ASSET_BYTES) {
    return NextResponse.json(
      { error: `Asset is ${file.size} bytes, over the ${MAX_ASSET_BYTES}-byte limit.` },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await hashAsset(bytes);

  // A client-supplied hash is a cross-check, never the key.
  if (!claimedHashAgrees(form.get("hash"), hash)) {
    return NextResponse.json(
      { error: "Uploaded bytes do not match the hash sent with them." },
      { status: 400 },
    );
  }

  const context = await loadCartContext(params.cartId);
  if ("error" in context) return NextResponse.json({ error: context.error }, { status: 500 });
  const { assets, model } = context;

  const contentType = file.type || "application/octet-stream";
  const rejection = checkAssetUpload(
    name,
    hash,
    bytes.length,
    contentType,
    assets!,
    model!.assetBudgetBytes,
  );
  if (rejection) {
    // A budget refusal is 413; everything else is a malformed request.
    const status = rejection.reason === "over-budget" || rejection.reason === "too-large" ? 413 : 400;
    return NextResponse.json({ error: describeRejection(rejection) }, { status });
  }

  let stored;
  try {
    stored = await storeCartAsset(hash, bytes, contentType);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not store the asset." },
      { status: 500 },
    );
  }

  // Manifest last: an asset with no reference is a storage bill, but a
  // reference with no asset is a missing texture the player sees.
  const next = withAsset(assets!, name, stored.ref);
  const { error } = await serviceClient()
    .from("carts")
    .update({ assets: serializeCartAssets(next) })
    .eq("id", params.cartId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    name,
    ...stored.ref,
    url: cartAssetUrl(stored.ref),
    deduplicated: !stored.uploaded,
  });
}
