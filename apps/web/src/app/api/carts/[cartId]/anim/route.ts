/**
 * /api/carts/[cartId]/anim — save a cartridge's animation timeline.
 *
 * Sprite-animation clips, tracks and placements played by the runtime.
 *
 * Authentication, ownership, body validation and the write itself all live in
 * the shared sidecar handler, driven by the registry entry for "anim"
 * (see lib/sidecars.ts). The editor saves every sidecar at once through
 * /api/carts/[cartId]/sidecars; this endpoint writes just this one.
 */

import type { NextResponse } from "next/server";

import { handleSidecarPut } from "@/lib/sidecarRoute";

export function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  return handleSidecarPut(request, params.cartId, "anim");
}
