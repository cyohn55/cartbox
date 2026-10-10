/**
 * Procedural sky domes for the Modern (AAA) tier.
 *
 * A real skybox is a panorama — but a panorama detailed enough to fill a 720p
 * screen is megabytes of image, and a scene's lighting rig travels as a small
 * JSON sidecar. So the rig carries a *description* of the sky instead (a
 * {@link ProceduralSky}: colours, sun, cloud cover, mountain ranges) and the
 * runtime bakes it into an equirectangular panorama once, at load. The same
 * baked map then does two jobs:
 *
 * - **Backdrop** — {@link renderSkyBackground} paints it behind the scene through
 *   the camera, so a first-person view looks out at mountains and weather rather
 *   than a flat clear colour.
 * - **Image-based light** — a downsampled copy becomes the environment's `map`,
 *   so metals reflect the same peaks and clouds the player sees.
 *
 * Everything here is pure, deterministic and DOM-free: the same parameters bake
 * the same pixels in the editor preview, the runtime, and tests.
 */

import type { DecodedTexture, Mat4 } from "./meshRasterizer";
import { cloudPlane, overClouds, prepareSkyObjects, resamplePanorama, skyObjectsAt, type BakedCloudLayer, type SkyCloudLayer, type SkyObject } from "./skyLayers";

type Rgb = readonly [number, number, number];

/** One ring of mountains around the horizon. Angles are in degrees. */
export interface SkyMountainRange {
  /** Peak elevation above the horizon, degrees (the tallest ridges reach this). */
  readonly height: number;
  /** Ridge frequency: how many major peaks around the full circle. */
  readonly peaks: number;
  /** Rock colour (0..1). */
  readonly rock: Rgb;
  /** Snow colour (0..1). */
  readonly snow: Rgb;
  /** Fraction of the ridge height above which slopes carry snow, 0..1. */
  readonly snowLine: number;
  /** How much aerial haze washes this range toward the horizon colour, 0..1. */
  readonly haze: number;
  /** Noise seed so two ranges don't share a silhouette. */
  readonly seed: number;
}

/**
 * A procedural sky: a zenith→horizon gradient, a sun, a cloud layer and up to a
 * few rings of mountains, plus the misty valley floor below the horizon.
 */
export interface ProceduralSky {
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  /** Colour of the valley / cloud sea below the horizon. */
  readonly below: Rgb;
  /** World direction *towards* the sun (normalised on use). */
  readonly sunDirection: readonly [number, number, number];
  readonly sunColor: Rgb;
  /** Cloud cover, 0 (clear) .. 1 (overcast). */
  readonly clouds: number;
  readonly cloudColor: Rgb;
  /** Far-to-near: later ranges draw in front of earlier ones. */
  readonly mountains: readonly SkyMountainRange[];
  readonly seed: number;
  /**
   * An imported panorama (HALO_INFINITE_STYLE_ROADMAP.md I6; see skyLayers.ts)
   * in place of the gradient, sun glow, clouds and mountains above. The sun
   * direction still aims the key light, the shafts and the flare.
   */
  readonly panorama?: SkyPanorama | null;
  /** Objects at infinity — a ring, a planet — in front of the sky, behind its clouds and mountains (I6). */
  readonly objects?: readonly SkyObject[];
  /** Cloud layers drifting overhead, drawn over the backdrop each frame (I6). */
  readonly cloudLayers?: readonly SkyCloudLayer[];
}

/**
 * An imported equirectangular sky (I6): a PNG, JPEG or Radiance `.hdr`, kept
 * as base64 in the lighting rig (which travels as JSON).
 */
export interface SkyPanorama {
  /** "image/png", "image/jpeg" or "image/vnd.radiance". */
  readonly mime: string;
  /** The file's bytes, base64. */
  readonly data: string;
  /** Brightness: an HDR image's exposure into the 8-bit sky, an 8-bit image's gain (default 1). */
  readonly exposure: number;
  /** Turns it about the vertical, degrees (default 0). */
  readonly yaw: number;
}

/**
 * Height fog (HALO2_STYLE_ROADMAP.md, H7): a layer of fog that is dense below
 * `base` and thins exponentially above it — mist hugging the ground.
 */
export interface HeightFog {
  /** World height below which the layer is at full density. */
  readonly base: number;
  /** Density per world unit at and below `base` (0 = none). */
  readonly density: number;
  /** How fast it thins above `base`: density × e^(−falloff × height above). */
  readonly falloff: number;
}

/**
 * A fog volume (H7): a box of fog, dense below its floor-relative `falloff`
 * curve — mist pooling in a chasm, a cloud bank in a valley. It thins upward
 * from the box's floor the way {@link HeightFog} thins from its base.
 */
export interface FogVolume {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Density per world unit at the box's floor. */
  readonly density: number;
  /** How fast it thins going up from the floor (0 = even all the way up). */
  readonly falloff: number;
}

/** Sun glow (H7): the fog brightens looking toward the sun — light scattering in it. */
export interface FogGlow {
  readonly color: Rgb;
  /** 0 (none) .. 2. */
  readonly strength: number;
}

/** At most this many fog volumes — the GPU uniform carries a fixed four. */
export const MAX_FOG_VOLUMES = 4;
/** Tightness of the sun glow lobe: (view·sun)^power. */
export const FOG_GLOW_POWER = 8;

