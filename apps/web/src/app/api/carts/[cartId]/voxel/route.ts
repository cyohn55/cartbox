/**
 * /api/carts/[cartId]/voxel — save a cartridge's 3D voxel sculpt.
 *
 * The Voxel tab's sculpt plus the Map tab's voxel columns, which share one
 * payload (see lib/voxelSidecar).
 *
 * Authentication, ownership, body validation and the write itself all live in
 * the shared sidecar handler, driven by the registry entry for "voxel"
 * (see lib/sidecars.ts). The editor saves every sidecar at once through
 * /api/carts/[cartId]/sidecars; this endpoint writes just this one.
 */

import type { NextResponse } from "next/server";

import { handleSidecarPut } from "@/lib/sidecarRoute";

export function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  return handleSidecarPut(request, params.cartId, "voxel");
}
