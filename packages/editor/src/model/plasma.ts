/**
 * Plasma (HALO_INFINITE_STYLE_ROADMAP.md I10): a translucent, self-lit
 * material for energy blades and plasma charges, built as a material graph
 * (EP7) so it runs alike on every renderer. Looking straight into it you see
 * the hot core — near white, nearly opaque; toward its silhouette it cools to
 * the edge colour and thins out, so the shape reads as glowing gas with a
 * bright heart rather than a lit solid. A drifting noise makes it boil.
 *
 * Paired with the refraction of I5 (a heat shimmer round it) and a swing
 * trail (meshTrails.ts), that is the energy sword and the plasma grenade.
 */

import type { MaterialGraph } from "./materialGraph";
import type { MeshMaterial } from "./MeshAsset";

type Rgb = readonly [number, number, number];

export interface PlasmaLook {
  /** The heart's colour, seen face on (emissive, so above 1 is fine and blooms). */
  readonly core: Rgb;
  /** The colour toward the silhouette. */
  readonly edge: Rgb;
  /** How fast the core gives way to the edge (the fresnel's power; higher = more core). */
  readonly falloff: number;
  /** How much the light boils, 0..1. */
  readonly boil: number;
  /** World-space size of the boiling (noise cells per unit). */
  readonly scale: number;
}

/** A sword's plasma: a white-hot heart, electric blue at the edges. */
export const PLASMA_BLADE: PlasmaLook = { core: [1.6, 2.4, 2.8], edge: [0.1, 0.4, 2.4], falloff: 1.3, boil: 0.35, scale: 18 };

/**
 * The plasma's graph: emissive from core to edge by the fresnel, flickered by
 * drifting noise; alpha from nearly opaque face-on to faint at the edge.
 */
export function plasmaGraph(look: PlasmaLook = PLASMA_BLADE): MaterialGraph {
  const k = (v: number): [number, number, number] => [v, v, v];
  return {
    nodes: [
      { id: "fresnel", op: "fresnel", params: { power: look.falloff }, x: 20, y: 20 },
      { id: "core", op: "constant", params: { value: [...look.core] }, x: 20, y: 100 },
      { id: "edge", op: "constant", params: { value: [...look.edge] }, x: 20, y: 170 },
      { id: "colour", op: "mix", inputs: { a: "core", b: "edge", t: "fresnel" }, x: 220, y: 100 },
      // The boil: noise over a point drifting up through the plasma.
      { id: "pos", op: "position", x: 20, y: 260 },
      { id: "time", op: "time", x: 20, y: 330 },
      { id: "rise", op: "constant", params: { value: [0.3, 1.2, 0.5] }, x: 20, y: 390 },
      { id: "drift", op: "multiply", inputs: { a: "time", b: "rise" }, x: 220, y: 340 },
      { id: "moving", op: "add", inputs: { a: "pos", b: "drift" }, x: 400, y: 280 },
      { id: "noise", op: "noise", params: { scale: look.scale, octaves: 2 }, inputs: { position: "moving" }, x: 580, y: 280 },
      { id: "dim", op: "constant", params: { value: k(1 - look.boil) }, x: 580, y: 380 },
      { id: "bright", op: "constant", params: { value: k(1 + look.boil) }, x: 580, y: 450 },
      { id: "flicker", op: "mix", inputs: { a: "dim", b: "bright", t: "noise" }, x: 780, y: 330 },
      { id: "glow", op: "multiply", inputs: { a: "colour", b: "flicker" }, x: 980, y: 160 },
      // Thick at the heart, thin at the silhouette.
      { id: "solid", op: "constant", params: { value: k(0.95) }, x: 220, y: 480 },
      { id: "thin", op: "constant", params: { value: k(0.2) }, x: 220, y: 550 },
      { id: "alpha", op: "mix", inputs: { a: "solid", b: "thin", t: "fresnel" }, x: 420, y: 500 },
    ],
    outputs: { emissive: "glow", alpha: "alpha" },
  };
}

/**
 * A plasma material: translucent and self-lit (a black base, so the light
 * that falls on it adds nothing), with a faint shimmer of the view behind it.
 */
export function plasmaMaterial(name: string, look: PlasmaLook = PLASMA_BLADE): MeshMaterial {
  return {
    name,
    baseColorFactor: [0, 0, 0, 1],
    baseColorImage: null,
    metallicFactor: 0,
    roughnessFactor: 1,
    emissiveFactor: [1, 1, 1],
    alphaMode: "blend",
    graph: plasmaGraph(look),
    distortion: 0.15,
  };
}