/** Distance fog for the Modern tier, applied after tone mapping. */
export interface SceneFog {
  /** Colour the scene fades toward (0..1, display space) — usually the horizon. */
  readonly color: Rgb;
  /** Exponential density per world unit beyond `start`. */
  readonly density: number;
  /** View distance (world units) where fog begins. */
  readonly start: number;
  /** Upper bound on the distance fog amount (0..1), so far geometry never fully vanishes. */
  readonly max: number;
  /** Ground-hugging height fog, or absent for none. */
  readonly height?: HeightFog | null;
  /** Boxes of fog, or absent for none. */
  readonly volumes?: readonly FogVolume[];
  /** Brightening toward the sun, or absent for none. */
  readonly glow?: FogGlow | null;
}

/** Fog amount (0..1) for a fragment at view depth `distance`. */
export function fogFactor(fog: SceneFog, distance: number): number {
  const d = Math.max(0, distance - fog.start);
  return Math.min(fog.max, 1 - Math.exp(-d * fog.density));
}

/** Whether the fog has any layer that depends on where the fragment is (height, volumes, glow). */
export function fogIsVolumetric(fog: SceneFog): boolean {
  return (fog.height?.density ?? 0) > 0 || (fog.volumes?.length ?? 0) > 0 || (fog.glow?.strength ?? 0) > 0;
}

/**
 * Optical depth of a layer of density `d · e^(−k · max(0, y − base))` along the
 * ray `C + (P − C)·t` for t in [t0, t1] (`cy` = C's height, `dy` = P's height −
 * C's, `len` = |P − C|). Below `base` it is even; above, it thins — integrated
 * exactly, split where the ray crosses `base`. The WGSL and GLSL ports match.
 */
export function fogLayerDepth(d: number, k: number, base: number, cy: number, dy: number, len: number, t0: number, t1: number): number {
  if (d <= 0 || t1 <= t0) return 0;
  let y0 = cy + dy * t0 - base;
  let y1 = cy + dy * t1 - base;
  if (y0 > y1) {
    const t = y0;
    y0 = y1;
    y1 = t;
  }
  const span = d * len * (t1 - t0);
  const h = y1 - y0;
  if (h < 1e-5) return span * Math.exp(-k * Math.max(0, y0));
  let tau = 0;
  // The part of the ray below the base: even density.
  if (y0 < 0) tau += (span * (Math.min(y1, 0) - y0)) / h;
  // The part above: ∫ e^(−k·y) dy over [lo, y1], averaged over the height span.
  if (y1 > 0) {
    const lo = Math.max(y0, 0);
    const above = y1 - lo;
    const x = k * above;
    tau += x < 1e-4 ? (span * above * Math.exp(-k * lo)) / h : (span * (Math.exp(-k * lo) - Math.exp(-k * y1))) / (k * h);
  }
  return tau;
}

/** Where the segment C→C+D·t (t in [0, 1]) is inside a box, or null when it misses. */
export function fogBoxSpan(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const o = [cx, cy, cz];
  const dir = [dx, dy, dz];
  for (let a = 0; a < 3; a += 1) {
    const da = dir[a]!;
    const oa = o[a]!;
    if (Math.abs(da) < 1e-9) {
      if (oa < min[a]! || oa > max[a]!) return null;
      continue;
    }
    let ta = (min[a]! - oa) / da;
    let tb = (max[a]! - oa) / da;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
  }
  return t1 > t0 ? [t0, t1] : null;
}

/**
 * The volumetric part of the fog (height layer + volumes) as an amount 0..1
 * between the eye `c` and the surface point `p`.
 */
export function fogVolumeAmount(fog: SceneFog, c: readonly [number, number, number], p: readonly [number, number, number]): number {
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  const dz = p[2] - c[2];
  const len = Math.hypot(dx, dy, dz);
  let tau = 0;
  const h = fog.height;
  if (h && h.density > 0) tau += fogLayerDepth(h.density, h.falloff, h.base, c[1], dy, len, 0, 1);
  for (const v of fog.volumes ?? []) {
    const span = fogBoxSpan(v.min, v.max, c[0], c[1], c[2], dx, dy, dz);
    if (span) tau += fogLayerDepth(v.density, v.falloff, v.min[1], c[1], dy, len, span[0], span[1]);
  }
  return 1 - Math.exp(-tau);
}

/**
 * Fog a display-space colour (0..255 channels, written in place into `out` at
 * `i`): the distance fog by eye depth, then the height and volume fog along the
 * ray from the eye, toward the fog colour brightened by the sun glow in the
 * direction of `toLight`. With only distance fog this is exactly the old mix.
 */
