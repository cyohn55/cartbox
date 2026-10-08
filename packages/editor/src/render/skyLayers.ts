/**
 * An imported sky (HALO_INFINITE_STYLE_ROADMAP.md I6): what sits on top of, or
 * stands in for, the procedural dome in skyDome.ts.
 *
 * - **A panorama** — a painted or photographed equirectangular image (PNG,
 *   JPEG, or a Radiance `.hdr`) baked in place of the procedural gradient,
 *   sun, clouds and mountains. Like the procedural dome it is both the
 *   backdrop and the image-based light, so metals reflect it.
 * - **Sky objects at infinity** — a ring arching across the sky, a planet —
 *   baked into the panorama (in front of the sky, behind its clouds and
 *   mountains), so they show in reflections too.
 * - **Cloud layers** that drift: a tileable density map per layer on a plane
 *   overhead, composited over the backdrop every frame as the wind moves it
 *   (and baked once, at rest, into the reflections).
 *
 * Everything here is pure, deterministic and DOM-free.
 */

import type { DecodedTexture } from "./meshRasterizer";

type Rgb = readonly [number, number, number];
type Vec3 = readonly [number, number, number];

/** A ring world's band across the sky: the great circle about `axis`, `width` degrees wide. */
export interface SkyRing {
  readonly kind: "ring";
  /** The ring's axis (the normal of its plane); the band is the great circle perpendicular to it. */
  readonly axis: Vec3;
  /** The band's angular width, degrees. */
  readonly width: number;
  /** The landscape on its inner face, 0..1. */
  readonly color: Rgb;
  /** Its two rim walls, 0..1. */
  readonly edge: Rgb;
  /** How much the atmosphere washes it toward the horizon colour near the horizon, 0..1. */
  readonly haze: number;
  readonly seed: number;
}

/** A planet (or moon) hanging in the sky, lit by the sun. */
export interface SkyPlanet {
  readonly kind: "planet";
  /** World direction toward its centre. */
  readonly direction: Vec3;
  /** Its angular radius, degrees. */
  readonly radius: number;
  readonly color: Rgb;
  /** Its atmosphere's rim glow, 0..1. */
  readonly atmosphere: Rgb;
  readonly seed: number;
}

export type SkyObject = SkyRing | SkyPlanet;

/** A drifting cloud layer on a plane overhead. */
export interface SkyCloudLayer {
  /** How much of the sky it covers, 0..1. */
  readonly cover: number;
  /** Cloud cells per unit of the plane: higher is smaller, busier cloud. */
  readonly scale: number;
  /** How fast it drifts, plane units per second, along world x and z. */
  readonly wind: readonly [number, number];
  readonly color: Rgb;
  /** Its strongest opacity, 0..1. */
  readonly opacity: number;
  readonly seed: number;
}

/** At most this many objects and cloud layers in a sky. */
export const MAX_SKY_OBJECTS = 4;
export const MAX_CLOUD_LAYERS = 3;
/** Edge length of a baked cloud layer's tile, in texels. */
export const CLOUD_TILE = 256;

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const normalize = (v: Vec3): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Value noise with an integer period on both axes (so a tile of it wraps seamlessly). */
function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (i: number) => ((i % period) + period) % period;
  const a = hash(w(xi), w(yi), seed);
  const b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed);
  const d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Plain fbm (not periodic), for the ring's landscape and the planet's bands. */
function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += periodicNoise(x * freq, y * freq, 1 << 20, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// --- Sky objects ------------------------------------------------------------

/** An object with its frame worked out once, ready to shade per direction. */
type PreparedObject =
  | { readonly kind: "ring"; readonly o: SkyRing; readonly n: Vec3; readonly e1: Vec3; readonly e2: Vec3; readonly half: number; readonly sunTheta: number; readonly sunLit: number }
  | { readonly kind: "planet"; readonly o: SkyPlanet; readonly c: Vec3; readonly r: number; readonly cosR: number; readonly u: Vec3; readonly v: Vec3 };

/** Work out each object's frame (and the sun's place in a ring's plane) once per bake. */
export function prepareSkyObjects(objects: readonly SkyObject[], sunDirection: Vec3): PreparedObject[] {
  const sun = normalize(sunDirection);
  return objects.slice(0, MAX_SKY_OBJECTS).map((o): PreparedObject => {
    if (o.kind === "ring") {
      const n = normalize(o.axis);
      const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const e1 = normalize(cross(helper, n));
      const e2 = cross(n, e1);
      // The sun's bearing in the ring's plane: the arc beneath it is lit, the far side in the ring's own night.
      const sunTheta = Math.atan2(dot(sun, e2), dot(sun, e1));
      const sunLit = Math.hypot(dot(sun, e1), dot(sun, e2));
      return { kind: "ring", o, n, e1, e2, half: (Math.max(0.05, o.width) * DEG) / 2, sunTheta, sunLit };
    }
    const r = Math.max(0.05, o.radius) * DEG * 1.12; // a little past the disc, for the atmosphere's halo
    const c = normalize(o.direction);
    const helper: Vec3 = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(helper, c));
    return { kind: "planet", o, c, r, cosR: Math.cos(r), u, v: cross(c, u) };
  });
}

