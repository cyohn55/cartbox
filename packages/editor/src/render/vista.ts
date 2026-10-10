/**
 * Distant vistas (HALO_INFINITE_STYLE_ROADMAP.md I7): far terrain beyond the
 * play space, drawn once when the scene loads into the sky panorama — a
 * panoramic impostor — instead of as geometry every frame. From a point in the
 * play space the vista is rendered through six 90° cube faces by the software
 * rasteriser (lit by the scene's rig, its shadow and fog), resampled to the
 * panorama's equirectangular layout with its coverage, and laid over the sky
 * with aerial haze: the farther a pixel, the more of the sky behind it shows
 * through, so the range fades into the sky rather than ending against it.
 *
 * Because it lives in the panorama it costs nothing per frame, shows on every
 * backend (the backdrop is painted before the scene), and metals reflect it.
 * What it can't do is parallax: it is right from where it was baked, and good
 * enough anywhere the play space is small next to the vista's distance.
 */

import {
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type DecodedTexture,
  type Mat4,
  type MeshSceneInstance,
  type RenderMeshSceneOptions,
} from "./meshRasterizer";
import { PANORAMA_FACES } from "./probeBake";

/** One far terrain (and anything set on it, as its trees): what it draws and how hazy it reads. */
export interface VistaLayer {
  readonly instances: readonly MeshSceneInstance[];
  /** Share of the sky's colour a pixel {@link VISTA_HAZE_DISTANCE} units out takes, 0..{@link MAX_VISTA_HAZE}. */
  readonly haze: number;
}

/** The light a vista is baked under: the scene's rig as the frame draws it. */
export type VistaShading = Pick<RenderMeshSceneOptions, "lightDirection" | "ambient" | "environment" | "lights" | "shadow" | "tonemap" | "fog">;

/** The distance at which a vista's `haze` is the share of the sky that shows. */
export const VISTA_HAZE_DISTANCE = 1000;
/** Haze stops short of 1, so even the farthest ridge keeps a silhouette. */
export const MAX_VISTA_HAZE = 0.95;
/** The cube faces' clip range (world units): vistas are far, and far out. */
export const VISTA_NEAR = 1;
export const VISTA_FAR = 50000;

/** How much of the sky shows through a vista pixel `distance` units out. */
export function vistaHaze(haze: number, distance: number): number {
  const h = Math.max(0, Math.min(MAX_VISTA_HAZE, haze));
  return 1 - Math.pow(1 - h, Math.max(0, distance) / VISTA_HAZE_DISTANCE);
}

/** Cube face edge for a panorama `width` texels round: four faces span the horizon. */
export function vistaFaceSize(width: number): number {
  return Math.max(8, Math.round(width / 4));
}

/** The world box round every vista's geometry (for its shadow map), or null when empty. */
export function vistaBounds(layers: readonly VistaLayer[]): { center: [number, number, number]; radius: number } | null {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const layer of layers) {
    for (const { mesh, model: m } of layer.instances) {
      for (const p of mesh.primitives) {
        const v = p.positions;
        for (let i = 0; i < v.length; i += 3) {
          const x = m[0]! * v[i]! + m[4]! * v[i + 1]! + m[8]! * v[i + 2]! + m[12]!;
          const y = m[1]! * v[i]! + m[5]! * v[i + 1]! + m[9]! * v[i + 2]! + m[13]!;
          const z = m[2]! * v[i]! + m[6]! * v[i + 1]! + m[10]! * v[i + 2]! + m[14]!;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 };
}

/** View distance from the faces' depth buffer, which holds NDC z of their projection. */
function eyeDistance(zNdc: number): number {
  return (2 * VISTA_NEAR * VISTA_FAR) / (VISTA_FAR + VISTA_NEAR - zNdc * (VISTA_FAR - VISTA_NEAR));
}

interface Face {
  readonly out: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly view: Mat4;
}

/** An instance's world bounding sphere: centre and radius. */
function boundingSphere({ mesh, model: m }: MeshSceneInstance): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of mesh.primitives) {
    const v = p.positions;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i]! < x0) x0 = v[i]!; if (v[i]! > x1) x1 = v[i]!;
      if (v[i + 1]! < y0) y0 = v[i + 1]!; if (v[i + 1]! > y1) y1 = v[i + 1]!;
      if (v[i + 2]! < z0) z0 = v[i + 2]!; if (v[i + 2]! > z1) z1 = v[i + 2]!;
    }
  }
  if (!Number.isFinite(x0)) return [0, 0, 0, -1];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  // The model's largest axis scale bounds how far it stretches the local radius.
  const scale = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
  return [
    m[0]! * cx + m[4]! * cy + m[8]! * cz + m[12]!,
    m[1]! * cx + m[5]! * cy + m[9]! * cz + m[13]!,
    m[2]! * cx + m[6]! * cy + m[10]! * cz + m[14]!,
    (Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2) * scale,
  ];
}

