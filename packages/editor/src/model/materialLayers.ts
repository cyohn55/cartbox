/**
 * Layered and directional surfaces on a PBR material
 * (HALO_INFINITE_STYLE_ROADMAP.md I4): a clearcoat (a thin glossy lacquer over
 * the base, for armour paint and visors), anisotropic highlights (brushed metal,
 * whose highlight stretches across the grain), and a relief map that gives
 * panel seams depth by parallax occlusion and feeds the material graph's wear
 * masks with its curvature.
 *
 * The fields live on {@link MeshMaterial}; this module holds their defaults,
 * their defensive reading, the per-draw resolution every renderer shares, and
 * the parallax march and anisotropic distribution written once here so the
 * software rasteriser and both GPU shaders agree term for term.
 *
 * The relief map packs two channels: R = height (white is the top surface,
 * black the deepest), G = curvature around mid-grey (lighter is a convex edge,
 * darker a cavity). A baker writes it from a mesh (I15); {@link builtinPanelRelief}
 * is a ready-made one of bevelled panels and seams.
 */

import type { EncodedImage, MeshMaterial } from "./MeshAsset";
import { encodeRgbaPng } from "./png";

/** Height layers the parallax ray march steps through. Fixed, so every backend stops at the same layer. */
export const PARALLAX_STEPS = 16;
/** The deepest a relief may read, in world units. */
export const PARALLAX_MAX_DEPTH = 0.25;
/**
 * The smallest N·V the parallax offset divides by: at grazing angles the true
 * offset runs to infinity and the relief smears, so it is held at this angle's.
 */
export const PARALLAX_MIN_NDV = 0.25;
/** The clearcoat's roughness when a material doesn't say (a fresh lacquer). */
export const DEFAULT_CLEARCOAT_ROUGHNESS = 0.05;
/** The clearcoat's reflectance at normal incidence (an IOR 1.5 lacquer, as glTF's KHR_materials_clearcoat). */
export const CLEARCOAT_F0 = 0.04;
/** The narrowest an anisotropic lobe may get along either axis (α), so the distribution stays finite. */
export const ANISOTROPY_MIN_ALPHA = 0.002;

type MaterialLayers = Pick<MeshMaterial, "clearcoat" | "clearcoatRoughness" | "anisotropy" | "anisotropyRotation" | "parallaxDepth">;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Read a stored material's layer fields, clamping each and dropping anything malformed or neutral. */
export function readMaterialLayers(raw: Record<string, unknown> | object): MaterialLayers {
  const r = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof MaterialLayers]: MaterialLayers[K] } = {};
  if (finite(r.clearcoat) && r.clearcoat > 0) out.clearcoat = clamp(r.clearcoat, 0, 1);
  if (finite(r.clearcoatRoughness)) out.clearcoatRoughness = clamp(r.clearcoatRoughness, 0, 1);
  if (finite(r.anisotropy) && r.anisotropy !== 0) out.anisotropy = clamp(r.anisotropy, -1, 1);
  if (finite(r.anisotropyRotation)) out.anisotropyRotation = clamp(r.anisotropyRotation, -2 * Math.PI, 2 * Math.PI);
  if (finite(r.parallaxDepth) && r.parallaxDepth > 0) out.parallaxDepth = Math.min(r.parallaxDepth, PARALLAX_MAX_DEPTH);
  return out;
}

/** The layer fields in stored form (only those a material sets). */
export function writeMaterialLayers(material: MeshMaterial): Record<string, unknown> {
  return { ...readMaterialLayers(material) };
}

/** Whether a material asks for any layer, which (like a graph) puts it on the PBR path. */
export function materialHasLayers(material: Pick<MeshMaterial, "clearcoat" | "anisotropy" | "parallaxDepth">): boolean {
  return (material.clearcoat ?? 0) > 0 || (material.anisotropy ?? 0) !== 0 || (material.parallaxDepth ?? 0) > 0;
}

/** A material's layers as a draw applies them. */
export interface ResolvedLayers {
  /** The coat's strength, 0..1 (0 = no coat). */
  readonly clearcoat: number;
  /** The coat's roughness, clamped as the base roughness is. */
  readonly clearcoatRoughness: number;
  /** −1..1: positive stretches highlights across the tangent, negative across the bitangent; 0 = isotropic. */
  readonly anisotropy: number;
  /** The tangent's turn about the normal (radians, from the U direction toward V), as its cosine and sine. */
  readonly anisotropyCos: number;
  readonly anisotropySin: number;
  /** World depth of the relief's deepest point; 0 when the draw has no relief map (or asks for none). */
  readonly parallaxDepth: number;
  /** A relief map is bound, so its curvature reaches the graph. */
  readonly relief: boolean;
}