/**
 * The sky objects' colour and coverage along a unit direction, nearest object
 * on top (planets in front of the ring, in the order given). `pixel` is the
 * angular size of a panorama texel (radians), which softens their edges.
 * `horizon` is the sky's horizon colour, which the ring hazes toward.
 */
export function skyObjectsAt(prepared: readonly PreparedObject[], d: Vec3, sun: Vec3, horizon: Rgb, pixel: number): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const over = (cr: number, cg: number, cb: number, ca: number) => {
    r = cr * ca + r * (1 - ca);
    g = cg * ca + g * (1 - ca);
    b = cb * ca + b * (1 - ca);
    a = ca + a * (1 - ca);
  };
  for (const p of prepared) {
    if (p.kind === "ring") {
      const lat = Math.asin(clamp(dot(d, p.n), -1, 1)); // signed angle off the ring's plane
      const across = Math.abs(lat) / p.half; // 0 on the centre line, 1 at a rim
      if (across > 1 + pixel / p.half) continue;
      const theta = Math.atan2(dot(d, p.e2), dot(d, p.e1));
      const o = p.o;
      // The inner face: bands of land, water and cloud running along the ring.
      const land = fbm(theta * 30, (lat / p.half) * 2.5, o.seed, 4);
      const water = smoothstep(0.42, 0.5, land);
      const cloud = smoothstep(0.62, 0.8, fbm(theta * 55 + 9, (lat / p.half) * 4, o.seed + 31, 3));
      let cr = o.color[0] * (0.55 + 0.6 * water);
      let cg = o.color[1] * (0.65 + 0.45 * water);
      let cb = o.color[2] * (0.8 + 0.25 * (1 - water));
      cr += (0.95 - cr) * cloud * 0.8;
      cg += (0.97 - cg) * cloud * 0.8;
      cb += (1 - cb) * cloud * 0.8;
      // The rim walls: a bright strip along each edge.
      const wall = smoothstep(0.82, 0.9, across);
      cr += (o.edge[0] - cr) * wall;
      cg += (o.edge[1] - cg) * wall;
      cb += (o.edge[2] - cb) * wall;
      // Day under the sun's bearing, the ring's own night opposite it.
      const day = 0.25 + 0.75 * smoothstep(-0.35, 0.5, Math.cos(theta - p.sunTheta) * (0.4 + 0.6 * p.sunLit));
      cr *= day;
      cg *= day;
      cb *= day;
      // Seen through the atmosphere: washed toward the horizon as it nears it.
      const elevation = Math.asin(clamp(d[1], -1, 1));
      const haze = clamp(o.haze * (1 - smoothstep(0, 0.6, elevation)) + 0.15, 0, 1);
      cr += (horizon[0] - cr) * haze;
      cg += (horizon[1] - cg) * haze;
      cb += (horizon[2] - cb) * haze;
      const cover = smoothstep(1 + pixel / p.half, 1 - pixel / p.half, across) * (1 - 0.2 * haze);
      over(cr, cg, cb, cover);
    } else {
      const cosC = dot(d, p.c);
      if (cosC < p.cosR) continue;
      const o = p.o;
      const disc = o.radius * DEG;
      const c = Math.acos(clamp(cosC, -1, 1));
      // The visible hemisphere: a normal leaning from the facing point out to the limb.
      const s = clamp(Math.sin(c) / Math.sin(disc), 0, 1);
      const rad = normalize([d[0] - p.c[0] * cosC, d[1] - p.c[1] * cosC, d[2] - p.c[2] * cosC]);
      const z = Math.sqrt(1 - s * s);
      const nrm: Vec3 = [rad[0] * s - p.c[0] * z, rad[1] * s - p.c[1] * z, rad[2] * s - p.c[2] * z];
      // A soft terminator, and a surface of dark seas and bright highlands (in the
      // disc's own coordinates, so the pattern stays put on the body).
      // Lit evenly up to a soft terminator: a moon shows almost no darkening toward its limb.
      const lit = smoothstep(-0.06, 0.12, dot(nrm, sun));
      const sx = s * dot(rad, p.u);
      const sy = s * dot(rad, p.v);
      const seas = smoothstep(0.45, 0.62, fbm(sx * 2.2 + 5, sy * 2.2 - 3, o.seed, 4));
      const grain = 0.9 + 0.2 * fbm(sx * 9, sy * 9, o.seed + 7, 2);
      const shade = (0.05 + 0.95 * lit) * (1 - 0.45 * seas) * grain;
      const rim = Math.pow(s, 6) * 0.35 * (0.2 + 0.8 * lit);
      const cr = o.color[0] * shade + o.atmosphere[0] * rim;
      const cg = o.color[1] * shade + o.atmosphere[1] * rim;
      const cb = o.color[2] * shade + o.atmosphere[2] * rim;
      if (c <= disc) {
        over(cr, cg, cb, smoothstep(disc + pixel, disc - pixel, c));
      } else {
        // The atmosphere's halo just past the limb, on the lit side.
        const halo = (1 - smoothstep(disc, p.r, c)) * 0.5 * Math.max(0.15, dot(rad, sun) * 0.5 + 0.5);
        over(o.atmosphere[0], o.atmosphere[1], o.atmosphere[2], halo);
      }
    }
  }
  return [r, g, b, a];
}