/**
 * Whether a sphere (relative to the eye) reaches into a 90° face: inside all
 * four of the pyramid's side planes (forward ± right, forward ± up).
 */
function inFace(s: readonly number[], forward: readonly number[], up: readonly number[]): boolean {
  const right = [forward[1]! * up[2]! - forward[2]! * up[1]!, forward[2]! * up[0]! - forward[0]! * up[2]!, forward[0]! * up[1]! - forward[1]! * up[0]!];
  const f = s[0]! * forward[0]! + s[1]! * forward[1]! + s[2]! * forward[2]!;
  const r = s[0]! * right[0]! + s[1]! * right[1]! + s[2]! * right[2]!;
  const u = s[0]! * up[0]! + s[1]! * up[1]! + s[2]! * up[2]!;
  const reach = s[3]! * Math.SQRT2;
  return f - r >= -reach && f + r >= -reach && f - u >= -reach && f + u >= -reach;
}

/** One vista's six faces, rendered from `eye` over a transparent clear; each draws only what reaches into it. */
function renderFaces(instances: readonly MeshSceneInstance[], eye: readonly [number, number, number], shading: VistaShading, size: number): Face[] {
  const projection = projectionMatrix(Math.PI / 2, 1, VISTA_NEAR, VISTA_FAR);
  const spheres = instances.map((instance) => {
    const [x, y, z, r] = boundingSphere(instance);
    return [x - eye[0], y - eye[1], z - eye[2], r] as const;
  });
  return PANORAMA_FACES.map(({ forward, up }) => {
    const out = new Uint8ClampedArray(size * size * 4);
    const depth = new Float32Array(size * size).fill(Infinity);
    const view = viewMatrix(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], up);
    // Nearest first, so the depth test turns away what lies behind before it is shaded.
    const seen = instances
      .map((instance, k) => ({ instance, s: spheres[k]! }))
      .filter(({ s }) => s[3] >= 0 && inFace(s, forward, up))
      .sort((a, b) => Math.hypot(a.s[0], a.s[1], a.s[2]) - a.s[3] - (Math.hypot(b.s[0], b.s[1], b.s[2]) - b.s[3]))
      .map(({ instance }) => instance);
    if (seen.length > 0) renderMeshScene(seen, { ...shading, width: size, height: size, out, depth, view, projection, background: [0, 0, 0, 0] });
    return { out, depth, view };
  });
}

/** A panorama's colour along a direction (bilinear, wrapping round), into `rgb`. */
function samplePanorama(map: DecodedTexture, dx: number, dy: number, dz: number, rgb: number[]): void {
  const u = (Math.atan2(dz, dx) / (2 * Math.PI) + 0.5) * map.width - 0.5;
  const v = Math.min(map.height - 1, Math.max(0, (Math.acos(Math.max(-1, Math.min(1, dy))) / Math.PI) * map.height - 0.5));
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const tx = u - x0;
  const ty = v - y0;
  rgb[0] = rgb[1] = rgb[2] = 0;
  for (let j = 0; j < 4; j += 1) {
    const x = (((x0 + (j & 1)) % map.width) + map.width) % map.width;
    const y = Math.min(map.height - 1, y0 + (j >> 1));
    const w = (j & 1 ? tx : 1 - tx) * (j >> 1 ? ty : 1 - ty);
    const o = (y * map.width + x) * 4;
    rgb[0] += map.data[o]! * w;
    rgb[1] += map.data[o + 1]! * w;
    rgb[2] += map.data[o + 2]! * w;
  }
}

/**
 * The sky panorama with the vistas laid over it, seen from `eye`: a new
 * texture (the sky passed in is left alone). Where vistas overlap, the nearer
 * pixel wins. With no layers, the sky itself comes back.
 *
 * Haze fades a vista toward `air` — the sky without what stands in it (a
 * ring, a planet), at any size — so a ring behind a range doesn't ghost
 * through the haze in front of it; absent, toward the sky behind the pixel.
 *
 * Over a sun layer (`sunLayer`: the sky baked without its glow, alpha the
 * share of the glow that shows), a vista hides the glow as it covers the sky,
 * all but what its haze lets through.
 */