export function applyFog(
  fog: SceneFog,
  out: { [index: number]: number },
  i: number,
  eyeDepth: number,
  eye: readonly [number, number, number],
  p: readonly [number, number, number],
  toLight: readonly [number, number, number],
): void {
  let f = fogFactor(fog, eyeDepth);
  const volumetric = fogIsVolumetric(fog);
  let r = fog.color[0];
  let g = fog.color[1];
  let b = fog.color[2];
  if (volumetric) {
    const fv = fogVolumeAmount(fog, eye, p);
    f = 1 - (1 - f) * (1 - fv);
    const glow = fog.glow;
    if (glow && glow.strength > 0) {
      const dx = p[0] - eye[0];
      const dy = p[1] - eye[1];
      const dz = p[2] - eye[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const ll = Math.hypot(toLight[0], toLight[1], toLight[2]) || 1;
      const cos = Math.max(0, (dx * toLight[0] + dy * toLight[1] + dz * toLight[2]) / (len * ll));
      const k = glow.strength * Math.pow(cos, FOG_GLOW_POWER);
      r = Math.min(1, r + glow.color[0] * k);
      g = Math.min(1, g + glow.color[1] * k);
      b = Math.min(1, b + glow.color[2] * k);
    }
  }
  if (f <= 0) return;
  const cr = Math.min(255, Math.max(0, out[i]!));
  const cg = Math.min(255, Math.max(0, out[i + 1]!));
  const cb = Math.min(255, Math.max(0, out[i + 2]!));
  out[i] = cr + (r * 255 - cr) * f;
  out[i + 1] = cg + (g * 255 - cg) * f;
  out[i + 2] = cb + (b * 255 - cb) * f;
}

// --- Noise ------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += valueNoise(x * freq, y * freq, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Ridged fbm: sharp crests (1 − |2n−1|), the classic mountain silhouette. */
function ridged(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 31) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// --- Baking -----------------------------------------------------------------

/** How far below the horizon (radians) a mountain's base runs before the mist takes it. */
const MOUNTAIN_BASE = 0.05;

/** Below this cosine to the sun its glow is under a fifth of an 8-bit step, so it isn't drawn. */
const GLOW_FLOOR = 0.4;
/** Beyond this cosine (8° off the sun) the core is under a millionth of a step. */
const CORE_FLOOR = 0.99;

/**
 * A procedural sky's sun glow, looking `cosSun` (the cosine of the angle) off
 * the sun: a wide soft glow plus a tight core.
 */
export function sunGlow(cosSun: number): number {
  return broadGlow(cosSun) + coreGlow(cosSun);
}

/** The glow's wide, smooth part (powers by squaring: it runs per grid point when the backdrop draws the sun live). */
function broadGlow(c: number): number {
  if (c <= 0) return 0;
  const c2 = c * c;
  const c6 = c2 * c2 * c2;
  const c8 = c6 * c2;
  const c16 = c8 * c8;
  const c32 = c16 * c16;
  return c6 * 0.18 + c32 * c32 * 0.25;
}

/** The glow's tight core: a couple of degrees across. */
function coreGlow(c: number): number {
  return c > CORE_FLOOR ? Math.pow(c, 1500) * 0.6 : 0;
}

/** The sun a backdrop or a reflections copy draws: where it is, and its glow's colour. */
export interface SkySun {
  /** World direction toward the sun (normalised on use). */
  readonly direction: readonly [number, number, number];
  readonly color: Rgb;
}

/** A sky's own sun: where it was authored and its colour. */
export function skySun(sky: ProceduralSky): SkySun {
  return { direction: sky.sunDirection, color: sky.sunColor };
}

/**
 * Bake a {@link ProceduralSky} into an equirectangular panorama (`width × height`,
 * longitude = atan2(z, x) across, latitude top→bottom), matching the projection
 * `sampleEnvironmentDir` reads. Deterministic for a given sky and size.
 *
 * With `sunLayer`, the sun's glow is left out and its alpha holds how much of
 * the glow each texel lets through — less under cloud, none on a mountain or
 * the valley mist — so the glow can be drawn toward any sun later
 * ({@link panoramaWithSun}, or {@link renderSkyBackground}'s `sun`): a time of
 * day. An imported panorama paints its own sun, so its alpha is 0.
 */
export function bakeSkyPanorama(
  sky: ProceduralSky,
  width: number,
  height: number,
  imported: DecodedTexture | null = null,
  options: { readonly sunLayer?: boolean } = {},
): DecodedTexture {
  const sunLayer = options.sunLayer === true;
  // Sky objects (I6), framed once; shaded per texel in front of the sky.
  const objects = prepareSkyObjects(sky.objects ?? [], sky.sunDirection);
  const pixel = Math.PI / height;
  if (imported) {
    // An imported panorama (I6) stands in for the procedural sky: resampled, then the objects laid over it.
    const map = resamplePanorama(imported, width, height, sky.panorama?.yaw ?? 0, sky.panorama && !isRadiance(sky.panorama.mime) ? sky.panorama.exposure : 1);
    if (objects.length > 0) {
      const sl = Math.hypot(sky.sunDirection[0], sky.sunDirection[1], sky.sunDirection[2]) || 1;
      const sun = [sky.sunDirection[0] / sl, sky.sunDirection[1] / sl, sky.sunDirection[2] / sl] as const;
      for (let y = 0; y < height; y += 1) {
        const theta = ((y + 0.5) / height) * Math.PI;
        const st = Math.sin(theta);
        for (let x = 0; x < width; x += 1) {
          const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
          const [or, og, ob, oa] = skyObjectsAt(objects, [st * Math.cos(phi), Math.cos(theta), st * Math.sin(phi)], sun, sky.horizon, pixel);
          if (oa <= 0) continue;
          const o = (y * width + x) * 4;
          map.data[o] = map.data[o]! + (or * 255 - map.data[o]!) * oa;
          map.data[o + 1] = map.data[o + 1]! + (og * 255 - map.data[o + 1]!) * oa;
          map.data[o + 2] = map.data[o + 2]! + (ob * 255 - map.data[o + 2]!) * oa;
        }
      }
    }
    if (sunLayer) for (let i = 3; i < map.data.length; i += 4) map.data[i] = 0;
    return map;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const sl = Math.hypot(sky.sunDirection[0], sky.sunDirection[1], sky.sunDirection[2]) || 1;
  const sun = [sky.sunDirection[0] / sl, sky.sunDirection[1] / sl, sky.sunDirection[2] / sl] as const;
  const sunAzimuth = Math.atan2(sun[2], sun[0]);
  const DEG = Math.PI / 180;

  // Per-column ridge heights (radians of elevation) and slopes, one row per
  // range. Longitude is sampled on a circle so the silhouette wraps seamlessly.
  const ridges = sky.mountains.map((range) => {
    const heights = new Float32Array(width);
    const radius = Math.max(1, range.peaks) / (2 * Math.PI);
    for (let x = 0; x < width; x += 1) {
      const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const cx = Math.cos(phi) * radius + 50;
      const cy = Math.sin(phi) * radius + 50;
      // A broad swell (which ranges rise and fall) times the sharp ridge detail.
      const swell = 0.45 + 0.55 * fbm(cx * 0.35, cy * 0.35, range.seed + 101, 3);
      heights[x] = swell * ridged(cx, cy, range.seed, 6);
    }
    // Normalise the ridge so the tallest crest reaches exactly `height`, whatever
    // the noise's raw spread — then sharpen so peaks read as peaks, not a wall.
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const span = hi - lo || 1;
    for (let x = 0; x < width; x += 1) {
      const t = (heights[x]! - lo) / span;
      heights[x] = range.height * DEG * (0.12 + 0.88 * Math.pow(t, 1.6));
    }
    const slopes = new Float32Array(width);
    for (let x = 0; x < width; x += 1) {
      // A wide central difference, so the face shading changes with the ridge's
      // broad shape rather than flickering column to column.
      const w = Math.max(1, Math.round(width / 512)) * 4;
      slopes[x] = ((heights[(x + w) % width]! - heights[(x + width - w) % width]!) * width) / (4 * Math.PI * w);
    }
    return { range, heights, slopes };
  });

  for (let y = 0; y < height; y += 1) {
    const theta = ((y + 0.5) / height) * Math.PI; // 0 = straight up
    const elevation = Math.PI / 2 - theta;
    const dy = Math.cos(theta);
    const st = Math.sin(theta);
    for (let x = 0; x < width; x += 1) {
      const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = st * Math.cos(phi);
      const dz = st * Math.sin(phi);

      // Sky gradient: a quick fall from zenith into a bright hazy horizon band.
      const up = Math.max(0, dy);
      const g = Math.pow(up, 0.45);
      let r = sky.horizon[0] + (sky.zenith[0] - sky.horizon[0]) * g;
      let gg = sky.horizon[1] + (sky.zenith[1] - sky.horizon[1]) * g;
      let b = sky.horizon[2] + (sky.zenith[2] - sky.horizon[2]) * g;

      // Sky objects (I6): in front of the sky, behind its clouds and mountains.
      if (objects.length > 0) {
        const [or, og, ob, oa] = skyObjectsAt(objects, [dx, dy, dz], sun, sky.horizon, pixel);
        if (oa > 0) {
          r += (or - r) * oa;
          gg += (og - gg) * oa;
          b += (ob - b) * oa;
        }
      }

      // Sun: a wide soft glow plus a tight core.
      const cosSun = Math.max(0, dx * sun[0] + dy * sun[1] + dz * sun[2]);
      const glow = sunGlow(cosSun);

      // Clouds on a plane overhead (dir.xz / dir.y), fading into the horizon haze.
      let cloud = 0;
      if (dy > 0.005 && sky.clouds > 0) {
        const k = 1 / (dy + 0.12);
        const px = dx * k * 1.6;
        const pz = dz * k * 1.6;
        const n = fbm(px + 13.1, pz - 7.7, sky.seed, 5);
        const streak = fbm(px * 0.35 + 3.3, pz * 1.4, sky.seed + 7, 3);
        const density = n * 0.75 + streak * 0.35;
        const threshold = 0.78 - sky.clouds * 0.5;
        cloud = smoothstep(threshold, threshold + 0.22, density) * smoothstep(0.0, 0.25, dy);
        // Self-shadowed bellies: denser cloud is darker underneath, sun-side edges lit.
        const lit = 0.72 + 0.28 * cosSun - (density - threshold) * 0.35;
        const cr = sky.cloudColor[0] * lit;
        const cg = sky.cloudColor[1] * lit;
        const cb = sky.cloudColor[2] * lit;
        r += (cr - r) * cloud;
        gg += (cg - gg) * cloud;
        b += (cb - b) * cloud;
      }
      // How much of the glow shows here: dimmed by cloud, then by the mist and
      // mountains laid over it below (kept in alpha for a sun layer).
      let sunVis = 1 - cloud * 0.85;
      if (!sunLayer) {
        r += sky.sunColor[0] * glow * sunVis;
        gg += sky.sunColor[1] * glow * sunVis;
        b += sky.sunColor[2] * glow * sunVis;
      }

      // Below the horizon: a misty valley / cloud sea.
      if (elevation < 0) {
        const depth = smoothstep(0, 0.35, -elevation);
        const k = 1 / (-dy + 0.05);
        const mist = fbm(dx * k * 0.8 + 5, dz * k * 0.8 - 9, sky.seed + 51, 4);
        const tone = 0.85 + 0.3 * mist;
        const br = sky.below[0] * tone;
        const bg = sky.below[1] * tone;
        const bb = sky.below[2] * tone;
        const m = smoothstep(0, 0.06, -elevation);
        r += (br * (1 - depth * 0.25) - r) * m;
        gg += (bg * (1 - depth * 0.25) - gg) * m;
        b += (bb * (1 - depth * 0.2) - b) * m;
        sunVis *= 1 - m;
      }

      // Mountains, far to near: each covers the band from a little below the
      // horizon (where the valley mist swallows its base) up to its ridge line.
      for (const { range, heights, slopes } of ridges) {
        const ridge = heights[x]!;
        if (elevation > ridge || elevation < -MOUNTAIN_BASE) continue;
        // Height up the face, 0 at the horizon .. 1 at the crest.
        const along = Math.max(0, elevation) / ridge;
        // Isotropic noise in angle space (one unit ≈ 2.4°), so the faces break up
        // into snowfields and rock bands rather than vertical barcode stripes.
        // Octaves stop well above the bake's texel size, or the pattern aliases
        // into blocks once the panorama is magnified onto a 720p screen.
        const ax = phi * 24;
        const ay = elevation * 24;
        const patch = fbm(ax + range.seed, ay * 1.3, range.seed + 5, 3);
        const ribs = ridged(ax * 1.2, ay * 0.45, range.seed + 9, 3);
        // Snow on the upper faces, broken by rock ribs running down the slope.
        const snowEdge = range.snowLine + (patch - 0.5) * 0.6;
        let snow = smoothstep(snowEdge - 0.18, snowEdge + 0.18, along);
        snow *= 1 - smoothstep(0.5, 0.9, ribs) * 0.8;
        snow = Math.max(snow, smoothstep(0.85, 1, along) * 0.7); // wind-packed crests
        // Faces turned toward the sun's azimuth are lit, the others in cold shadow.
        const slope = slopes[x]!;
        const facing = Math.tanh(-Math.sin(phi - sunAzimuth) * slope * 3);
        const light = 0.66 + 0.34 * Math.max(-0.5, Math.min(1, facing + 0.25));
        const grain = 0.9 + 0.2 * patch;
        let mr = (range.rock[0] + (range.snow[0] - range.rock[0]) * snow) * light * grain;
        let mg = (range.rock[1] + (range.snow[1] - range.rock[1]) * snow) * light * grain;
        let mb = (range.rock[2] + (range.snow[2] - range.rock[2]) * snow) * light * grain;
        // Aerial perspective, heavier toward the base where the valley mist rises.
        const base = 1 - smoothstep(0, 0.45, along);
        const haze = Math.min(1, range.haze + base * 0.45);
        mr += (sky.horizon[0] - mr) * haze;
        mg += (sky.horizon[1] - mg) * haze;
        mb += (sky.horizon[2] - mb) * haze;
        // Soft anti-aliased crest, and the base dissolving into the mist below.
        const edge =
          smoothstep(0, (0.35 * Math.PI) / height, ridge - elevation) *
          smoothstep(-MOUNTAIN_BASE, 0, elevation);
        r += (mr - r) * edge;
        gg += (mg - gg) * edge;
        b += (mb - b) * edge;
        sunVis *= 1 - edge;
      }

      const o = (y * width + x) * 4;
      data[o] = r * 255;
      data[o + 1] = gg * 255;
      data[o + 2] = b * 255;
      data[o + 3] = sunLayer ? sunVis * 255 : 255;
    }
  }
  return { width, height, data };
}

/** Whether a panorama's file is a Radiance HDR (exposed at decode, not as a gain). */
export function isRadiance(mime: string): boolean {
  return mime === "image/vnd.radiance";
}

/**
 * A panorama with drifting cloud layers laid over it as they stand at `time`
 * (I6) — what the reflections see, baked once at rest; the backdrop draws the
 * layers itself, moving, each frame.
 */
export function panoramaWithClouds(map: DecodedTexture, layers: readonly BakedCloudLayer[], time = 0): DecodedTexture {
  if (layers.length === 0) return map;
  const { width, height } = map;
  const data = new Uint8ClampedArray(map.data);
  for (let y = 0; y < height; y += 1) {
    const theta = ((y + 0.5) / height) * Math.PI;
    const dy = Math.cos(theta);
    if (dy <= 0.02) continue;
    const st = Math.sin(theta);
    for (let x = 0; x < width; x += 1) {
      const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const [px, pz, fade] = cloudPlane(st * Math.cos(phi), dy, st * Math.sin(phi));
      const o = (y * width + x) * 4;
      const [r, g, b] = overClouds(layers, px, pz, fade, time, data[o]!, data[o + 1]!, data[o + 2]!);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
    }
  }
  return { width, height, data };
}

/** Box-downsample a panorama by an integer factor (for the IBL copy); alpha (a sun layer's) is averaged too. */
export function downsamplePanorama(map: DecodedTexture, factor: number): DecodedTexture {
  const f = Math.max(1, Math.floor(factor));
  const width = Math.max(1, Math.floor(map.width / f));
  const height = Math.max(1, Math.floor(map.height / f));
  const data = new Uint8ClampedArray(width * height * 4);
  const n = f * f;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < f; j += 1) {
        for (let i = 0; i < f; i += 1) {
          const at = ((y * f + j) * map.width + x * f + i) * 4;
          r += map.data[at]!;
          g += map.data[at + 1]!;
          b += map.data[at + 2]!;
          a += map.data[at + 3]!;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = a / n;
    }
  }
  return { width, height, data };
}

/**
 * A sun-layer panorama ({@link bakeSkyPanorama}'s `sunLayer`) with the glow of
 * `sun` drawn in — what a reflections copy shows — opaque. Near the sun each
 * texel's core is the mean over `samples × samples` points across it, so a
 * small copy still holds the core's light.
 */
export function panoramaWithSun(map: DecodedTexture, sun: SkySun, samples = 1): DecodedTexture {
  const { width, height } = map;
  const data = new Uint8ClampedArray(map.data);
  const l = Math.hypot(sun.direction[0], sun.direction[1], sun.direction[2]) || 1;
  const sx = sun.direction[0] / l, sy = sun.direction[1] / l, sz = sun.direction[2] / l;
  const s = Math.max(1, Math.floor(samples));
  // A texel's corners are within this cosine of its centre's (well inside the floor's margin).
  const margin = 1 - Math.cos((Math.PI / height) * 1.5);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const a = data[o + 3]!;
      data[o + 3] = 255;
      if (a === 0) continue;
      const centre = texelDirection(x + 0.5, y + 0.5, width, height);
      const c = centre[0] * sx + centre[1] * sy + centre[2] * sz;
      if (c < GLOW_FLOOR - margin) continue;
      let glow = broadGlow(c);
      if (c > CORE_FLOOR - margin) {
        let core = 0;
        for (let j = 0; j < s; j += 1) {
          for (let i = 0; i < s; i += 1) {
            const d = texelDirection(x + (i + 0.5) / s, y + (j + 0.5) / s, width, height);
            core += coreGlow(d[0] * sx + d[1] * sy + d[2] * sz);
          }
        }
        glow += core / (s * s);
      }
      const g = glow * a;
      data[o] = data[o]! + sun.color[0] * g;
      data[o + 1] = data[o + 1]! + sun.color[1] * g;
      data[o + 2] = data[o + 2]! + sun.color[2] * g;
    }
  }
  return { width, height, data };
}