/** No layers: what a material without any gets. */
export const NO_LAYERS: ResolvedLayers = { clearcoat: 0, clearcoatRoughness: DEFAULT_CLEARCOAT_ROUGHNESS, anisotropy: 0, anisotropyCos: 1, anisotropySin: 0, parallaxDepth: 0, relief: false };

/** Resolve a material's layers, given whether its relief map is bound. */
export function resolveLayers(material: MeshMaterial, hasRelief: boolean): ResolvedLayers {
  const rotation = material.anisotropyRotation ?? 0;
  return {
    clearcoat: clamp(material.clearcoat ?? 0, 0, 1),
    clearcoatRoughness: clamp(material.clearcoatRoughness ?? DEFAULT_CLEARCOAT_ROUGHNESS, 0.045, 1),
    anisotropy: clamp(material.anisotropy ?? 0, -1, 1),
    anisotropyCos: Math.cos(rotation),
    anisotropySin: Math.sin(rotation),
    parallaxDepth: hasRelief ? clamp(material.parallaxDepth ?? 0, 0, PARALLAX_MAX_DEPTH) : 0,
    relief: hasRelief,
  };
}

/**
 * The anisotropic GGX distribution (Burley's, as Filament writes it): the
 * lobe's width α = roughness² stretched to `α(1 + a)` along the tangent and
 * `α(1 − a)` along the bitangent. `toh`, `boh`, `ndh` are the half vector
 * against the tangent, bitangent and normal. At a = 0 it is the isotropic
 * distribution every renderer already uses.
 */
export function anisotropicD(rough: number, aniso: number, toh: number, boh: number, ndh: number): number {
  const alpha = rough * rough;
  const at = Math.max(alpha * (1 + aniso), ANISOTROPY_MIN_ALPHA);
  const ab = Math.max(alpha * (1 - aniso), ANISOTROPY_MIN_ALPHA);
  const a2 = at * ab;
  const dx = ab * toh;
  const dy = at * boh;
  const dz = a2 * ndh;
  const b2 = a2 / (dx * dx + dy * dy + dz * dz + 1e-12);
  return (a2 * b2 * b2) / Math.PI;
}

/**
 * Parallax occlusion: where the view ray, entering the surface at `(u, v)`,
 * meets the relief. `du`, `dv` are how far the UVs move per world unit of depth
 * along the ray (see {@link parallaxRate}); `height(u, v)` reads the relief's
 * height, 0..1. Steps down {@link PARALLAX_STEPS} layers until the ray is below
 * the surface, then interpolates between the last two — the WGSL and GLSL
 * marches are this loop line for line.
 */
export function parallaxUv(u: number, v: number, du: number, dv: number, depth: number, height: (u: number, v: number) => number): [number, number] {
  const layer = 1 / PARALLAX_STEPS;
  const su = du * depth * layer;
  const sv = dv * depth * layer;
  let cu = u;
  let cv = v;
  let cur = 0;
  let below = 1 - height(cu, cv);
  for (let i = 0; i < PARALLAX_STEPS && cur < below; i += 1) {
    cu += su;
    cv += sv;
    cur += layer;
    below = 1 - height(cu, cv);
  }
  const after = below - cur;
  const before = 1 - height(cu - su, cv - sv) - (cur - layer);
  const span = after - before;
  const w = Math.abs(span) > 1e-6 ? after / span : 0;
  return [cu - su * w, cv - sv * w];
}

/**
 * How far the UVs move per world unit of depth along the view ray: with the
 * world gradients of u and v (`gu`, `gv`), the unit normal `n` and the
 * direction toward the viewer `view`, stepping a depth `d` into the surface
 * walks the ray `d / (n·v)`, which moves u by `−(∇u·v) d / (n·v)`.
 */
export function parallaxRate(
  gu: readonly [number, number, number],
  gv: readonly [number, number, number],
  n: readonly [number, number, number],
  view: readonly [number, number, number],
): [number, number] {
  const ndv = Math.max(PARALLAX_MIN_NDV, n[0] * view[0] + n[1] * view[1] + n[2] * view[2]);
  return [-(gu[0] * view[0] + gu[1] * view[1] + gu[2] * view[2]) / ndv, -(gv[0] * view[0] + gv[1] * view[1] + gv[2] * view[2]) / ndv];
}

/**
 * The world gradients of a triangle's u and v: the in-plane vectors whose dot
 * with each edge is that edge's change in u (and v). They are exact for the
 * triangle's plane and blind to which way its normal faces, which is what a
 * two-sided surface needs. Null for degenerate UVs or geometry.
 */