export function bakeVistas(
  sky: DecodedTexture,
  layers: readonly VistaLayer[],
  eye: readonly [number, number, number],
  shading: VistaShading = {},
  face = vistaFaceSize(sky.width),
  air: DecodedTexture | null = null,
  sunLayer = false,
): DecodedTexture {
  const drawn = layers.filter((l) => l.instances.length > 0);
  if (drawn.length === 0) return sky;
  const rendered = drawn.map((l) => renderFaces(l.instances, eye, shading, face));
  const { width: w, height: h } = sky;
  const data = new Uint8ClampedArray(sky.data);
  const rgb = [0, 0, 0];
  const behind = [0, 0, 0];
  for (let y = 0; y < h; y += 1) {
    const theta = ((y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x += 1) {
      // The panorama's direction for this texel (the sky bake's own mapping).
      const phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const dx = Math.sin(theta) * Math.cos(phi);
      const dy = Math.cos(theta);
      const dz = Math.sin(theta) * Math.sin(phi);
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      const f = ax >= ay && ax >= az ? (dx > 0 ? 0 : 1) : ay >= az ? (dy > 0 ? 2 : 3) : dz > 0 ? 4 : 5;
      let best = -1;
      let bestDistance = Infinity;
      let bestAlpha = 0;
      let br = 0, bg = 0, bb = 0;
      for (let k = 0; k < rendered.length; k += 1) {
        const { out, depth, view } = rendered[k]![f]!;
        // Into the face camera's view space (it looks down −Z), then to its texels.
        const vx = view[0]! * dx + view[4]! * dy + view[8]! * dz;
        const vy = view[1]! * dx + view[5]! * dy + view[9]! * dz;
        const cos = -(view[2]! * dx + view[6]! * dy + view[10]! * dz); // to the face's axis
        const fx = ((vx / cos) * 0.5 + 0.5) * face - 0.5;
        const fy = (1 - ((vy / cos) * 0.5 + 0.5)) * face - 0.5;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        // Bilinear over the covered texels only: their share is the coverage,
        // their weighted mean the colour and distance (soft, unfringed edges).
        let alpha = 0;
        let along = 0;
        rgb[0] = rgb[1] = rgb[2] = 0;
        for (let j = 0; j < 4; j += 1) {
          const sx = Math.min(face - 1, Math.max(0, ix + (j & 1)));
          const sy = Math.min(face - 1, Math.max(0, iy + (j >> 1)));
          const z = depth[sy * face + sx]!;
          if (z === Infinity) continue;
          const d = eyeDistance(z);
          const wgt = (j & 1 ? tx : 1 - tx) * (j >> 1 ? ty : 1 - ty);
          const o = (sy * face + sx) * 4;
          alpha += wgt;
          along += d * wgt;
          rgb[0] += out[o]! * wgt;
          rgb[1] += out[o + 1]! * wgt;
          rgb[2] += out[o + 2]! * wgt;
        }
        if (alpha <= 1e-6) continue;
        // Distance is along the face's axis; the haze wants it along the ray.
        const distance = along / alpha / cos;
        if (distance >= bestDistance) continue;
        best = k;
        bestDistance = distance;
        bestAlpha = Math.min(1, alpha);
        br = rgb[0] / alpha;
        bg = rgb[1] / alpha;
        bb = rgb[2] / alpha;
      }
      if (best < 0) continue;
      const o = (y * w + x) * 4;
      const sr = data[o]!, sg = data[o + 1]!, sb = data[o + 2]!;
      if (air) samplePanorama(air, dx, dy, dz, behind);
      else [behind[0], behind[1], behind[2]] = [sr, sg, sb];
      const hz = vistaHaze(drawn[best]!.haze, bestDistance);
      const r = br + (behind[0]! - br) * hz;
      const g = bg + (behind[1]! - bg) * hz;
      const b = bb + (behind[2]! - bb) * hz;
      data[o] = Math.round(sr + (r - sr) * bestAlpha);
      data[o + 1] = Math.round(sg + (g - sg) * bestAlpha);
      data[o + 2] = Math.round(sb + (b - sb) * bestAlpha);
      if (sunLayer) data[o + 3] = Math.round(data[o + 3]! * (1 - bestAlpha + bestAlpha * hz));
    }
  }
  return { width: w, height: h, data };
}