/** The direction through panorama point (`x`, `y`) in texels (the bake's own mapping). */
function texelDirection(x: number, y: number, width: number, height: number): [number, number, number] {
  const theta = (y / height) * Math.PI;
  const phi = (x / width - 0.5) * 2 * Math.PI;
  const st = Math.sin(theta);
  return [st * Math.cos(phi), Math.cos(theta), st * Math.sin(phi)];
}

/** Reused half-resolution scratch for {@link renderSkyBackground}. */
let skyScratch: Uint32Array | null = null;
let gridU: Float32Array | null = null;
let gridV: Float32Array | null = null;
let gridPx: Float32Array | null = null;
let gridPz: Float32Array | null = null;
let gridFade: Float32Array | null = null;
/** Each grid ray's direction, unit length, and the sun's wide glow along it (for a sun drawn live). */
let gridDir: Float32Array | null = null;
let gridGlow: Float32Array | null = null;

/**
 * Paint a panorama behind the camera into `out` (RGBA, `width × height`): every
 * pixel gets the sky along its view ray, bilinearly filtered. The ray is built
 * from the view matrix's rotation and the projection's focal lengths, so it
 * lines up with the rasterised scene exactly; translation is ignored (the sky is
 * at infinity).
 *
 * Cheap enough to run every frame at 720p: directions are solved on a coarse
 * `step`-pixel grid with the panorama coordinates interpolated between, and the
 * sky — soft by nature — is shaded at 1/`scale` resolution then expanded with
 * 32-bit block copies.
 *
 * With `sun`, the map is a sun layer ({@link bakeSkyPanorama}'s `sunLayer`) and
 * the sun's glow is drawn toward `sun` as it is now, through the map's alpha —
 * a sun that moves (`cartbox.sun3d`). The wide glow is solved on the grid
 * and interpolated like the panorama coordinates; only the few cells round the
 * sun's core solve it per pixel.
 */
