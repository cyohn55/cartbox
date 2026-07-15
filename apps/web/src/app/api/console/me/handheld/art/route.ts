/**
 * /api/console/me/handheld/art — upload the signed-in player's flattened custom
 * handheld artwork (POST). The editor sends the raw PNG bytes; this route
 * validates the format and size, reads its true dimensions from the PNG header
 * (no image library needed), stores it in object storage under a per-user key,
 * and returns the public URL + dimensions. The caller then persists that art on
 * the profile through the normal handheld PUT, which re-validates it.
 *
 * Uploading the bytes and recording the skin are kept separate so the existing
 * debounced profile sync (HandheldSkinContext) stays the single writer of the
 * `handheld` row, exactly as region recolouring already works.
 */

import { NextResponse } from "next/server";

import { putObject, publicUrl } from "@/lib/storage";
import { getSessionUserId } from "@/lib/auth";
import { isPng, readPngSize } from "@/lib/png";

/** Largest custom-art upload accepted (1 MB — a flat PNG render is far smaller). */
const MAX_ART_BYTES = 1_000_000;
/** Largest dimension accepted on either axis, matching the handheld art gate. */
const MAX_ART_DIMENSION = 4096;

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ART_BYTES) {
    return NextResponse.json({ error: "Artwork is empty or too large." }, { status: 400 });
  }
  if (!isPng(bytes)) {
    return NextResponse.json({ error: "Artwork must be a PNG image." }, { status: 400 });
  }
  const dimensions = readPngSize(bytes, MAX_ART_DIMENSION);
  if (!dimensions) {
    return NextResponse.json({ error: "Artwork has invalid dimensions." }, { status: 400 });
  }

  // A fresh key per upload so a CDN never serves a stale copy of a re-drawn skin.
  const key = `handheld/${userId}-${Date.now().toString(36)}.png`;
  try {
    await putObject(key, bytes, "image/png");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not store the artwork." },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: publicUrl(key), w: dimensions.w, h: dimensions.h });
}