// --- Cloud layers -----------------------------------------------------------

/** A cloud layer baked for drawing: its density tile (0..1) and how it's drawn. */
export interface BakedCloudLayer {
  readonly layer: SkyCloudLayer;
  readonly density: Float32Array;
}

/** Bake a layer's tileable density map ({@link CLOUD_TILE}², 0..1, already thresholded by its cover). */
export function bakeCloudLayer(layer: SkyCloudLayer): BakedCloudLayer {
  const size = CLOUD_TILE;
  const density = new Float32Array(size * size);
  const threshold = 0.72 - clamp(layer.cover, 0, 1) * 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let n = 0;
      let amp = 0.5;
      let norm = 0;
      for (let o = 0; o < 5; o += 1) {
        const cells = 4 << o; // 4, 8, 16, 32, 64 cells across the tile: periodic at every octave
        n += periodicNoise((x / size) * cells, (y / size) * cells, cells, layer.seed + o * 13) * amp;
        norm += amp;
        amp *= 0.5;
      }
      density[y * size + x] = smoothstep(threshold, threshold + 0.25, n / norm);
    }
  }
  return { layer, density };
}

/** A layer's density at plane point (px, pz) and `time` seconds (bilinear, wrapping). */
export function cloudDensity(baked: BakedCloudLayer, px: number, pz: number, time: number): number {
  const l = baked.layer;
  const size = CLOUD_TILE;
  const u = ((px + l.wind[0] * time) * l.scale) * size;
  const v = ((pz + l.wind[1] * time) * l.scale) * size;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const w = (i: number) => ((i % size) + size) % size;
  const at = (x: number, y: number) => baked.density[w(y) * size + w(x)]!;
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Where a view direction meets the cloud plane, and how much of a layer shows
 * there: (px, pz) and a fade that hides the plane toward the horizon (where it
 * would stretch into streaks) and below it.
 */
export function cloudPlane(dx: number, dy: number, dz: number): [number, number, number] {
  const k = 1 / (Math.max(dy, 0) + 0.12);
  return [dx * k, dz * k, smoothstep(0.02, 0.25, dy)];
}

/** Composite every layer over a colour (0..255) seen along a direction's plane point; returns the new colour. */
export function overClouds(layers: readonly BakedCloudLayer[], px: number, pz: number, fade: number, time: number, r: number, g: number, b: number): [number, number, number] {
  for (const baked of layers) {
    const d = cloudDensity(baked, px, pz, time);
    const alpha = d * baked.layer.opacity * fade;
    if (alpha <= 0) continue;
    // Thicker cloud is darker underneath.
    const shade = 255 * (1 - 0.25 * d);
    const c = baked.layer.color;
    r += (c[0] * shade - r) * alpha;
    g += (c[1] * shade - g) * alpha;
    b += (c[2] * shade - b) * alpha;
  }
  return [r, g, b];
}

// --- Imported panoramas -----------------------------------------------------

/** A decoded high-dynamic-range image: linear RGB floats, `width × height × 3`. */
export interface HdrImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/**
 * Decode a Radiance `.hdr` (RGBE) image — the usual format for HDR skies —
 * with or without its run-length encoded scanlines. Null when it isn't one.
 */
export function decodeRadianceHdr(bytes: Uint8Array): HdrImage | null {
  let pos = 0;
  const line = (): string | null => {
    let s = "";
    while (pos < bytes.length) {
      const c = bytes[pos++]!;
      if (c === 0x0a) return s;
      s += String.fromCharCode(c);
    }
    return null;
  };
  const magic = line();
  if (magic === null || !magic.startsWith("#?")) return null;
  for (;;) {
    const l = line();
    if (l === null) return null;
    if (l === "") break;
    if (l.startsWith("FORMAT=") && l !== "FORMAT=32-bit_rle_rgbe") return null;
  }
  const size = line();
  const m = size ? /^-Y (\d+) \+X (\d+)$/.exec(size.trim()) : null;
  if (!m) return null;
  const height = Number(m[1]);
  const width = Number(m[2]);
  if (!(width > 0 && height > 0) || width * height > 16384 * 8192) return null;
  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y += 1) {
    if (pos + 4 > bytes.length) return null;
    const rle = width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && (bytes[pos + 2]! & 0x80) === 0;
    if (rle) {
      if (((bytes[pos + 2]! << 8) | bytes[pos + 3]!) !== width) return null;
      pos += 4;
      // Each of the four channels is stored as runs and literals in turn.
      for (let ch = 0; ch < 4; ch += 1) {
        let x = 0;
        while (x < width) {
          if (pos >= bytes.length) return null;
          let count = bytes[pos++]!;
          if (count > 128) {
            count -= 128;
            if (x + count > width || pos >= bytes.length) return null;
            const v = bytes[pos++]!;
            for (let i = 0; i < count; i += 1) scan[(x++) * 4 + ch] = v;
          } else {
            if (count === 0 || x + count > width || pos + count > bytes.length) return null;
            for (let i = 0; i < count; i += 1) scan[(x++) * 4 + ch] = bytes[pos++]!;
          }
        }
      }
    } else {
      // Flat scanline: RGBE quadruplets.
      if (pos + width * 4 > bytes.length) return null;
      scan.set(bytes.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    for (let x = 0; x < width; x += 1) {
      const e = scan[x * 4 + 3]!;
      const f = e === 0 ? 0 : Math.pow(2, e - 136); // (mantissa / 256) · 2^(e − 128)
      const o = (y * width + x) * 3;
      data[o] = scan[x * 4]! * f;
      data[o + 1] = scan[x * 4 + 1]! * f;
      data[o + 2] = scan[x * 4 + 2]! * f;
    }
  }
  return { width, height, data };
}

/** An HDR image exposed into the engine's 8-bit sky: scaled by `exposure`, gamma-encoded, clipped. */
export function hdrToTexture(hdr: HdrImage, exposure: number): DecodedTexture {
  const data = new Uint8ClampedArray(hdr.width * hdr.height * 4);
  for (let i = 0; i < hdr.width * hdr.height; i += 1) {
    for (let c = 0; c < 3; c += 1) data[i * 4 + c] = Math.round(255 * Math.pow(Math.max(0, hdr.data[i * 3 + c]! * exposure), 1 / 2.2));
    data[i * 4 + 3] = 255;
  }
  return { width: hdr.width, height: hdr.height, data };
}

/**
 * An imported equirectangular image resampled into a sky panorama of
 * `width × height` (bilinear, wrapping in longitude), turned `yaw` degrees
 * about the vertical and brightened by `exposure` (an LDR image's gain).
 */
export function resamplePanorama(source: DecodedTexture, width: number, height: number, yaw: number, exposure = 1): DecodedTexture {
  const data = new Uint8ClampedArray(width * height * 4);
  const sw = source.width;
  const sh = source.height;
  const turn = yaw / 360;
  for (let y = 0; y < height; y += 1) {
    const fy = clamp(((y + 0.5) / height) * sh - 0.5, 0, sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      let u = (x + 0.5) / width + turn;
      u -= Math.floor(u);
      const fx = u * sw - 0.5;
      const x0 = ((Math.floor(fx) % sw) + sw) % sw;
      const x1 = (x0 + 1) % sw;
      const tx = fx - Math.floor(fx);
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const a = source.data[(y0 * sw + x0) * 4 + c]! + (source.data[(y0 * sw + x1) * 4 + c]! - source.data[(y0 * sw + x0) * 4 + c]!) * tx;
        const b = source.data[(y1 * sw + x0) * 4 + c]! + (source.data[(y1 * sw + x1) * 4 + c]! - source.data[(y1 * sw + x0) * 4 + c]!) * tx;
        data[o + c] = (a + (b - a) * ty) * exposure;
      }
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}
