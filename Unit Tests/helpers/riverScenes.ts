/**
 * River test scenes (EDITOR_PRO_ROADMAP.md P3), shared by the software tests
 * and the parity tests: an S-bend river spline's water surface, glossy and
 * mirroring the sky, its ripples flowing along the river (UV space) — or, for
 * comparison, drifting in world space as B5's water does.
 */

import { composeModelMatrix, riverSurface, type MeshMaterial, type MeshSceneInstance, type Spline } from "@cartbox/editor";

/** An S-bend, 3 m wide, across the view. */
export const RIVER_SPLINE: Spline = {
  id: "river",
  name: "River",
  kind: "river",
  points: [
    { p: [-3, 0, -1.5], width: 1.6 },
    { p: [-1, 0, 0.8], width: 1.6 },
    { p: [1, 0, -0.8], width: 1.6 },
    { p: [3, 0, 1.5], width: 1.6 },
  ],
};

/** The river's water: opaque and glossy, so its ripples show as a broken-up reflection. */
export function riverMaterial(along: boolean): MeshMaterial {
  return {
    name: "river-water",
    baseColorFactor: [0.1, 0.2, 0.25, 1],
    baseColorImage: null,
    metallicFactor: 0,
    roughnessFactor: 0.08,
    reflectivity: 1.6,
    water: { strength: 1.6, scale: 2, speed: 1, flow: along ? Math.PI / 2 : 0, ...(along ? { along: true } : {}) },
  };
}

export function riverInstances(along = true): MeshSceneInstance[] {
  const surface = riverSurface(RIVER_SPLINE, riverMaterial(along))!;
  return [{ mesh: { name: "river", primitives: [surface] }, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }];
}

export const RIVER_EYE: [number, number, number] = [0, 4.2, 3.4];
export const RIVER_TARGET: [number, number, number] = [0, 0, 0];
