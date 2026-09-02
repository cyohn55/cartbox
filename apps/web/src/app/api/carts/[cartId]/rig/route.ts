/**
 * /api/carts/[cartId]/rig — save a cartridge's character rig.
 *
 * Editor-only metadata describing how a sprite's parts hang together.
 *
 * Authentication, ownership, body validation and the write itself all live in
 * the shared sidecar handler, driven by the registry entry for "rig"
 * (see lib/sidecars.ts). The editor saves every sidecar at once through
 * /api/carts/[cartId]/sidecars; this endpoint writes just this one.
 */

import type { NextResponse } from "next/server";

import { handleSidecarPut } from "@/lib/sidecarRoute";

export function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  return handleSidecarPut(request, params.cartId, "rig");
}
