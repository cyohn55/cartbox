/**
 * Character shading (AAA_FIDELITY_ROADMAP.md F7c): the shading models a face
 * and head need past the full material set, each a `character` on the
 * material, shaded by the linear-light (`aaa`) renderer. The functions here
 * mirror its WGSL term for term; the other renderers draw such a material as
 * its ordinary PBR (skin keeps its F1d subsurface scattering everywhere).
 *
 * - **Skin**: two GGX lobes instead of one (Jimenez's dual specular, as Unreal
 *   ships it): a tighter one and a broader one, mixed, so the oily sheen and the
 *   skin's own roughness both show. A procedural micro-normal (pores, tiled
 *   finely in UV) breaks the highlight up, and the occlusion map's cavities
 *   darken the specular as well as the diffuse.
 * - **Eyes**: one mesh, its UVs centred on the pupil. Inside the iris radius
 *   the surface is the cornea: a smooth, wet reflector. The view refracts
 *   through it (IOR 1.376) and lands on the iris plane `irisDepth` behind,
 *   which offsets where the iris is sampled (parallax). The light refracts
 *   too, and the iris catches it as a caustic on the side away from the light.
 *   A dark limbus ring rims the iris.
 * - **Hair**: strand cards whose strands run along V. The specular is
 *   Kajiya-Kay's along the strand tangent, two lobes as Scheuermann shifts
 *   them along the normal: the white reflection (R) toward the tip, the
 *   coloured one that went through and back (TRT) toward the root and
 *   broader. Light through the hair from behind (TT) scatters forward.
 *   Coverage: a masked card's alpha becomes a dither that changes every frame,
 *   which TAA resolves to the fraction (alpha-to-coverage without MSAA); a
 *   blended one draws its triangles sorted back to front.
 * - **Mouth**: teeth, gums and tongue darken with depth behind the lips: an
 *   occlusion by distance from the opening (a point on the mesh), lessened as
 *   the mouth opens.
 */

import type { MeshMaterial } from "./MeshAsset";

export type CharacterKind = "skin" | "eye" | "hair" | "mouth";

/** A material's character shading. Every field but `kind` has a default. */
export interface CharacterShading {
  readonly kind: CharacterKind;
  // Skin.
  /** The second (broader) lobe's share of the specular, 0..1. */
  readonly lobeMix?: number;
  /** Each lobe's roughness as a multiple of the material's. */
  readonly lobeRoughness?: readonly [number, number];
  /** The micro-normal's tiling (per UV unit) and strength 0..1. */
  readonly microScale?: number;
  readonly microStrength?: number;
  /** How much the occlusion map's cavities darken the specular, 0..1. */
  readonly cavity?: number;
  // Eyes.
  /** The iris's radius in UV units (the UVs centred on the pupil). */
  readonly irisRadius?: number;
  /** How far behind the cornea the iris lies, in UV units. */
  readonly irisDepth?: number;
  readonly corneaIor?: number;
  /** The limbus ring's width, in UV units. */
  readonly limbus?: number;
  /** The caustic's strength. */
  readonly caustic?: number;
  // Hair.
  /** The primary (R) lobe's shift along the normal, and the secondary's (TRT). */
  readonly shift?: number;
  readonly secondaryShift?: number;
  /** How much light from behind comes through (TT), 0..1. */
  readonly scatter?: number;
  // Mouth.
  /** The opening, in the mesh's space; how deep (m) the dark is full; how dark; how open (0..1). */
  readonly opening?: readonly [number, number, number];
  readonly depth?: number;
  readonly occlusion?: number;
  readonly open?: number;
}

/** Every field resolved. */
export interface ResolvedCharacter {
  readonly kind: CharacterKind;
  readonly lobeMix: number;
  readonly lobeRoughness: readonly [number, number];
  readonly microScale: number;
  readonly microStrength: number;
  readonly cavity: number;
  readonly irisRadius: number;
  readonly irisDepth: number;
  readonly corneaIor: number;
  readonly limbus: number;
  readonly caustic: number;
  readonly shift: number;
  readonly secondaryShift: number;
  readonly scatter: number;
  readonly opening: readonly [number, number, number];
  readonly depth: number;
  readonly occlusion: number;
  readonly open: number;
}

