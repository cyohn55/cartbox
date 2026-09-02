/**
 * /api/carts/[cartId]/world — save a cartridge's HD-2D world.
 *
 * 3D terrain with the cart's 2D character sprites standing in it as billboards.
 *
 * Authentication, ownership, body validation and the write itself all live in
 * the shared sidecar handler, driven by the registry entry for "world"
 * (see lib/sidecars.ts). The editor saves every sidecar at once through
 * /api/carts/[cartId]/sidecars; this endpoint writes just this one.
 */

import type { NextResponse } from "next/server";

import { handleSidecarPut } from "@/lib/sidecarRoute";

export function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  return handleSidecarPut(request, params.cartId, "world");
}
