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
}

/** Distance fog for the Modern tier, applied after tone mapping. */
export interface SceneFog {
  /** Colour the scene fades toward (0..1, display space) — usually the horizon. */
  readonly color: Rgb;
  /** Exponential density per world unit beyond `start`. */
  readonly density: number;
  /** View distance (world units) where fog begins. */
  readonly start: number;
  /** Upper bound on the fog amount (0..1), so far geometry never fully vanishes. */
  readonly max: number;
}

/** Fog amount (0..1) for a fragment at view depth `distance`. */
export function fogFactor(fog: SceneFog, distance: number): number {
  const d = Math.max(0, distance - fog.start);
  return Math.min(fog.max, 1 - Math.exp(-d * fog.density));
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

/**
 * Bake a {@link ProceduralSky} into an equirectangular panorama (`width × height`,
 * longitude = atan2(z, x) across, latitude top→bottom), matching the projection
 * `sampleEnvironmentDir` reads. Deterministic for a given sky and size.
 */
export function bakeSkyPanorama(sky: ProceduralSky, width: number, height: number): DecodedTexture {
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

      // Sun: a wide soft glow plus a tight core.
      const cosSun = Math.max(0, dx * sun[0] + dy * sun[1] + dz * sun[2]);
      const glow = Math.pow(cosSun, 6) * 0.18 + Math.pow(cosSun, 64) * 0.25 + Math.pow(cosSun, 1500) * 0.6;

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
      const sunVis = 1 - cloud * 0.85;
      r += sky.sunColor[0] * glow * sunVis;
      gg += sky.sunColor[1] * glow * sunVis;
      b += sky.sunColor[2] * glow * sunVis;

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
      }

      const o = (y * width + x) * 4;
      data[o] = r * 255;
      data[o + 1] = gg * 255;
      data[o + 2] = b * 255;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Box-downsample a panorama by an integer factor (for the IBL copy). */
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
      for (let j = 0; j < f; j += 1) {
        for (let i = 0; i < f; i += 1) {
          const at = ((y * f + j) * map.width + x * f + i) * 4;
          r += map.data[at]!;
          g += map.data[at + 1]!;
          b += map.data[at + 2]!;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Reused half-resolution scratch for {@link renderSkyBackground}. */
let skyScratch: Uint32Array | null = null;

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
  const gu = new Float32Array(gw * gh);
  const gv = new Float32Array(gw * gh);
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
    }
  }

  // Shade the small buffer one grid cell at a time, stepping the panorama
  // coordinates incrementally across each cell (no per-pixel divides).
  const mw = map.width;
  const mh = map.height;
  const src = map.data;
  const inv = 1 / gstep;
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
          // Little-endian RGBA packed as one word (alpha 255).
          small[o] = 0xff000000 | ((b + 0.5) << 16) | ((gg + 0.5) << 8) | (r + 0.5);
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