export const CHARACTER_KINDS: readonly CharacterKind[] = ["skin", "eye", "hair", "mouth"];

/** The defaults: Unreal's dual-lobe skin, a human eye's cornea, and a fine hair's shifts. */
export const CHARACTER_DEFAULTS: Omit<ResolvedCharacter, "kind"> = {
  lobeMix: 0.15,
  lobeRoughness: [0.75, 1.3],
  microScale: 96,
  microStrength: 0.25,
  cavity: 1,
  irisRadius: 0.16,
  irisDepth: 0.04,
  corneaIor: 1.376,
  limbus: 0.025,
  caustic: 1,
  shift: -0.08,
  secondaryShift: 0.12,
  scatter: 0.5,
  opening: [0, 0, 0],
  depth: 0.05,
  occlusion: 0.9,
  open: 0,
};

/** The cornea's roughness, which its tear film keeps smooth. */
export const CORNEA_ROUGHNESS = 0.06;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Read a stored `character`, clamping each field and dropping what's malformed; undefined for none. */
export function readCharacterShading(raw: unknown): CharacterShading | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!CHARACTER_KINDS.includes(r.kind as CharacterKind)) return undefined;
  const out: { -readonly [K in keyof CharacterShading]: CharacterShading[K] } = { kind: r.kind as CharacterKind };
  const num = (key: keyof CharacterShading, lo: number, hi: number) => {
    const v = r[key];
    if (finite(v)) (out as Record<string, unknown>)[key] = clamp(v, lo, hi);
  };
  num("lobeMix", 0, 1);
  if (Array.isArray(r.lobeRoughness) && r.lobeRoughness.length === 2 && r.lobeRoughness.every(finite)) out.lobeRoughness = [clamp(r.lobeRoughness[0] as number, 0.1, 4), clamp(r.lobeRoughness[1] as number, 0.1, 4)];
  num("microScale", 1, 4096);
  num("microStrength", 0, 1);
  num("cavity", 0, 1);
  num("irisRadius", 0.01, 0.5);
  num("irisDepth", 0, 0.5);
  num("corneaIor", 1, 2);
  num("limbus", 0, 0.2);
  num("caustic", 0, 4);
  num("shift", -1, 1);
  num("secondaryShift", -1, 1);
  num("scatter", 0, 1);
  if (Array.isArray(r.opening) && r.opening.length === 3 && r.opening.every(finite)) out.opening = [r.opening[0] as number, r.opening[1] as number, r.opening[2] as number];
  num("depth", 1e-4, 10);
  num("occlusion", 0, 1);
  num("open", 0, 1);
  return out;
}

/** A material's character shading with every default filled in, or null for none. */
export function resolveCharacter(material: Pick<MeshMaterial, "character">): ResolvedCharacter | null {
  const c = readCharacterShading(material.character);
  return c ? { ...CHARACTER_DEFAULTS, ...c } : null;
}

/** The shader's code for a kind: 1 skin, 2 eye, 3 hair, 4 mouth (0 none). */
export function characterKindCode(kind: CharacterKind | undefined): number {
  return kind ? CHARACTER_KINDS.indexOf(kind) + 1 : 0;
}

// --- Skin ---------------------------------------------------------------------

/** GGX's distribution for a perceptual roughness. */
export function ggxD(ndh: number, rough: number): number {
  const a2 = rough ** 4;
  const d = ndh * ndh * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d + 1e-7);
}

/** Skin's distribution: the two lobes' GGX, the second's share `mix`. Roughness is clamped as the shader clamps it. */
export function dualLobeD(ndh: number, rough: number, lobes: readonly [number, number], mix: number): number {
  const r0 = clamp(rough * lobes[0], 0.045, 1);
  const r1 = clamp(rough * lobes[1], 0.045, 1);
  return ggxD(ndh, r0) * (1 - mix) + ggxD(ndh, r1) * mix;
}

