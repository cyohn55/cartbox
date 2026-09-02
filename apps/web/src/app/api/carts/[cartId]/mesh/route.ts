/**
 * /api/carts/[cartId]/mesh — save a cartridge's imported 3D meshes.
 *
 * Triangle meshes (OBJ / glTF-GLB) that have nowhere to live in the .tic banks.
 * A large payload offloads to object storage, leaving a reference on the row.
 *
 * Authentication, ownership, body validation and the write itself all live in
 * the shared sidecar handler, driven by the registry entry for "mesh"
 * (see lib/sidecars.ts). The editor saves every sidecar at once through
 * /api/carts/[cartId]/sidecars; this endpoint writes just this one.
 */

import type { NextResponse } from "next/server";

import { handleSidecarPut } from "@/lib/sidecarRoute";

export function PUT(
  request: Request,
  { params }: { params: { cartId: string } },
): Promise<NextResponse> {
  return handleSidecarPut(request, params.cartId, "mesh");
}
