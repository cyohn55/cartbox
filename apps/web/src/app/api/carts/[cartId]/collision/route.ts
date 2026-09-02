/**
 * /api/carts/[cartId]/collision — save a cartridge's per-cell collision layer.
 *
 * Exposed to the cart's own Lua via cartbox.solid.
 *
 * Authentication, ownership, body validation and the write itself all live in
 * the shared sidecar handler, driven by the registry entry for "collision"
 * (see lib/sidecars.ts). The editor saves every sidecar at once through
 * /api/carts/[cartId]/sidecars; this endpoint writes just this one.
 */

import type { NextResponse } from "next/server";

import { handleSidecarPut } from "@/lib/sidecarRoute";

export function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  return handleSidecarPut(request, params.cartId, "collision");
}