/** The hash the micro-normal's noise is built on (the shader's). */
export function hash2(x: number, y: number): number {
  const f = (v: number) => v - Math.floor(v);
  return f(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}

/** Value noise in [0, 1) at a point, smoothly interpolated between lattice hashes. */
export function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** The micro-normal's tilt in tangent space (along U, along V): the noise's slope at a UV, scaled by its strength. */
export function microTilt(u: number, v: number, scale: number, strength: number): [number, number] {
  const e = 0.25;
  const x = u * scale;
  const y = v * scale;
  const du = valueNoise(x + e, y) - valueNoise(x - e, y);
  const dv = valueNoise(x, y + e) - valueNoise(x, y - e);
  return [-du * strength, -dv * strength];
}

/** What the specular keeps in a cavity: the occlusion map's value, by the cavity's strength. */
export function cavitySpecular(ao: number, cavity: number): number {
  return 1 - cavity * (1 - ao);
}

// --- Eyes ---------------------------------------------------------------------

/** How much of a point at `r` (UV units from the pupil) is iris: 1 inside, 0 outside, softened over the limbus. */
export function irisMask(r: number, radius: number, limbus: number): number {
  const w = Math.max(limbus, 1e-4);
  const t = clamp((radius - r) / w + 0.5, 0, 1);
  return t * t * (3 - 2 * t);
}

/** The limbus ring's darkening at `r`: 1 away from it, `1 − strength` at the iris's edge. */
export function limbusShade(r: number, radius: number, limbus: number, strength = 0.65): number {
  if (limbus <= 0) return 1;
  const t = clamp(1 - Math.abs(r - radius) / limbus, 0, 1);
  return 1 - strength * t * t;
}

/** Refract a unit direction `i` through a surface of normal `n` (both world), `eta` = n₁/n₂; null for total internal reflection. */
export function refractDirection(i: readonly number[], n: readonly number[], eta: number): [number, number, number] | null {
  const d = n[0]! * i[0]! + n[1]! * i[1]! + n[2]! * i[2]!;
  const k = 1 - eta * eta * (1 - d * d);
  if (k < 0) return null;
  const s = eta * d + Math.sqrt(k);
  return [eta * i[0]! - s * n[0]!, eta * i[1]! - s * n[1]!, eta * i[2]! - s * n[2]!];
}

/**
 * Where the iris is seen through the cornea: the UV offset from the point on
 * the cornea. The view's direction into the eye, refracted, travels to the
 * iris plane `depth` behind (depth in UV units, and the tangent frame's axes
 * along U and V); `forward` is the eye's axis. All vectors world, unit.
 */
export function irisParallax(
  view: readonly number[],
  normal: readonly number[],
  tangentU: readonly number[],
  tangentV: readonly number[],
  forward: readonly number[],
  depth: number,
  ior: number,
): [number, number] {
  const into = refractDirection([-view[0]!, -view[1]!, -view[2]!], normal, 1 / ior) ?? [-forward[0]!, -forward[1]!, -forward[2]!];
  const down = Math.max(0.2, -(into[0] * forward[0]! + into[1] * forward[1]! + into[2] * forward[2]!));
  const t = depth / down;
  return [t * (into[0] * tangentU[0]! + into[1] * tangentU[1]! + into[2] * tangentU[2]!), t * (into[0] * tangentV[0]! + into[1] * tangentV[1]! + into[2] * tangentV[2]!)];
}

/**
 * The iris's light from a light at `toLight`: the light refracted through the
 * cornea onto the iris's concave plane (facing `forward`), brightened on the
 * side away from the light, where the cornea focuses it (the caustic).
 */
export function irisLight(toLight: readonly number[], normal: readonly number[], forward: readonly number[], offsetFromPupil: readonly number[], caustic: number, ior: number): number {
  const into = refractDirection([-toLight[0]!, -toLight[1]!, -toLight[2]!], normal, 1 / ior);
  if (!into) return 0;
  const ndl = Math.max(0, -(into[0] * forward[0]! + into[1] * forward[1]! + into[2] * forward[2]!));
  // The point's offset from the pupil along the light's sideways travel: the far side gathers it.
  const side = into[0] * offsetFromPupil[0]! + into[1] * offsetFromPupil[1]! + into[2] * offsetFromPupil[2]!;
  return ndl * (1 + caustic * Math.max(0, side) * 4);
}

// --- Hair ---------------------------------------------------------------------

/** Kajiya-Kay's specular along a strand of tangent `t`, for a half vector `h` and an exponent, energy-normalised. */
export function kajiyaKay(tdh: number, exponent: number): number {
  const sin = Math.sqrt(Math.max(0, 1 - tdh * tdh));
  return ((exponent + 2) / (2 * Math.PI)) * sin ** exponent;
}

/** A strand tangent shifted along the normal (Scheuermann), normalised. */
export function shiftTangent(t: readonly number[], n: readonly number[], shift: number): [number, number, number] {
  const x = t[0]! + shift * n[0]!;
  const y = t[1]! + shift * n[1]!;
  const z = t[2]! + shift * n[2]!;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** The specular exponent of a hair lobe for a roughness (the secondary takes a quarter of it). */
export function hairExponent(rough: number): number {
  const a = Math.max(0.045, rough) ** 2;
  return Math.max(2, 2 / (a * a) - 2);
}

/** The forward scatter through hair from a light behind it (TT): toward the viewer, by its strength. */
export function hairScatter(toLight: readonly number[], view: readonly number[], scatter: number): number {
  const d = -(toLight[0]! * view[0]! + toLight[1]! * view[1]! + toLight[2]! * view[2]!);
  return scatter * Math.max(0, d) ** 4;
}

/**
 * Whether a hair texel of `alpha` survives the dither at a pixel and frame:
 * kept when alpha passes the pixel's threshold, which (Interleaved Gradient
 * Noise, shifted each frame) TAA averages over frames into the fraction.
 */
export function ditherKeeps(alpha: number, x: number, y: number, frame: number): boolean {
  const f = (v: number) => v - Math.floor(v);
  const shift = (frame % 64) * 5.588238;
  const threshold = f(52.9829189 * f((x + shift) * 0.06711056 + (y + shift) * 0.00583715));
  return alpha > threshold;
}

/**
 * A primitive's triangles back to front from an eye (both in the mesh's
 * space), by their centroids' distance: what a blended hair card draws in, so
 * the far strands go down first.
 */
export function sortTrianglesBackToFront(positions: Float32Array, indices: Uint32Array, eye: readonly number[]): Uint32Array {
  const count = Math.floor(indices.length / 3);
  const depth = new Float64Array(count);
  const order = new Uint32Array(count);
  for (let t = 0; t < count; t += 1) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k]! * 3;
      x += positions[v]!;
      y += positions[v + 1]!;
      z += positions[v + 2]!;
    }
    depth[t] = (x / 3 - eye[0]!) ** 2 + (y / 3 - eye[1]!) ** 2 + (z / 3 - eye[2]!) ** 2;
    order[t] = t;
  }
  order.sort((a, b) => depth[b]! - depth[a]!);
  const out = new Uint32Array(count * 3);
  for (let i = 0; i < count; i += 1) out.set(indices.subarray(order[i]! * 3, order[i]! * 3 + 3), i * 3);
  return out;
}

// --- Mouth --------------------------------------------------------------------

/** The light a point `distance` (m) from the mouth's opening keeps: darker deeper, less dark the wider it opens. */
export function mouthOcclusion(distance: number, depth: number, occlusion: number, open: number): number {
  const t = clamp(distance / Math.max(depth, 1e-4), 0, 1);
  const s = t * t * (3 - 2 * t);
  return 1 - occlusion * (1 - 0.6 * open) * s;
}