export function renderSkyBackground(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  view: Mat4,
  projection: Mat4,
  map: DecodedTexture,
  step = 8,
  scale = 2,
  /** Drifting cloud layers (I6) and the time they have drifted to, or omitted for none. */
  clouds: { readonly layers: readonly BakedCloudLayer[]; readonly time: number } | null = null,
  sun: SkySun | null = null,
): void {
  const k = Math.max(1, Math.floor(scale));
  const sw = Math.ceil(width / k);
  const sh = Math.ceil(height / k);
  if (!skyScratch || skyScratch.length < sw * sh) skyScratch = new Uint32Array(sw * sh);
  const small = skyScratch;

  // Rows of the view rotation: camera right, up and back in world space.
  const rx = view[0]!, ry = view[4]!, rz = view[8]!;
  const ux = view[1]!, uy = view[5]!, uz = view[9]!;
  const bx = view[2]!, by = view[6]!, bz = view[10]!;
  const fx0 = 1 / projection[0]!;
  const fy0 = 1 / projection[5]!;
  const gstep = Math.max(1, Math.floor(step / k));
  const gw = Math.ceil(sw / gstep) + 1;
  const gh = Math.ceil(sh / gstep) + 1;
  // Reused between frames: this runs every frame, so no per-call garbage.
  if (!gridU || gridU.length < gw * gh) {
    gridU = new Float32Array(gw * gh);
    gridV = new Float32Array(gw * gh);
  }
  const gu = gridU;
  const gv = gridV!;
  if (sun && (!gridDir || gridDir.length < gw * gh * 3)) {
    gridDir = new Float32Array(gw * gh * 3);
    gridGlow = new Float32Array(gw * gh);
  }
  const gd = gridDir;
  const gl = gridGlow;
  const sl = sun ? Math.hypot(sun.direction[0], sun.direction[1], sun.direction[2]) || 1 : 1;
  const sunX = sun ? sun.direction[0] / sl : 0, sunY = sun ? sun.direction[1] / sl : 0, sunZ = sun ? sun.direction[2] / sl : 0;
  // The glow's colour in 8-bit units.
  const glowR = sun ? sun.color[0] * 255 : 0, glowG = sun ? sun.color[1] * 255 : 0, glowB = sun ? sun.color[2] * 255 : 0;
  // Where each grid ray meets the cloud plane (I6), interpolated across cells as u and v are.
  const layered = clouds !== null && clouds.layers.length > 0;
  if (layered && (!gridPx || gridPx.length < gw * gh)) {
    gridPx = new Float32Array(gw * gh);
    gridPz = new Float32Array(gw * gh);
    gridFade = new Float32Array(gw * gh);
  }
  const TWO_PI = 2 * Math.PI;
  for (let j = 0; j < gh; j += 1) {
    const ndcY = 1 - ((j * gstep * k) / height) * 2;
    for (let i = 0; i < gw; i += 1) {
      const ndcX = ((i * gstep * k) / width) * 2 - 1;
      const cx = ndcX * fx0;
      const cy = ndcY * fy0;
      const dx = rx * cx + ux * cy - bx;
      const dy = ry * cx + uy * cy - by;
      const dz = rz * cx + uz * cy - bz;
      const len = Math.hypot(dx, dy, dz) || 1;
      gu[j * gw + i] = Math.atan2(dz, dx) / TWO_PI + 0.5;
      gv[j * gw + i] = Math.acos(Math.max(-1, Math.min(1, dy / len))) / Math.PI;
      if (sun) {
        gd![(j * gw + i) * 3] = dx / len;
        gd![(j * gw + i) * 3 + 1] = dy / len;
        gd![(j * gw + i) * 3 + 2] = dz / len;
        gl![j * gw + i] = broadGlow((dx * sunX + dy * sunY + dz * sunZ) / len);
      }
      if (layered) {
        const [px, pz, fade] = cloudPlane(dx / len, dy / len, dz / len);
        gridPx![j * gw + i] = px;
        gridPz![j * gw + i] = pz;
        gridFade![j * gw + i] = fade;
      }
    }
  }

  // Shade the small buffer one grid cell at a time, stepping the panorama
  // coordinates incrementally across each cell (no per-pixel divides).
  const mw = map.width;
  const mh = map.height;
  const src = map.data;
  const inv = 1 / gstep;
  /** How squarely grid ray `c` (its index × 3) faces the sun. */
  const facing = (c: number) => gd![c]! * sunX + gd![c + 1]! * sunY + gd![c + 2]! * sunZ;
  /** The wide glow's floor, at {@link GLOW_FLOOR}. */
  const broadFloor = broadGlow(GLOW_FLOOR);
  for (let j = 0; j < gh - 1; j += 1) {
    const y0c = j * gstep;
    if (y0c >= sh) break;
    const y1c = Math.min(sh, y0c + gstep);
    for (let i = 0; i < gw - 1; i += 1) {
      const x0c = i * gstep;
      if (x0c >= sw) break;
      const x1c = Math.min(sw, x0c + gstep);
      const g = j * gw + i;
      const u00 = gu[g]!;
      // Unwrap the other corners' longitude against this one so the seam at
      // u = 0/1 interpolates the short way round.
      let u10 = gu[g + 1]!;
      let u01 = gu[g + gw]!;
      let u11 = gu[g + gw + 1]!;
      if (u10 - u00 > 0.5) u10 -= 1; else if (u00 - u10 > 0.5) u10 += 1;
      if (u01 - u00 > 0.5) u01 -= 1; else if (u00 - u01 > 0.5) u01 += 1;
      if (u11 - u00 > 0.5) u11 -= 1; else if (u00 - u11 > 0.5) u11 += 1;
      const v00 = gv[g]!;
      const v10 = gv[g + 1]!;
      const v01 = gv[g + gw]!;
      const v11 = gv[g + gw + 1]!;
      // The sun's glow, if any corner of the cell is near enough the sun to show
      // it; its core (per pixel), if a corner is within a few degrees of it.
      const glowing = sun !== null && Math.max(gl![g]!, gl![g + 1]!, gl![g + gw]!, gl![g + gw + 1]!) > broadFloor;
      const g3 = g * 3, gr3 = (g + 1) * 3, gb3 = (g + gw) * 3, gbr3 = (g + gw + 1) * 3;
      const cored = glowing && Math.max(facing(g3), facing(gr3), facing(gb3), facing(gbr3)) > CORE_FLOOR - 0.01;
      for (let y = y0c; y < y1c; y += 1) {
        const ty = (y - y0c) * inv;
        const uL = u00 + (u01 - u00) * ty;
        const uR = u10 + (u11 - u10) * ty;
        const vL = v00 + (v01 - v00) * ty;
        const vR = v10 + (v11 - v10) * ty;
        const du = (uR - uL) * inv;
        const dv = (vR - vL) * inv;
        let u = uL + 1; // keep positive so |0 floors
        let v = vL;
        let o = y * sw + x0c;
        // The wide glow across the row, and near the core the ray's direction: linear between the corners'.
        let glow = 0, dglow = 0;
        let ex = 0, ey = 0, ez = 0, dex = 0, dey = 0, dez = 0;
        if (glowing) {
          const left = gl![g]! + (gl![g + gw]! - gl![g]!) * ty;
          glow = left;
          dglow = (gl![g + 1]! + (gl![g + gw + 1]! - gl![g + 1]!) * ty - left) * inv;
        }
        if (cored) {
          const lerp = (k: number) => {
            const left = gd![g3 + k]! + (gd![gb3 + k]! - gd![g3 + k]!) * ty;
            const right = gd![gr3 + k]! + (gd![gbr3 + k]! - gd![gr3 + k]!) * ty;
            return [left, (right - left) * inv] as const;
          };
          [ex, dex] = lerp(0);
          [ey, dey] = lerp(1);
          [ez, dez] = lerp(2);
        }
        for (let x = x0c; x < x1c; x += 1, u += du, v += dv, o += 1) {
          // Bilinear fetch, wrapping longitude and clamping latitude.
          const fx = (u - (u | 0)) * mw - 0.5 + mw;
          let fy = v * mh - 0.5;
          if (fy < 0) fy = 0; else if (fy > mh - 1) fy = mh - 1;
          const xi = fx | 0;
          const yi = fy | 0;
          const ax = fx - xi;
          const ay = fy - yi;
          const x0 = xi >= mw ? xi - mw : xi;
          const x1 = x0 + 1 === mw ? 0 : x0 + 1;
          const row0 = yi * mw;
          const row1 = (yi + 1 < mh ? yi + 1 : yi) * mw;
          const p00 = (row0 + x0) << 2;
          const p10 = (row0 + x1) << 2;
          const p01 = (row1 + x0) << 2;
          const p11 = (row1 + x1) << 2;
          const w11 = ax * ay;
          const w10 = ax - w11;
          const w01 = ay - w11;
          const w00 = 1 - ax - ay + w11;
          const r = src[p00]! * w00 + src[p10]! * w10 + src[p01]! * w01 + src[p11]! * w11;
          const gg = src[p00 + 1]! * w00 + src[p10 + 1]! * w10 + src[p01 + 1]! * w01 + src[p11 + 1]! * w11;
          const b = src[p00 + 2]! * w00 + src[p10 + 2]! * w10 + src[p01 + 2]! * w01 + src[p11 + 2]! * w11;
          if (glowing) {
            let here = glow;
            glow += dglow;
            if (cored) {
              // Interpolated directions fall short of unit length mid-cell: normalise, or the core dims.
              here += coreGlow((ex * sunX + ey * sunY + ez * sunZ) / Math.sqrt(ex * ex + ey * ey + ez * ez));
              ex += dex;
              ey += dey;
              ez += dez;
            }
            const a = src[p00 + 3]! * w00 + src[p10 + 3]! * w10 + src[p01 + 3]! * w01 + src[p11 + 3]! * w11;
            if (here > broadFloor && a > 0) {
              const lit = here * (a / 255);
              const lr = Math.min(255, r + glowR * lit), lg = Math.min(255, gg + glowG * lit), lb = Math.min(255, b + glowB * lit);
              small[o] = 0xff000000 | ((lb + 0.5) << 16) | ((lg + 0.5) << 8) | (lr + 0.5);
              continue;
            }
          }
          // Little-endian RGBA packed as one word (alpha 255).
          small[o] = 0xff000000 | ((b + 0.5) << 16) | ((gg + 0.5) << 8) | (r + 0.5);
        }
      }
    }
  }

  // Drifting cloud layers (I6), over the shaded sky: each pixel's plane point
  // and fade interpolated across its grid cell.
  if (layered) {
    const px = gridPx!;
    const pz = gridPz!;
    const pf = gridFade!;
    for (let j = 0; j < gh - 1; j += 1) {
      const y0c = j * gstep;
      if (y0c >= sh) break;
      const y1c = Math.min(sh, y0c + gstep);
      for (let i = 0; i < gw - 1; i += 1) {
        const x0c = i * gstep;
        if (x0c >= sw) break;
        const x1c = Math.min(sw, x0c + gstep);
        const g = j * gw + i;
        // A cell whose corners are all below the clouds' fade has none to draw.
        if (pf[g]! <= 0 && pf[g + 1]! <= 0 && pf[g + gw]! <= 0 && pf[g + gw + 1]! <= 0) continue;
        for (let y = y0c; y < y1c; y += 1) {
          const ty = (y - y0c) * inv;
          for (let x = x0c; x < x1c; x += 1) {
            const tx = (x - x0c) * inv;
            const lerp = (f: Float32Array) => {
              const top = f[g]! + (f[g + 1]! - f[g]!) * tx;
              const bottom = f[g + gw]! + (f[g + gw + 1]! - f[g + gw]!) * tx;
              return top + (bottom - top) * ty;
            };
            const fade = lerp(pf);
            if (fade <= 0) continue;
            const o = y * sw + x;
            const word = small[o]!;
            const [r, gg, b] = overClouds(clouds!.layers, lerp(px), lerp(pz), fade, clouds!.time, word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff);
            small[o] = 0xff000000 | ((Math.min(255, Math.max(0, b)) + 0.5) << 16) | ((Math.min(255, Math.max(0, gg)) + 0.5) << 8) | (Math.min(255, Math.max(0, r)) + 0.5);
          }
        }
      }
    }
  }

  // Expand to full resolution with word copies: build one row per source row,
  // then duplicate it down the block with copyWithin.
  const dst = new Uint32Array(out.buffer, out.byteOffset, width * height);
  for (let y = 0; y < height; y += k) {
    const srow = Math.floor(y / k) * sw;
    const drow = y * width;
    if (k === 1) {
      dst.set(small.subarray(srow, srow + width), drow);
      continue;
    }
    for (let sx = 0, x = 0; x < width; sx += 1) {
      const word = small[srow + sx]!;
      for (let r = 0; r < k && x < width; r += 1, x += 1) dst[drow + x] = word;
    }
    for (let r = 1; r < k && y + r < height; r += 1) dst.copyWithin(drow + r * width, drow, drow + width);
  }
}
