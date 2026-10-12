/**
 * Wind test scenes (BEAVER_CREEK_ROADMAP.md B6), shared by the software tests
 * and the WebGL2 parity test: a patch of grass and reeds merged as a foliage
 * layer would be, beside a stiff boulder, in a breeze.
 */

import { composeModelMatrix, foliageBlocks, foliagePreset, type FoliagePreset, type MeshSceneInstance, type SceneWind, type Terrain } from "@cartbox/editor";

/** A flat 4 m square of ground for the plants to stand on. */
export function windGround(): Terrain {
  const n = 9;
  return {
    id: "meadow",
    name: "Meadow",
    origin: [-2, -0.8, -2],
    size: [4, 4],
    samples: n,
    heights: new Float32Array(n * n),
    layers: [{ material: { name: "soil", baseColorFactor: [0.35, 0.3, 0.22, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }],
  };
}

/** A row of `kind` across the ground, merged into a block as foliage is (`wind` overrides the preset's flexibility). */
function row(kind: FoliagePreset, z: number, count: number, wind?: number): MeshSceneInstance {
  const t = windGround();
  const { mesh, settings } = foliagePreset(kind);
  const copies = Array.from({ length: count }, (_, i) => ({ x: 0.4 + (i * 3.2) / Math.max(1, count - 1), z, yaw: i * 0.9, scale: 1.4 }));
  const [block] = foliageBlocks(t, { id: kind, name: kind, terrain: t.id, ...settings, ...(wind !== undefined ? { wind } : {}), copies }, mesh, copies);
  return { mesh: block!.mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) };
}

/** Grass in front, reeds behind, and a boulder that never sways (`still`: every plant stiff). */
export function windInstances(still = false): MeshSceneInstance[] {
  return [row("grass", 1.2, 6, still ? 0 : undefined), row("reeds", 2.4, 5, still ? 0 : undefined), row("boulder", 3.4, 2)];
}

/** The breeze the scenes blow in, and when they're drawn. */
export const WIND: SceneWind = { direction: 0.4, strength: 0.8, gust: 0.6 };
export const WIND_TIME = 1.3;
export const WIND_EYE: [number, number, number] = [0, 0.4, -1.2];
export const WIND_TARGET: [number, number, number] = [0, -0.4, 2];