export function uvGradients(
  e1: readonly [number, number, number],
  e2: readonly [number, number, number],
  du1: number,
  dv1: number,
  du2: number,
  dv2: number,
): { gu: [number, number, number]; gv: [number, number, number] } | null {
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const det = nx * nx + ny * ny + nz * nz; // n·(e1×e2) with n = e1×e2
  if (det < 1e-20 || Math.abs(du1 * dv2 - du2 * dv1) < 1e-12) return null;
  // e2 × n and n × e1, each scaled by 1/det.
  const ax = (e2[1] * nz - e2[2] * ny) / det;
  const ay = (e2[2] * nx - e2[0] * nz) / det;
  const az = (e2[0] * ny - e2[1] * nx) / det;
  const bx = (ny * e1[2] - nz * e1[1]) / det;
  const by = (nz * e1[0] - nx * e1[2]) / det;
  const bz = (nx * e1[1] - ny * e1[0]) / det;
  return {
    gu: [du1 * ax + du2 * bx, du1 * ay + du2 * by, du1 * az + du2 * bz],
    gv: [dv1 * ax + dv2 * bx, dv1 * ay + dv2 * by, dv1 * az + dv2 * bz],
  };
}

/** The relief map's curvature at a texel's green byte, −1 (cavity) .. 1 (convex edge). */
export function curvatureOf(green: number): number {
  return (green / 255) * 2 - 1;
}

let panels: EncodedImage | null = null;

/** Edge length of the built-in relief tile, in texels. */
export const PANEL_RELIEF_SIZE = 64;

/**
 * A built-in relief map: a 64² tile of four bevelled panels with seams between
 * them (and round the tile, so it wraps) and a rivet near each corner. Height
 * in R; the curvature in G is the height's negated Laplacian, softened, so the
 * panels' bevelled rims read as edges and the seams' floors as cavities —
 * what a curvature bake of the same geometry gives. One shared image object,
 * so however many materials use it a mesh stores it once.
 */
export function builtinPanelRelief(): EncodedImage {
  if (!panels) panels = { mime: "image/png", bytes: encodeRgbaPng(panelReliefRgba(), PANEL_RELIEF_SIZE, PANEL_RELIEF_SIZE, { compress: true }) };
  return panels;
}

/** The built-in relief tile's texels (RGBA, {@link PANEL_RELIEF_SIZE}²): see {@link builtinPanelRelief}. */
export function panelReliefRgba(): Uint8ClampedArray {
  const size = PANEL_RELIEF_SIZE;
  const half = size / 2;
  const seam = 1.5; // half the seam's flat floor, texels
  const bevel = 3; // the bevel's run from floor to face, texels
  const face = 0.8; // the panels' face, below the rivets' tops
  const height = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Distance to the nearest seam line (the tile's edges and its midlines).
      const sx = Math.min(x + 0.5, Math.abs(x + 0.5 - half), size - (x + 0.5));
      const sy = Math.min(y + 0.5, Math.abs(y + 0.5 - half), size - (y + 0.5));
      const d = Math.min(sx, sy);
      let h = d <= seam ? 0 : d >= seam + bevel ? face : (face * (d - seam)) / bevel;
      // A rivet: a low dome 6 texels in from each panel corner, standing proud of the face.
      const px = (x + 0.5) % half;
      const py = (y + 0.5) % half;
      for (const [cx, cy] of [[6, 6], [half - 6, 6], [6, half - 6], [half - 6, half - 6]] as const) {
        const r = Math.hypot(px - cx, py - cy) / 2;
        if (r < 1) h = Math.max(h, face + (1 - face) * (1 - r * r));
      }
      height[y * size + x] = h;
    }
  }
  return reliefFromHeight(height, size, size, 6);
}

/**
 * A relief map from a tileable height field (`width × height`, 0..1, wrapping
 * at its edges): R = the height, G = its curvature, the negated Laplacian
 * softened by a 3×3 blur and scaled by `gain` — convex rims light, cavities
 * dark, what a curvature bake of the same surface gives.
 */
export function reliefFromHeight(field: ArrayLike<number>, width: number, height: number, gain: number): Uint8ClampedArray {
  const at = (f: ArrayLike<number>, x: number, y: number) => f[((y + height) % height) * width + ((x + width) % width)]!;
  const lap = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      lap[y * width + x] = 4 * at(field, x, y) - at(field, x - 1, y) - at(field, x + 1, y) - at(field, x, y - 1) - at(field, x, y + 1);
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // A 3×3 box blur of the Laplacian spreads each rim over a couple of texels.
      let c = 0;
      for (let j = -1; j <= 1; j += 1) for (let i = -1; i <= 1; i += 1) c += at(lap, x + i, y + j);
      const curvature = clamp((c / 9) * gain, -1, 1);
      const o = (y * width + x) * 4;
      rgba[o] = Math.round(clamp(field[y * width + x]!, 0, 1) * 255);
      rgba[o + 1] = Math.round(127.5 + curvature * 127.5);
      rgba[o + 2] = 0;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}
