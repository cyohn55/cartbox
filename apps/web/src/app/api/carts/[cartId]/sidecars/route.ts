/**
 * /api/carts/[cartId]/sidecars — save every sidecar (and the marketplace
 * details) in one request.
 *
 * This is what the editor's Save now calls. It used to fire twelve parallel
 * PUTs — one per sidecar plus one for the details — each re-authenticating,
 * re-reading the cart row and issuing its own UPDATE. When one of the twelve
 * failed the creator got a bare "Retry save" over a row that was now half new
 * and half old, with no way to tell which half.
 *
 * One request, one ownership check, one UPDATE for the required columns. The
 * per-sidecar endpoints remain for callers that want to write a single payload.
 */

import { NextResponse } from "next/server";

import { resolveMetaUpdate } from "@/lib/cartMeta";
import { isValidCartId } from "@/lib/cartDraft";
import { guardCartWrite, resolveSidecarBody } from "@/lib/sidecarRoute";
import { storeSidecars } from "@/lib/sidecarStorage";
import { SIDECAR_KEYS, assignSidecar, emptySidecars, type Sidecars } from "@/lib/sidecars";
import { slugify } from "@/lib/slug";

export async function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  if (!isValidCartId(params.cartId)) {
    return NextResponse.json({ error: "Invalid cartridge id." }, { status: 400 });
  }

  const guard = await guardCartWrite(request, params.cartId, "this cartridge");
  if ("response" in guard) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Save body must be JSON." }, { status: 400 });
  }

  const payload = (body ?? {}) as { sidecars?: unknown; meta?: unknown };

  // Validate every sidecar before writing any of them: a malformed payload is
  // rejected whole rather than landing ten of eleven columns.
  const incoming = (payload.sidecars ?? {}) as Record<string, unknown>;
  const sidecars: Sidecars = emptySidecars();
  for (const key of SIDECAR_KEYS) {
    const update = resolveSidecarBody(key, incoming[key] ?? null);
    if ("error" in update) {
      return NextResponse.json({ error: update.error, sidecar: key }, { status: 400 });
    }
    assignSidecar(sidecars, key, update.value);
  }

  // The marketplace details are optional on a save — a cart with no details
  // panel open just leaves them alone — but when present they ride in the same
  // UPDATE, so the title and the art it describes can never disagree.
  const extraColumns: Record<string, unknown> = {};
  let slug: string | undefined;
  if (payload.meta !== undefined && payload.meta !== null) {
    const update = resolveMetaUpdate(payload.meta);
    if ("error" in update) {
      return NextResponse.json({ error: update.error }, { status: 400 });
    }
    const { title, description, tags } = update.meta;
    // The id suffix keeps the slug unique per owner even when two carts share a
    // title — the same shape the first-save path mints.
    slug = `${slugify(title)}-${params.cartId.slice(0, 8)}`;
    extraColumns.title = title;
    extraColumns.slug = slug;
    extraColumns.description = description;
    extraColumns.tags = tags;
  }

  const result = await storeSidecars(guard.cartId, sidecars, extraColumns);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not save." }, { status: 500 });
  }

  // `skipped` names sidecars whose column a migration has not created yet. The
  // save succeeded for everything else; the editor surfaces the names so a
  // creator knows which payload did not land rather than assuming all of it did.
  return NextResponse.json({ ok: true, skipped: result.skipped, slug });
}
