/**
 * Deterministic physics for a standalone export (EP18): Rapier's
 * cross-platform deterministic build (same API as physics.ts). Bundled to
 * public/standalone/physics-deterministic.js.
 */

import * as RAPIER from "@dimforge/rapier3d-deterministic-compat";

import { createRapierBackend } from "../lib/physicsRapier";

type Rapier = typeof import("@dimforge/rapier3d-compat");

export async function backend() {
  const rapier = ((RAPIER as unknown as { default?: Rapier }).default ?? RAPIER) as unknown as Rapier;
  await rapier.init();
  return createRapierBackend(rapier);
}
