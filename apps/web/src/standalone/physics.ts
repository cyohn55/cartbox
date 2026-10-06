/**
 * The physics engine for a standalone export (EP18): Rapier, with its
 * WebAssembly inlined in the module, behind the player's PhysicsBackend.
 * Bundled to public/standalone/physics.js; exports that ask for deterministic
 * physics get physicsDeterministic.ts instead.
 */

import * as RAPIER from "@dimforge/rapier3d-compat";

import { createRapierBackend } from "../lib/physicsRapier";

type Rapier = typeof import("@dimforge/rapier3d-compat");

export async function backend() {
  const rapier = ((RAPIER as unknown as { default?: Rapier }).default ?? RAPIER) as Rapier;
  await rapier.init();
  return createRapierBackend(rapier);
}
