/**
 * The "Lockout arena" starter — a Halo 2 Lockout-inspired first-person arena for
 * the Xbox 360 model, and the cart that shows off the editor's newest 3D features:
 * **PBR metallic-roughness** surfaces (glossy Forerunner metal, cyan **emissive**
 * energy) **normal-mapped** for panel relief, lit by an authored **scene lighting
 * rig** — a cool image-based-lighting skybox, a directional key + fill, a cyan
 * point light in the Sword pit, ACES tone mapping and directional **shadows**.
 * This is the Modern (AAA) tier: the metals reflect the sky and the energy glows
 * and rolls off through the tone-map curve, rather than the flat option-2 shading
 * the cart shipped with before.
 *
 * Hard truths this cart is built around:
 *  - Cartbox has no networking, so "8 players" is you + 7 AI bots, one local match.
 *  - The web player forwards only 8 gamepad buttons to a cart (arrows + Z/X/A/S) —
 *    no keyboard or mouse passthrough — so the controls are a single-stick console
 *    FPS: tank move + turn, a strafe modifier, and vertical auto-aim.
 *  - A software-rasterised fantasy console can't match real Halo 2 fidelity; this
 *    is a stylised Forerunner homage that pushes the engine's lighting hard.
 *
 * The camera is first-person via a trick: the mesh renderer exposes only an orbit
 * camera, so the cart moves that orbit *target* (the `worldcam` alias writes the
 * same mailbox slot the mesh camera reads) and inverse-solves the orbit angles so
 * the eye lands exactly on the player. The offset is relative to the scene centre,
 * so the geometry is symmetric in X/Z and the bots are authored at the origin,
 * making that centre the known constant a test pins against the runtime bounds.
 */

import type { CartEngine } from "../engine/CartEngine";
import { encodeRgbaPng } from "./png";
import { serializeMeshAsset, type EncodedImage, type MeshAsset, type MeshPrimitive } from "./MeshAsset";
import type { SceneLighting } from "./SceneLighting";
import { chamferedRect, newStreams, pushBox, pushLoft, toPrimitive, type Streams } from "./seedGeometry";
import { packMeshLibrary } from "./meshLibrary";
import { SWEETIE_16 } from "./palette";

/** An axis-aligned box: centre (cx,cy,cz) and half-extents (hx,hy,hz). */
type Box = readonly [number, number, number, number, number, number];

// --- The Forerunner texture set -------------------------------------------
// Three original, procedurally painted, seamlessly tiling surfaces, each baked
// into the glTF-style PBR maps the Modern-tier rasteriser reads together:
// albedo, a tangent-space normal map (from a painted height field), a packed
// metallic-roughness map (G = roughness, B = metallic) and an emissive map.
//
//  - WALL: staggered bands of machined panels with angular recessed inlays and
//    a sparse cyan light line, weathered — grime streaking down from every
//    seam, frost packed into the grooves, bright wear on the bevels.
//  - FLOOR: broad, darker deck plates with engraved borders and a chevron
//    inlay, scuffed, with frost in the joints and tiny cyan studs.
//  - SNOW: soft wind-packed snow with a faint sparkle.
//
// 256² with PNG filtering + DEFLATE (see png.ts), so the higher resolution
// costs a fraction of what the old stored 128² maps did.

const TEX = 256;

/** A painted surface sample: colour 0..255, height 0..1, PBR terms 0..1. */
interface Surf {
  r: number;
  g: number;
  b: number;
  h: number;
  rough: number;
  metal: number;
  emis: number; // 0..1, the cyan energy channel
}

/** Integer hash → 0..1, wrapped to a period so the noise tiles seamlessly. */
function thash(x: number, y: number, seed: number, period: number): number {
  const xi = ((x % period) + period) % period;
  const yi = ((y % period) + period) % period;
  let h = (Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise with `cells` lattice cells across the texture. */
function tnoise(px: number, py: number, cells: number, seed: number): number {
  const x = (px / TEX) * cells;
  const y = (py / TEX) * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = thash(xi, yi, seed, cells);
  const b = thash(xi + 1, yi, seed, cells);
  const c = thash(xi, yi + 1, seed, cells);
  const d = thash(xi + 1, yi + 1, seed, cells);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function tfbm(px: number, py: number, cells: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += tnoise(px, py, cells << i, seed + i * 7) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

const wrap = (v: number): number => ((v % TEX) + TEX) % TEX;
const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** Distance (px) from `v` to the nearest of `lines` on a wrapped axis. */
function seamDistance(v: number, lines: readonly number[]): number {
  let best = Infinity;
  for (const l of lines) {
    const d = Math.abs(wrap(v - l));
    best = Math.min(best, d, TEX - d);
  }
  return best;
}

/** How far `v` sits *below* the nearest seam above it (for streaks that run down). */
function belowSeam(v: number, lines: readonly number[]): number {
  let best = Infinity;
  for (const l of lines) best = Math.min(best, wrap(v - l));
  return best;
}

const WALL_ROWS = [0, 88, 168];

function wallSurface(x: number, y: number): Surf {
  // Staggered vertical seams per band.
  const band = y < 88 ? 0 : y < 168 ? 1 : 2;
  const cols = band === 1 ? [64, 192] : [0, 128];
  const dRow = seamDistance(y, WALL_ROWS);
  const dCol = seamDistance(x, cols);
  const edge = Math.min(dRow, dCol);

  const mottle = tfbm(x, y, 8, 11) - 0.5;
  let r = 150;
  let g = 158;
  let b = 171;
  if (band === 1) {
    r = 124;
    g = 132;
    b = 146;
  }
  let h = 0.6;
  let rough = 0.32;
  let metal = 0.85;
  let emis = 0;

  // Machined inlay in the middle band: an angular, chamfered recessed plate.
  if (band === 1) {
    const px = wrap(x - 64) % 128; // 0..127 within this band's panel
    const py = y - 88; // 0..79
    const ix = Math.min(px, 127 - px);
    const iy = Math.min(py, 79 - py);
    const chamfer = ix + iy;
    if (ix > 14 && iy > 12 && chamfer > 40) {
      r = 100;
      g = 108;
      b = 123;
      h = 0.42;
      rough = 0.22;
      // A thin light line along the inlay's lower edge — on one panel per tile.
      if (wrap(x) >= 64 && wrap(x) < 192 && py >= 64 && py <= 65 && ix > 20) {
        r = 90;
        g = 214;
        b = 236;
        emis = 1;
        metal = 0;
        rough = 0.5;
      }
    } else if (ix > 12 && iy > 10 && chamfer > 36) {
      h = 0.78; // bright chamfered lip around the inlay
      r += 18;
      g += 18;
      b += 18;
    }
  } else {
    // Top/bottom bands: a raised sub-panel with three vertical flutes.
    const px = wrap(x) % 128;
    const inPanel = px > 18 && px < 110 && dRow > 16;
    if (inPanel) {
      h = 0.68;
      const flute = Math.abs(((px - 18) % 23) - 11.5);
      if (flute < 1.2) {
        h = 0.55;
        r -= 12;
        g -= 12;
        b -= 10;
      }
    }
  }

  // Seams: a dark groove with a lit bevel either side.
  if (edge < 2) {
    r = 30;
    g = 35;
    b = 44;
    h = 0.1;
    rough = 0.8;
    metal = 0.2;
    // Frost packed into the groove's bottom.
    if (dRow < 2 && tnoise(x, y, 32, 5) > 0.45) {
      r = 196;
      g = 208;
      b = 222;
      h = 0.18;
      rough = 0.9;
      metal = 0;
    }
  } else if (edge < 4) {
    h = 0.92;
    r += 22;
    g += 22;
    b += 24;
    rough = 0.25;
    // Wear: bright scratches chipped into the bevel.
    if (tnoise(x, y, 64, 9) > 0.72) {
      r += 28;
      g += 28;
      b += 28;
    }
  }

  // Grime streaking down from each horizontal seam, broken up per column.
  const streakCol = tnoise(x, 0, 64, 21) * tnoise(x, 7, 16, 23);
  const down = belowSeam(y, WALL_ROWS);
  const streak = streakCol > 0.35 ? Math.max(0, 1 - down / (20 + streakCol * 60)) * (streakCol - 0.35) * 2.2 : 0;
  const grime = Math.min(0.55, streak + Math.max(0, mottle) * 0.25);
  if (emis === 0) {
    r = r * (1 - grime * 0.45) + mottle * 14;
    g = g * (1 - grime * 0.45) + mottle * 14;
    b = b * (1 - grime * 0.4) + mottle * 12;
    rough = Math.min(1, rough + grime * 0.6);
    metal = Math.max(0, metal - grime * 0.4);
  }
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), h, rough, metal, emis };
}

function floorSurface(x: number, y: number): Surf {
  const d = Math.min(seamDistance(x, [0, 128]), seamDistance(y, [0, 128]));
  const px = wrap(x) % 128;
  const py = wrap(y) % 128;
  const plate = (wrap(x) >= 128 ? 1 : 0) + (wrap(y) >= 128 ? 2 : 0);
  const mottle = tfbm(x, y, 8, 31) - 0.5;
  let r = 104;
  let g = 110;
  let b = 122;
  let h = 0.6;
  let rough = 0.5;
  let metal = 0.7;
  let emis = 0;

  // Engraved border line inset on every plate.
  const inset = Math.min(px, 127 - px, py, 127 - py);
  if (inset >= 10 && inset <= 11) {
    r -= 26;
    g -= 26;
    b -= 22;
    h = 0.45;
  }
  // A chevron inlay on one plate per tile.
  if (plate === 1 && inset > 22) {
    const cx = px - 64;
    const cy = py - 64;
    const chev = Math.abs(Math.abs(cx) * 0.8 + cy * 0.9 - 6);
    if (chev < 3) {
      r -= 20;
      g -= 20;
      b -= 16;
      h = 0.46;
    }
  }
  // Faint horizontal grip striation on the other plates (kept low-contrast and
  // widely spaced, or it aliases into a grate at a distance).
  if (plate !== 1 && inset > 14 && py % 12 === 0) {
    r -= 5;
    g -= 5;
    b -= 5;
    h = 0.57;
  }

  if (d < 2.5) {
    r = 34;
    g = 38;
    b = 47;
    h = 0.1;
    rough = 0.85;
    metal = 0.2;
    if (tnoise(x, y, 32, 41) > 0.4) {
      // frost in the joints
      r = 200;
      g = 212;
      b = 226;
      h = 0.2;
      rough = 0.9;
      metal = 0;
    }
  } else if (d < 4.5) {
    h = 0.85;
    r += 16;
    g += 16;
    b += 18;
  }
  // Tiny cyan studs where the joints cross.
  const sx = seamDistance(x, [0, 128]);
  const sy = seamDistance(y, [0, 128]);
  if (Math.hypot(sx, sy) < 3.2) {
    r = 96;
    g = 220;
    b = 240;
    h = 0.5;
    emis = 1;
    metal = 0;
    rough = 0.4;
  }

  // Scuffs and wear: lighter smears, rougher.
  const scuff = tfbm(x * 1.0, y * 3.0, 16, 51);
  if (emis === 0) {
    const wear = Math.max(0, scuff - 0.6) * 2.5;
    r = r + wear * 26 + mottle * 16;
    g = g + wear * 26 + mottle * 16;
    b = b + wear * 24 + mottle * 14;
    rough = Math.min(1, rough + wear * 0.3 + Math.max(0, mottle) * 0.3);
  }
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), h, rough, metal, emis };
}

function snowSurface(x: number, y: number): Surf {
  const n = tfbm(x, y, 8, 61, 5);
  const fine = tnoise(x, y, 64, 67);
  const sparkle = thash(x, y, 71, TEX) > 0.996 ? 30 : 0;
  const v = 226 + (n - 0.5) * 30 + (fine - 0.5) * 10 + sparkle;
  return { r: clampByte(v - 8), g: clampByte(v - 3), b: clampByte(v + 6), h: n * 0.8 + fine * 0.2, rough: 0.88, metal: 0, emis: 0 };
}

interface BakedSurface {
  albedo: EncodedImage;
  normal: EncodedImage;
  metallicRoughness: EncodedImage;
  emissive: EncodedImage;
}

/** Bake one painted surface into its albedo, normal, metallic-roughness and emissive PNGs. */
function bakeSurface(surface: (x: number, y: number) => Surf, strength: number): BakedSurface {
  const samples: Surf[] = new Array(TEX * TEX);
  for (let y = 0; y < TEX; y += 1) for (let x = 0; x < TEX; x += 1) samples[y * TEX + x] = surface(x, y);
  const at = (x: number, y: number): Surf => samples[wrap(y) * TEX + wrap(x)]!;
  const albedo = new Uint8ClampedArray(TEX * TEX * 4);
  const normal = new Uint8ClampedArray(TEX * TEX * 4);
  const mr = new Uint8ClampedArray(TEX * TEX * 4);
  const emissive = new Uint8ClampedArray(TEX * TEX * 4);
  for (let y = 0; y < TEX; y += 1) {
    for (let x = 0; x < TEX; x += 1) {
      const o = (y * TEX + x) * 4;
      const s = at(x, y);
      albedo[o] = s.r;
      albedo[o + 1] = s.g;
      albedo[o + 2] = s.b;
      albedo[o + 3] = 255;
      // Tangent-space normal from the (wrapped) height gradient, z out of the surface.
      const nx0 = -(at(x + 1, y).h - at(x - 1, y).h) * strength;
      const ny0 = -(at(x, y + 1).h - at(x, y - 1).h) * strength;
      const len = Math.hypot(nx0, ny0, 1);
      normal[o] = Math.round((nx0 / len) * 127.5 + 127.5);
      normal[o + 1] = Math.round((ny0 / len) * 127.5 + 127.5);
      normal[o + 2] = Math.round((1 / len) * 127.5 + 127.5);
      normal[o + 3] = 255;
      mr[o] = 0;
      mr[o + 1] = clampByte(Math.max(0.06, s.rough) * 255);
      mr[o + 2] = clampByte(s.metal * 255);
      mr[o + 3] = 255;
      emissive[o] = Math.round(s.r * s.emis);
      emissive[o + 1] = Math.round(s.g * s.emis);
      emissive[o + 2] = Math.round(s.b * s.emis);
      emissive[o + 3] = 255;
    }
  }
  const png = (rgba: Uint8ClampedArray): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(rgba, TEX, TEX, { compress: true }) });
  return { albedo: png(albedo), normal: png(normal), metallicRoughness: png(mr), emissive: png(emissive) };
}

interface LockoutTextures {
  readonly wall: BakedSurface;
  readonly floor: BakedSurface;
  readonly snow: BakedSurface;
}
let bakedTextures: LockoutTextures | null = null;

/**
 * The arena's texture sets, baked on first use. Baking three 256² PBR sets costs
 * a few hundred milliseconds, and this module loads with the whole editor
 * package — so nothing pays for it until a Lockout cart actually needs its mesh.
 */
function lockoutTextures(): LockoutTextures {
  bakedTextures ??= {
    wall: bakeSurface(wallSurface, 2.6),
    floor: bakeSurface(floorSurface, 2.2),
    snow: bakeSurface(snowSurface, 1.2),
  };
  return bakedTextures;
}

// --- Map geometry ---------------------------------------------------------
// Coordinates: X right, Y up, Z forward. Symmetric in X/Z so the scene centre is
// exactly (0, CENTER_Y, 0).

// Lockout is an ASYMMETRIC, vertical Forerunner structure: a tall Sniper tower
// on one side, a two-storey BR structure diagonally opposite, a raised central
// walkway spanning a lower "bottom mid" where the Sword sits, and an enclosed
// Shotgun room off to one side, all over a recover floor. This is a homage to
// that massing (axis-aligned, so approximate), not a survey-accurate rip.

/** A flight of steps connecting two heights along one axis (the code's step-up
 *  lets the player and bots climb the ~0.5u risers). */
function steps(axis: "x" | "z", fixed: number, halfFixed: number, start: number, sign: 1 | -1, topFrom: number, topTo: number): Box[] {
  const n = Math.max(1, Math.round(Math.abs(topFrom - topTo) / 0.5));
  const rise = (topFrom - topTo) / n;
  const run = 0.85;
  const out: Box[] = [];
  for (let i = 0; i < n; i += 1) {
    const top = topFrom - rise * (i + 1);
    const pos = start + sign * (i + 0.5) * run;
    const hy = Math.max(0.05, top / 2);
    out.push(axis === "z" ? [fixed, top / 2, pos, halfFixed, hy, run / 2] : [pos, top / 2, fixed, run / 2, hy, halfFixed]);
  }
  return out;
}

// Named collider boxes. The physics uses these boxes exactly; the *visual* shell
// (see "The visual layer" below) is built from the same numbers but drawn as
// chamfered, battered and sloped Forerunner forms, so what you see and what you
// collide with stay within a few centimetres of each other.
const FLOOR: Box = [-1, -0.5, 0, 15, 0.5, 13]; // the arena deck (falling off it kills)
// Sniper tower (north-west): a stepped block climbed by straight, wide ramps —
// floor → the landing (T1) → west along its ramp to the mid tier (T2) → east up
// the next ramp onto the sniper deck (T3). Every ramp is 2.2-2.4 wide with room
// to turn at each end, so nobody (player or bot) edges along a ledge.
const T1: Box = [-7.85, 1.0, -5.0, 3.25, 1.0, 1.2]; // landing band (top 2.0)
const T2: Box = [-10.925, 2.25, -8.6, 2.125, 2.25, 2.4]; // mid tier (top 4.5)
const T3: Box = [-6.7, 3.5, -8.6, 2.1, 3.5, 2.4]; // sniper deck (top 7.0)
// BR structure (south-east): a lower deck (B1) and the BR top (B2) on its east
// half, joined by a straight ramp; the walkway's south spur meets the BR top.
const B1: Box = [7.8, 0.9, 8.3, 3.4, 0.9, 1.7]; // lower deck (top 1.8)
const B2: Box = [9.6, 2.0, 6.8, 1.6, 2.0, 3.2]; // BR top (top 4.0)
// Central raised walkway (the "bridge") over the bottom mid, with two spurs.
const SPAN: Box = [0, 3.4, 0, 1.6, 0.25, 6.5]; // top 3.65, running along Z
const SPUR_N: Box = [3.5, 3.4, -3, 3.5, 0.25, 1.4]; // toward the sniper tower
const SPUR_S: Box = [4, 3.4, 5, 4, 0.25, 1.4]; // on to the BR top
const BRIDGE_PYLONS: Box[] = [
  [0, 1.575, -5.2, 0.45, 1.575, 0.45], // the span rests on two pylons
  [0, 1.575, 5.2, 0.45, 1.575, 0.45],
];
// Bottom mid (the Sword pit): a low sunken platform with lips.
const PIT: Box = [0, 0.35, 0, 3.2, 0.35, 2.6]; // top 0.7
const PIT_WALLS: Box[] = [
  [0, 1.1, -2.7, 3.2, 0.5, 0.2],
  [0, 1.1, 2.7, 3.2, 0.5, 0.2],
];
// Shotgun room (south-west): a covered nook with a roof high enough to stand
// under (floor top 2.2, roof underside 4.1 — the player is 1.7 tall).
const SG_FLOOR: Box = [-9, 1.1, 6, 2.6, 1.1, 2.4];
const SG_ROOF: Box = [-9, 4.3, 6, 2.7, 0.2, 2.6];
const SG_BACK: Box = [-9, 3.15, 8.2, 2.7, 0.95, 0.2];
const SG_SIDE: Box = [-11.5, 3.15, 6, 0.2, 0.95, 2.6];
// Guard rails around the open sniper deck and the BR upper storey.
const RAILS: Box[] = [
  [-6.7, 7.3, -10.85, 2.1, 0.3, 0.15],
  [-4.75, 7.3, -8.6, 0.15, 0.3, 2.4],
  [9.6, 4.3, 9.85, 1.6, 0.3, 0.15],
];

/** A flight of steps (collision) that the visual layer draws as a smooth ramp. */
interface Flight {
  readonly axis: "x" | "z";
  readonly fixed: number;
  readonly halfFixed: number;
  readonly start: number;
  readonly sign: 1 | -1;
  readonly topFrom: number;
  readonly topTo: number;
}
const flight = (axis: "x" | "z", fixed: number, halfFixed: number, start: number, sign: 1 | -1, topFrom: number, topTo: number): Flight => ({
  axis, fixed, halfFixed, start, sign, topFrom, topTo,
});
const FLIGHTS: Flight[] = [
  flight("z", -5.7, 1.1, -3.8, 1, 2.0, 0), // floor -> the sniper tower's landing
  flight("x", -5.0, 1.2, -11.1, 1, 4.5, 2.0), // landing -> mid tier (climbs west)
  flight("x", -9.8, 1.2, -8.8, -1, 7.0, 4.5), // mid tier -> sniper deck (climbs east)
  flight("z", 6.0, 1.4, 6.6, -1, 1.8, 0), // floor -> the BR lower deck (under the spur)
  flight("x", 8.95, 1.05, 8.0, -1, 4.0, 1.8), // lower deck -> BR top (climbs east)
  flight("z", 0, 1.4, -7.0, -1, 3.65, 0), // walkway ends drop to the floor
  flight("z", 0, 1.4, 7.0, 1, 3.65, 0),
  flight("x", 6, 2.0, -6.4, 1, 2.2, 0), // floor -> shotgun room (climbs west into its open east side)
];
const flightSteps = (f: Flight): Box[] => steps(f.axis, f.fixed, f.halfFixed, f.start, f.sign, f.topFrom, f.topTo);

/** Every solid collider the cart's physics and shot occlusion test against. */
const STRUCT: Box[] = [
  FLOOR,
  T1, T2, T3,
  B1, B2,
  SPAN, SPUR_N, SPUR_S, ...BRIDGE_PYLONS,
  PIT, ...PIT_WALLS,
  SG_FLOOR, SG_ROOF, SG_BACK, SG_SIDE,
  ...RAILS,
  ...FLIGHTS.flatMap(flightSteps),
];

/** Emissive cyan trim (non-solid): thin Forerunner light strips + tower vents. */
const TRIM: Box[] = [
  // Tower vents: tall, thin glowing slits standing just proud of the wall.
  [-7.3, 5.3, -6.16, 0.07, 1.0, 0.04], // sniper-tower slits (T3, facing +Z)
  [-6.1, 5.3, -6.16, 0.07, 1.0, 0.04],
  [8.9, 2.8, 3.56, 0.07, 0.75, 0.04], // BR-tower slits (B2, facing -Z)
  [10.3, 2.8, 3.56, 0.07, 0.75, 0.04],
  // walkway edge lights: a thin strip down each long side
  [1.55, 3.67, 0, 0.05, 0.02, 6.3],
  [-1.55, 3.67, 0, 0.05, 0.02, 6.3],
  // sword-pit rim: a thin strip along each long edge
  [0, 0.72, 2.55, 3.1, 0.02, 0.05],
  [0, 0.72, -2.55, 3.1, 0.02, 0.05],
  [-9, 2.22, 3.65, 2.4, 0.02, 0.05], // shotgun-room threshold strip
];

/** Weapon-spawn markers (non-solid), cyan-lit cubes, at the sandbox spots. */
const MARKERS: Box[] = [
  [-6.7, 7.4, -8.6, 0.28, 0.4, 0.28], // Sniper — atop the tower
  [9.6, 4.4, 7.4, 0.28, 0.4, 0.28], // BR — atop the BR structure
  [-9, 2.6, 6, 0.28, 0.4, 0.28], // Shotgun — in the nook
  [0, 1.1, 0, 0.28, 0.4, 0.28], // Sword — the bottom-mid pit
  [0, 4.05, 0, 0.28, 0.4, 0.28], // SMG — on the central walkway
];
const MARKER_WEAPONS = ["sniper", "br", "shotgun", "sword", "smg"] as const;

// Every spawn stands in open space: the player's collider (radius 0.55, height
// 1.7) must not start inside a tower tier, or the view opens inside a wall.
const SPAWNS: ReadonlyArray<readonly [number, number, number]> = [
  [-4, 0, -9.5], // floor beside the sniper tower
  [-6.2, 7.0, -9.4], // sniper deck
  [2.3, 0, 8.3], // floor beside the BR structure
  [9.9, 4.0, 8.4], // BR top
  [0, 3.65, 0], // central walkway
  [0, 0.7, 0], // sword pit
  [-9, 0, 1.5], // outside the shotgun room
  [6, 0, -6], // floor
];

const BOT_COUNT = 7;

// --- Bot navigation graph ---------------------------------------------------
// Bots walk a hand-authored waypoint graph rather than colliding their way
// across the map: every node stands on a real walkable surface (floor, ramp
// centreline, tower ledge, walkway), every two-way link is walkable in a
// straight line, and one-way links are drops off a ledge. The cart finds routes
// over it (all-pairs next hop, precomputed at load) so bots climb the ramps to
// the sniper deck, the BR tower and the walkway instead of snapping to the
// nearest low platform. A test checks every node against the colliders.

/** Waypoints: [x, y (feet height), z]. */
const NAV_NODES: ReadonlyArray<readonly [number, number, number]> = [
  // 0-12: the floor ring
  [-14, 0, -11.8], [-14, 0, -4], [-14, 0, 2.5], [-14, 0, 11], [-8.5, 0, 11.2], [-3, 0, 11.5], [2.8, 0, 11.8],
  [12.6, 0, 11.5], [12.6, 0, 2.5], [12.6, 0, -5], [12.6, 0, -11.8], [5, 0, -11.5], [-3, 0, -11.5],
  // 13-21: the inner floor
  [-4.4, 0, 0], [4.4, 0, 0], [-9.2, 0, -0.4], [8, 0, 0.4], [-2.2, 0, 5.8], [4.4, 0, -7.5], [3, 0, 6.8],
  [-3.2, 0, -8], [-4.2, 0, 3],
  // 22-28: the walkway (feet of its ramps, ends, centre, spurs)
  [0, 0.1, -12.5], [0, 3.65, -6.2], [0, 3.65, 0], [0, 3.65, 6.2], [0, 0.1, 12.5], [6.4, 3.65, -3], [7, 3.65, 5],
  // 29-30: the Sword pit
  [-2.4, 0.7, 0], [2.4, 0.7, 0],
  // 31-42: the sniper tower: its floor ramp, landing, the two ramps, the deck
  [-5.7, 0, -0.9], [-5.7, 2, -5.0], [-7.3, 2, -5.0], [-10.7, 4, -5.0], [-10.7, 4.5, -7.4], [-12.4, 4.5, -7.4],
  [-12.4, 4.5, -9.8], [-9.2, 6.5, -9.8], [-7.6, 7, -9.8], [-6.7, 7, -6.9], [-5.4, 7, -10.2], [-6.4, 7, -8.4],
  // 43-49: the BR tower: floor ramp, lower deck, its ramp, the BR top
  [6, 0, 2.6], [6, 1.8, 7.2], [5, 1.8, 7.25], [5, 1.8, 8.95], [7.6, 3.45, 8.95], [9.6, 4, 8.9], [9.6, 4, 7],
  // 50-51: the shotgun room
  [-6.9, 2.2, 6], [-9.2, 2.2, 5.6],
  // 52-55: walkway junctions, a spur drop landing, the pass east of the tower
  [0, 3.65, -3], [0, 3.65, 5], [7.8, 0, -3], [-3.5, 0, -3],
  // 56: the middle of the Sword pit (the sword, and the ball's spawn)
  [0, 0.7, 0],
];

/** Two-way walkable links (node index pairs). */
const NAV_LINKS: ReadonlyArray<readonly [number, number]> = [
  // floor ring + inner floor
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 26], [26, 6], [7, 8], [8, 9], [9, 10], [10, 11],
  [11, 12], [12, 20], [11, 22], [12, 22], [2, 15], [2, 21], [15, 13], [13, 21], [13, 55], [55, 20],
  [14, 16], [14, 19], [14, 18], [16, 8], [16, 9], [18, 11], [18, 9], [19, 6], [19, 17], [17, 5],
  [54, 16], [54, 9], [54, 14],
  // walkway
  [22, 23], [23, 52], [52, 24], [24, 53], [53, 25], [25, 26], [52, 27], [53, 28],
  // pit
  [13, 29], [14, 30], [29, 30], [29, 56], [56, 30],
  // sniper tower
  [15, 31], [13, 31], [31, 32], [32, 33], [33, 34], [34, 35], [35, 36], [36, 37], [37, 38], [38, 39], [39, 42],
  [42, 40], [39, 41], [41, 42],
  // BR tower
  [16, 43], [43, 44], [44, 45], [45, 46], [46, 47], [47, 48], [48, 49], [49, 28],
  // shotgun room
  [17, 50], [50, 51],
];

/**
 * Jumps (two-way: up is a jump, back down a hop): gaps a player clears with a
 * jump, which the bots take on an arc. [lower, upper].
 */
const NAV_JUMPS: ReadonlyArray<readonly [number, number]> = [
  // None: every level is on foot since the towers' ramps were rebuilt. Kept so
  // a future map can mark a gap bots should jump.
];

/** Power positions bots like to hold: the sniper deck, the BR top, the walkway centre, the shotgun room. */
const NAV_POWER: readonly number[] = [42, 41, 49, 48, 24, 51];

/** One-way drops off a ledge: [from, to]. */
const NAV_DROPS: ReadonlyArray<readonly [number, number]> = [
  [27, 54], // off the end of the north spur
  [24, 30], // off the walkway into the pit
  [36, 1], // off the sniper tower's mid tier
  [49, 8], // off the BR tower
  [51, 2], // out of the shotgun room
];


// --- Mesh assembly --------------------------------------------------------

/** One full texture tile (its four panels) spans about `TILE_WORLD` units on any
 *  face, so panels read at a consistent size across the map. */
const TILE_WORLD = 7;
const UV = 1 / TILE_WORLD;

type V3 = readonly [number, number, number];

function boxesPrimitive(boxes: Box[], material: MeshPrimitive["material"], fixedRepeat?: number): MeshPrimitive {
  const s: Streams = newStreams();
  for (const [cx, cy, cz, hx, hy, hz] of boxes) {
    const r = fixedRepeat ?? Math.max(1, Math.round((Math.max(hx, hy, hz) * 2) / TILE_WORLD));
    pushBox(s, [cx, cy, cz], [hx, hy, hz], r);
  }
  return toPrimitive(s, material);
}

// --- The visual layer -------------------------------------------------------
// Lockout's look is its massing: battered (sloped) walls, chamfered corners,
// overhanging cornices, leaning blade-like fins and ramps instead of stairs, on
// a deck perched over a drop, with snow gathered on every ledge. These builders
// draw that over the collider boxes above, which stay the physics.

/** A chamfered prism over a box's footprint, from y0 to y1 (sides only by default). */
function prism(s: Streams, [cx, , cz, hx, , hz]: Box, y0: number, y1: number, chamfer: number, caps = { top: false, bottom: false }): void {
  pushLoft(s, chamferedRect(cx, cz, hx, hz, chamfer, y0), chamferedRect(cx, cz, hx, hz, chamfer, y1), UV, caps);
}

/**
 * A Forerunner tier: chamfered walls, a battered foot flaring out at the base
 * (it stays inside the player's collision radius, so feet never clip it), and an
 * overhanging cornice whose top face is the walkable roof.
 */
function tier(s: Streams, box: Box, opts: { batter?: number; cornice?: number; chamfer?: number } = {}): void {
  const [cx, cy, cz, hx, hy, hz] = box;
  const c = opts.chamfer ?? 0.55;
  const bottom = cy - hy;
  const top = cy + hy;
  const batter = opts.batter ?? 0;
  const lip = opts.cornice ?? 0.2;
  const footH = batter > 0 ? Math.min(0.9, (top - bottom) * 0.45) : 0;
  if (batter > 0) {
    pushLoft(s, chamferedRect(cx, cz, hx + batter, hz + batter, c + batter * 0.6, bottom), chamferedRect(cx, cz, hx, hz, c, bottom + footH), UV, { top: false, bottom: false });
  }
  const corniceH = 0.32;
  prism(s, box, bottom + footH, top - corniceH, c);
  // The cornice flares out to its lip, then its cap is the roof.
  pushLoft(s, chamferedRect(cx, cz, hx, hz, c, top - corniceH), chamferedRect(cx, cz, hx + lip, hz + lip, c + lip * 0.4, top), UV, { top: true, bottom: false });
}

/** A smooth ramp drawn over a flight of steps, level with each step's centre. */
function ramp(s: Streams, f: Flight): void {
  const n = Math.max(1, Math.round(Math.abs(f.topFrom - f.topTo) / 0.5));
  const rise = (f.topFrom - f.topTo) / n;
  const run = 0.85;
  const end = f.start + f.sign * n * run;
  const h0 = Math.max(0.02, f.topFrom - rise / 2);
  const h1 = Math.max(0.02, f.topTo + rise / 2 - rise); // one run past the last step centre
  const at = (along: number, across: number, y: number): V3 =>
    f.axis === "z" ? [f.fixed + across, y, along] : [along, y, f.fixed + across];
  const w = f.halfFixed;
  const bottom = [at(f.start, -w, 0), at(f.start, w, 0), at(end, w, 0), at(end, -w, 0)];
  const top = [at(f.start, -w, h0), at(f.start, w, h0), at(end, w, Math.max(0.02, h1)), at(end, -w, Math.max(0.02, h1))];
  pushLoft(s, bottom, top, UV, { top: true, bottom: false });
  // Low angled side skirts so the ramp reads as a machined piece, not a slab.
  for (const side of [-1, 1]) {
    // The skirt's inner face sits just inside the ramp, never coplanar with its
    // side (coplanar faces z-fight into a sawtooth).
    const xi = side * (w - 0.03);
    const x0 = side * (w + 0.12);
    pushLoft(
      s,
      [at(f.start, xi, 0), at(f.start, x0, 0), at(end, x0, 0), at(end, xi, 0)],
      [at(f.start, xi, h0 + 0.18), at(f.start, x0, h0 + 0.1), at(end, x0, 0.1), at(end, xi, 0.18)],
      UV,
      { top: true, bottom: false },
    );
  }
}

/**
 * A blade-like Forerunner fin rising from (x, y0, z) along direction (dx, dz):
 * thin, tapering to a point at y1, and leaning outward by `lean` — the silhouette
 * that makes a Forerunner tower read from across the map.
 */
function fin(s: Streams, x: number, z: number, dx: number, dz: number, y0: number, y1: number, length: number, lean: number): void {
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l;
  const uz = dz / l;
  const px = -uz * 0.16; // half thickness, perpendicular to the blade
  const pz = ux * 0.16;
  const base: V3[] = [
    [x - px, y0, z - pz],
    [x + ux * length - px, y0, z + uz * length - pz],
    [x + ux * length + px, y0, z + uz * length + pz],
    [x + px, y0, z + pz],
  ];
  const tx = x + ux * (lean + length * 0.25);
  const tz = z + uz * (lean + length * 0.25);
  const tipLen = length * 0.3;
  const tip: V3[] = [
    [tx - px * 0.5, y1, tz - pz * 0.5],
    [tx + ux * tipLen - px * 0.5, y1, tz + uz * tipLen - pz * 0.5],
    [tx + ux * tipLen + px * 0.5, y1, tz + uz * tipLen + pz * 0.5],
    [tx + px * 0.5, y1, tz + pz * 0.5],
  ];
  pushLoft(s, base, tip, UV);
}

/** A tapering octagonal column between two heights (pylons, canopy struts). */
function column(s: Streams, x0: number, z0: number, y0: number, r0: number, x1: number, z1: number, y1: number, r1: number): void {
  pushLoft(s, chamferedRect(x0, z0, r0, r0, r0 * 0.42, y0), chamferedRect(x1, z1, r1, r1, r1 * 0.42, y1), UV);
}

/**
 * Forerunner metal: the arena's walls, fins and canopy (`wall`), and everything
 * underfoot — the deck, ramps and walkway decks (`floor`) — which take the
 * darker deck-plate texture so walkable surfaces read apart from the walls.
 */
function structureStreams(): { wall: Streams; floor: Streams } {
  const s = newStreams();
  const f = newStreams();
  // The deck: a chamfered slab whose top is the arena floor.
  const [fx, , fz, fhx, , fhz] = FLOOR;
  pushLoft(f, chamferedRect(fx, fz, fhx, fhz, 1.2, -1), chamferedRect(fx, fz, fhx, fhz, 1.2, 0), UV, { top: true, bottom: false });

  // Sniper tower: three battered, corniced tiers and a crown of blades.
  tier(s, T1, { batter: 0.35, cornice: 0.22 });
  tier(s, T2, { cornice: 0.2 });
  tier(s, T3, { cornice: 0.25 });
  fin(s, -12.7, -10.7, -1, -1, 4.5, 11.4, 2.2, 1.0);
  fin(s, -4.9, -10.7, 0.3, -1, 7.0, 10.4, 1.8, 0.8);
  fin(s, -12.7, -6.5, -1, 0.3, 4.5, 10.0, 1.8, 0.8);

  // BR structure: two tiers under a slanted canopy on raked struts.
  tier(s, B1, { batter: 0.35, cornice: 0.22 });
  tier(s, B2, { cornice: 0.2 });
  const [bx, , bz, bhx, , bhz] = B2;
  // Struts on the east edge, clear of the ramp arriving on the west.
  column(s, bx + bhx - 0.3, bz + bhz - 0.3, 4.0, 0.2, bx + bhx - 0.1, bz + bhz - 0.1, 6.3, 0.14);
  column(s, bx + bhx - 0.3, bz - bhz + 0.3, 4.0, 0.2, bx + bhx - 0.1, bz - bhz + 0.1, 5.8, 0.14);
  pushLoft(
    s,
    [[bx - bhx - 0.3, 6.25, bz + bhz + 0.3], [bx + bhx + 0.3, 6.25, bz + bhz + 0.3], [bx + bhx + 0.3, 5.75, bz - bhz - 0.6], [bx - bhx - 0.3, 5.75, bz - bhz - 0.6]],
    [[bx - bhx - 0.3, 6.5, bz + bhz + 0.3], [bx + bhx + 0.3, 6.5, bz + bhz + 0.3], [bx + bhx + 0.3, 5.95, bz - bhz - 0.6], [bx - bhx - 0.3, 5.95, bz - bhz - 0.6]],
    UV,
  );
  fin(s, bx + bhx + 0.1, bz + bhz + 0.1, 1, 1, 1.8, 7.8, 1.9, 0.7);

  // The walkway: slabs with a tapered underside, on two flared pylons.
  for (const [cx, cy, cz, hx, hy, hz] of [SPAN, SPUR_N, SPUR_S]) {
    const top = cy + hy;
    const narrowX = hx < hz;
    const ix = narrowX ? Math.min(0.6, hx * 0.4) : 0.1;
    const iz = narrowX ? 0.1 : Math.min(0.6, hz * 0.4);
    // The south spur roofs the BR ramp, so its underside stays flat at the
    // collider's (a player climbing beneath must not see through it).
    const depth = cx === SPUR_S[0] && cz === SPUR_S[2] ? 2 * hy : 0.8;
    pushLoft(f, chamferedRect(cx, cz, hx - ix, hz - iz, 0.2, top - depth), chamferedRect(cx, cz, hx, hz, 0.25, top), UV);
  }
  for (const [x, , z] of BRIDGE_PYLONS) {
    column(s, x, z, 0, 0.62, x, z, 2.2, 0.45);
    column(s, x, z, 2.2, 0.45, x, z, 2.85, 0.7); // flared capital under the deck
  }
  // Leaning blade rails along both walkway edges.
  const [, sy, , shx, shy, shz] = SPAN;
  for (const side of [-1, 1]) {
    const x = side * shx;
    pushLoft(
      s,
      [[x, sy + shy, -shz + 0.4], [x, sy + shy, shz - 0.4], [x + side * 0.1, sy + shy, shz - 0.4], [x + side * 0.1, sy + shy, -shz + 0.4]],
      [[x + side * 0.12, sy + shy + 0.45, -shz + 0.9], [x + side * 0.12, sy + shy + 0.45, shz - 0.9], [x + side * 0.2, sy + shy + 0.45, shz - 0.9], [x + side * 0.2, sy + shy + 0.45, -shz + 0.9]],
      UV,
    );
  }

  // The Sword pit and its lips.
  tier(s, PIT, { cornice: 0.12, chamfer: 0.4 });
  for (const wall of PIT_WALLS) tier(s, wall, { cornice: 0.06, chamfer: 0.12 });

  // Shotgun room: floor tier, walls, and a roof whose front edge overhangs, sloped.
  tier(s, SG_FLOOR, { batter: 0.3, cornice: 0.15 });
  prism(s, SG_BACK, SG_BACK[1] - SG_BACK[4], SG_BACK[1] + SG_BACK[4], 0.08, { top: true, bottom: false });
  prism(s, SG_SIDE, SG_SIDE[1] - SG_SIDE[4], SG_SIDE[1] + SG_SIDE[4], 0.08, { top: true, bottom: false });
  const [rx, ry, rz, rhx, rhy, rhz] = SG_ROOF;
  pushLoft(
    s,
    chamferedRect(rx, rz, rhx, rhz, 0.3, ry - rhy),
    [[rx - rhx - 0.2, ry + rhy, rz - rhz - 0.7], [rx + rhx + 0.2, ry + rhy, rz - rhz - 0.7], [rx + rhx + 0.2, ry + rhy + 0.25, rz + rhz], [rx - rhx - 0.2, ry + rhy + 0.25, rz + rhz]],
    UV,
  );

  // Rails as low angled parapets.
  for (const rail of RAILS) prism(s, rail, rail[1] - rail[4], rail[1] + rail[4], 0.05, { top: true, bottom: false });

  // Ramps over every flight of steps.
  for (const flightOfSteps of FLIGHTS) ramp(f, flightOfSteps);
  return { wall: s, floor: f };
}

/** Darker structural metal: the deck's underside and the pylons into the mist. */
function undersideStreams(): Streams {
  const s = newStreams();
  const [fx, , fz, fhx, , fhz] = FLOOR;
  // An angled skirt under the deck edge…
  pushLoft(s, chamferedRect(fx, fz, fhx, fhz, 1.2, -1), chamferedRect(fx, fz, fhx - 3, fhz - 3, 2.4, -3.6), UV, { top: false, bottom: true });
  // …resting on four great tapered pylons that drop away into the valley mist.
  for (const [x, z] of [[-8, -7], [6, -7], [-8, 7], [6, 7]] as const) {
    column(s, x, z, -3.6, 1.6, x * 0.92, z * 0.92, -13, 0.7);
  }
  return s;
}

/** Deterministic 0..1 noise for the snow shapes. */
function snowRand(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** An irregular, softly domed snow patch lying on a surface at height y. */
function snowPatch(s: Streams, x: number, z: number, radius: number, y: number, seed: number): void {
  const sides = 9;
  const outer: V3[] = [];
  const inner: V3[] = [];
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2;
    const r = radius * (0.7 + 0.45 * snowRand(seed * 13 + i));
    outer.push([x + Math.cos(a) * r, y + 0.03, z + Math.sin(a) * r]); // clear of the deck: no z-fight
    inner.push([x + Math.cos(a) * r * 0.55, y + 0.09, z + Math.sin(a) * r * 0.55]);
  }
  pushLoft(s, outer, inner, UV, { top: true, bottom: false });
}

/** A drift banked against a wall: `along` the wall from a to b, sloping out by `depth`. */
function drift(s: Streams, ax: number, az: number, bx: number, bz: number, outX: number, outZ: number, y: number, height: number, depth: number): void {
  const bottom: V3[] = [
    [ax, y, az],
    [bx, y, bz],
    [bx + outX * depth, y, bz + outZ * depth],
    [ax + outX * depth, y, az + outZ * depth],
  ];
  const top: V3[] = [
    [ax + (bx - ax) * 0.08, y + height, az + (bz - az) * 0.08],
    [bx - (bx - ax) * 0.08, y + height, bz - (bz - az) * 0.08],
    [bx + outX * depth * 0.95, y + 0.01, bz + outZ * depth * 0.95],
    [ax + outX * depth * 0.95, y + 0.01, az + outZ * depth * 0.95],
  ];
  pushLoft(s, bottom, top, UV, { top: true, bottom: false });
}

/** Snow: caps on the roofs and fins, drifts against walls, patches on the deck. */
function snowStreams(): Streams {
  const s = newStreams();
  // Roof caps (surfaces nobody walks on) — mounded, inset from the edges.
  const cap = (cx: number, cz: number, hx: number, hz: number, y: number) =>
    pushLoft(s, chamferedRect(cx, cz, hx, hz, 0.3, y + 0.01), chamferedRect(cx, cz, hx * 0.85, hz * 0.8, 0.5, y + 0.14), UV, { top: true, bottom: false });
  const [rx, ry, rz, rhx, rhy, rhz] = SG_ROOF;
  cap(rx, rz - 0.3, rhx, rhz, ry + rhy + 0.12);
  const [bx, , bz, bhx, , bhz] = B2;
  cap(bx, bz, bhx, bhz * 0.9, 6.35);

  // Drifts banked against the tower bases on the deck, on their weather sides.
  const base = (box: Box, side: "-x" | "+x" | "-z" | "+z", y: number, height: number, depth: number, trim = 0.6) => {
    const [cx, , cz, hx, , hz] = box;
    const b = 0.35; // past the battered foot
    if (side === "-x") drift(s, cx - hx - b, cz - hz + trim, cx - hx - b, cz + hz - trim, -1, 0, y, height, depth);
    if (side === "+x") drift(s, cx + hx + b, cz - hz + trim, cx + hx + b, cz + hz - trim, 1, 0, y, height, depth);
    if (side === "-z") drift(s, cx - hx + trim, cz - hz - b, cx + hx - trim, cz - hz - b, 0, -1, y, height, depth);
    if (side === "+z") drift(s, cx - hx + trim, cz + hz + b, cx + hx - trim, cz + hz + b, 0, 1, y, height, depth);
  };
  base(T2, "-x", 0, 0.45, 1.1);
  base(T2, "-z", 0, 0.5, 1.2);
  base(T3, "-z", 0, 0.5, 1.2);
  base(B2, "+x", 0, 0.45, 1.1);
  base(B1, "+z", 0, 0.5, 1.2);
  base(SG_FLOOR, "-x", 0, 0.4, 0.9);
  // Snow gathered on the tower landings, against the tier above.
  drift(s, -6.7, -6.2, -4.9, -6.2, 0, 1, 2.0, 0.22, 0.5);
  drift(s, 8.0, 6.75, 8.0, 7.75, -1, 0, 1.8, 0.2, 0.45);
  // Patches scattered across the deck, thickest toward the exposed edges.
  const [fx, , fz, fhx, , fhz] = FLOOR;
  const patches: ReadonlyArray<readonly [number, number, number]> = [
    [fx - fhx + 1.6, fz - fhz + 1.8, 1.3], [fx + fhx - 1.8, fz - fhz + 1.6, 1.1],
    [fx - fhx + 1.5, fz + fhz - 1.7, 1.2], [fx + fhx - 1.6, fz + fhz - 1.9, 1.4],
    [fx - fhx + 1.2, fz - 1.5, 0.9], [fx + fhx - 1.1, fz + 2.5, 1.0],
    [fx + 3, fz - fhz + 1.1, 0.8], [fx - 4, fz + fhz - 1.0, 0.9],
    [5.5, -9.5, 0.7], [-3.5, 10.5, 0.6], [11.5, -1.5, 0.8],
  ];
  patches.forEach(([x, z, r], i) => snowPatch(s, x, z, r, 0, i + 1));
  // Rims of snow along the top of every fin-tipped roof edge are left to the
  // cornices' pale tops; the sniper deck's corners hold a little each.
  snowPatch(s, -9.6, -9.6, 0.45, 7.0, 40);
  snowPatch(s, -6.5, -9.6, 0.35, 7.0, 41);
  return s;
}

/** The arena's geometry, one stream set per material — cheap, so built eagerly. */
interface MapGeometry {
  readonly wall: Streams;
  readonly floor: Streams;
  readonly under: Streams;
  readonly snow: Streams;
  readonly trim: MeshPrimitive;
}
function mapGeometry(): MapGeometry {
  const structure = structureStreams();
  return {
    wall: structure.wall,
    floor: structure.floor,
    under: undersideStreams(),
    snow: snowStreams(),
    trim: boxesPrimitive([...TRIM, ...MARKERS], { name: "energy", baseColorFactor: [1, 1, 1, 1], baseColorImage: null }, 1),
  };
}
const MAP_GEOMETRY = mapGeometry();

function mapMesh(): MeshAsset {
  const tex = lockoutTextures();
  const WALL_TEX = tex.wall;
  const FLOOR_TEX = tex.floor;
  const SNOW_TEX = tex.snow;
  // PBR metallic-roughness: the panels are near-pure metal that mirrors the skybox,
  // normal-mapped for relief, with a baked emissive map for the cyan channel.
  const structMat: MeshPrimitive["material"] = {
    name: "forerunner",
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: WALL_TEX.albedo,
    normalImage: WALL_TEX.normal,
    metallicRoughnessImage: WALL_TEX.metallicRoughness,
    emissiveImage: WALL_TEX.emissive,
    metallicFactor: 0.6, // the map carries per-texel metal; this keeps albedo legible
    roughnessFactor: 1,
    emissiveFactor: [1.6, 1.6, 1.6], // push the baked glow above 1 so it blooms through the tone-map
  };
  const floorMat: MeshPrimitive["material"] = {
    name: "forerunner-deck",
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: FLOOR_TEX.albedo,
    normalImage: FLOOR_TEX.normal,
    metallicRoughnessImage: FLOOR_TEX.metallicRoughness,
    emissiveImage: FLOOR_TEX.emissive,
    metallicFactor: 0.4, // a deck is worn, not a mirror
    roughnessFactor: 1,
    emissiveFactor: [1.4, 1.4, 1.4],
  };
  // The wall metal, darker and without the glowing channel, for the underside.
  const underMat: MeshPrimitive["material"] = {
    ...structMat,
    name: "forerunner-underside",
    baseColorFactor: [0.5, 0.55, 0.62, 1],
    emissiveImage: null,
    emissiveFactor: [0, 0, 0],
  };
  // Packed snow: rough, non-metal and cold. Its albedo is held below white
  // because the rig's exposure lifts it — a white albedo blows out to flat paper.
  const snowMat: MeshPrimitive["material"] = {
    name: "snow",
    baseColorFactor: [0.7, 0.74, 0.8, 1],
    baseColorImage: SNOW_TEX.albedo,
    normalImage: SNOW_TEX.normal,
    metallicRoughnessImage: SNOW_TEX.metallicRoughness,
    metallicFactor: 0,
    roughnessFactor: 1,
  };
  // The energy trim + weapon markers: a flat, non-metal cyan emitter (HDR emissive
  // > 1 so it rolls off through ACES rather than clipping).
  const cyanMat: MeshPrimitive["material"] = {
    name: "energy",
    baseColorFactor: [0.28, 0.95, 1, 1],
    baseColorImage: null,
    metallicFactor: 0,
    roughnessFactor: 0.5,
    emissiveFactor: [0.5, 1.7, 1.9],
  };
  const g = MAP_GEOMETRY;
  return {
    name: "Lockout arena",
    primitives: [
      toPrimitive(g.wall, structMat),
      toPrimitive(g.floor, floorMat),
      toPrimitive(g.under, underMat),
      toPrimitive(g.snow, snowMat),
      { ...g.trim, material: cyanMat },
    ],
  };
}

// --- Characters & weapons ----------------------------------------------------
// Original designs: a generic armoured soldier and a small weapon sandbox, built
// from the same loft primitives as the arena. Every model faces +Z, so a pose's
// yaw (Y rotation) turns +Z toward the direction the cart's code faces.

type Mat = MeshPrimitive["material"];
type P3 = readonly [number, number, number];

/** A square-section prism from `a` to `b` (half-widths `w0` → `w1`) — limbs, barrels, blades. */
function limb(s: Streams, a: P3, b: P3, w0: number, w1 = w0, flat = 1): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const dl = Math.hypot(dx, dy, dz) || 1;
  const d: P3 = [dx / dl, dy / dl, dz / dl];
  // A side vector perpendicular to the axis (world up, or X for vertical axes).
  const ref: P3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = d[1] * ref[2] - d[2] * ref[1];
  let uy = d[2] * ref[0] - d[0] * ref[2];
  let uz = d[0] * ref[1] - d[1] * ref[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = uy * d[2] - uz * d[1];
  const vy = uz * d[0] - ux * d[2];
  const vz = ux * d[1] - uy * d[0];
  const ring = (c: P3, w: number): V3[] => [
    [c[0] + ux * w + vx * w * flat, c[1] + uy * w + vy * w * flat, c[2] + uz * w + vz * w * flat],
    [c[0] - ux * w + vx * w * flat, c[1] - uy * w + vy * w * flat, c[2] - uz * w + vz * w * flat],
    [c[0] - ux * w - vx * w * flat, c[1] - uy * w - vy * w * flat, c[2] - uz * w - vz * w * flat],
    [c[0] + ux * w - vx * w * flat, c[1] + uy * w - vy * w * flat, c[2] + uz * w - vz * w * flat],
  ];
  pushLoft(s, ring(a, w0), ring(b, w1), 1);
}

/** An axis-aligned block with chamfered vertical edges, optionally tapering toward its top. */
function block(s: Streams, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, chamfer = 0, taper = 0): void {
  pushLoft(
    s,
    chamferedRect(cx, cz, hx, hz, chamfer, cy - hy),
    chamferedRect(cx, cz, hx * (1 - taper), hz * (1 - taper), chamfer * (1 - taper), cy + hy),
    1,
  );
}

/**
 * Default armour paint. Every soldier (and the player's sleeves) shares one
 * mesh whose paint is `tintable`, so the cart recolours it per bot at runtime
 * through the pose tint — team colours in team modes, a colour per player in
 * Free for All — instead of storing a mesh per colour.
 */
const ARMOR_PAINT: readonly [number, number, number, number] = [0.45, 0.5, 0.56, 1];

/**
 * Drop texture coordinates from primitives that have no texture — the soldiers
 * and weapons are flat PBR colours, and UVs are a quarter of every vertex.
 */
function withoutUnusedUvs(mesh: MeshAsset): MeshAsset {
  return {
    name: mesh.name,
    primitives: mesh.primitives.map((p) =>
      p.material.baseColorImage || p.material.normalImage || p.material.metallicRoughnessImage || p.material.emissiveImage
        ? p
        : { ...p, uvs: null },
    ),
  };
}

/** Number of walk-cycle frames each soldier carries (pose frames 1..N). */
export const LOCKOUT_WALK_FRAMES = 4;

/** A point `length` down from `from`, swung forward by `angle` about the X axis. */
function swing(from: P3, length: number, angle: number): P3 {
  return [from[0], from[1] - length * Math.cos(angle), from[2] + length * Math.sin(angle)];
}

/**
 * An armoured soldier: team-paintable plates (helmet, chest, shoulders, thighs,
 * shins) over a dark undersuit, a mirrored gold visor, a backpack and a rifle
 * held at the ready. Feet at y = 0, facing +Z; roughly 1.85 tall so the cart's
 * eye height (1.5) sits at the visor.
 *
 * `phase` is the walk cycle (radians); null is the idle stance. Walking swings
 * each leg from the hip (opposite legs, opposite phase) and bends the knee of
 * the leg coming through, so a sequence of phases reads as a stride.
 */
function soldierMesh(phase: number | null): MeshAsset {
  const paint = newStreams();
  const suit = newStreams();
  const visor = newStreams();
  const gun = newStreams();
  for (const side of [-1, 1]) {
    const x = side * 0.13;
    const s = phase === null ? 0 : Math.sin(phase + (side > 0 ? Math.PI : 0));
    const c = phase === null ? 0 : Math.cos(phase + (side > 0 ? Math.PI : 0));
    const thigh = 0.42 * s; // hip swing, forward positive
    const knee = phase === null ? 0.05 : 0.12 + 0.45 * Math.max(0, c); // bend while the leg comes through
    const hip: P3 = [x * 1.05, 0.92, 0];
    const kneeAt = swing(hip, 0.42, thigh);
    const ankle = swing(kneeAt, 0.4, thigh - knee);
    limb(suit, hip, kneeAt, 0.12, 0.1); // thigh
    limb(paint, swing([hip[0], hip[1], hip[2] + 0.07], 0.12, thigh), swing([hip[0], hip[1], hip[2] + 0.07], 0.34, thigh), 0.075, 0.06, 0.5); // thigh plate
    block(paint, kneeAt[0], kneeAt[1], kneeAt[2] + 0.08, 0.06, 0.05, 0.03); // knee pad
    limb(suit, kneeAt, ankle, 0.085, 0.075); // shin
    limb(paint, swing([kneeAt[0], kneeAt[1], kneeAt[2] + 0.06], 0.08, thigh - knee), swing([kneeAt[0], kneeAt[1], kneeAt[2] + 0.06], 0.34, thigh - knee), 0.07, 0.06, 0.5); // shin guard
    block(suit, ankle[0], Math.max(0.06, ankle[1] - 0.02), ankle[2] + 0.03, 0.085, 0.06, 0.15); // boot
    // Shoulder pad, upper arm, and a forearm reaching forward to the rifle.
    block(paint, side * 0.31, 1.46, -0.01, 0.1, 0.075, 0.12, 0.05, 0.35);
    limb(suit, [side * 0.33, 1.42, 0], [side * 0.3, 1.12, 0.05], 0.065);
    limb(paint, [side * 0.3, 1.12, 0.05], [side * 0.1 + 0.06, 1.15, side < 0 ? 0.42 : 0.2], 0.06, 0.05);
    block(suit, side * 0.1 + 0.06, 1.15, side < 0 ? 0.44 : 0.22, 0.045, 0.045, 0.05); // glove
  }
  block(suit, 0, 0.94, 0, 0.21, 0.07, 0.13, 0.05); // belt / hips
  block(suit, 0, 1.07, 0, 0.18, 0.07, 0.12, 0.05); // abdomen
  // Chest: a plate widening toward the shoulders, with a raised front piece.
  pushLoft(paint, chamferedRect(0, 0, 0.23, 0.15, 0.07, 1.13), chamferedRect(0, 0.01, 0.28, 0.17, 0.09, 1.5), 1);
  block(paint, 0, 1.32, 0.16, 0.16, 0.13, 0.03, 0.05, 0.1);
  block(suit, 0, 1.28, -0.21, 0.17, 0.17, 0.06); // backpack
  block(suit, 0, 1.55, 0, 0.07, 0.05, 0.07); // neck
  // Helmet: a rounded crown over a jaw, with the visor set into its face.
  block(paint, 0, 1.69, 0, 0.13, 0.11, 0.15, 0.06, 0.18);
  block(paint, 0, 1.6, 0.05, 0.11, 0.04, 0.11, 0.04);
  pushLoft(visor, [[-0.1, 1.64, 0.145], [0.1, 1.64, 0.145], [0.1, 1.64, 0.1], [-0.1, 1.64, 0.1]], [[-0.095, 1.76, 0.13], [0.095, 1.76, 0.13], [0.095, 1.76, 0.09], [-0.095, 1.76, 0.09]], 1);
  // The rifle, held across the body.
  limb(gun, [0.06, 1.16, 0.0], [0.06, 1.16, 0.55], 0.035, 0.03, 1.6);
  limb(gun, [0.06, 1.18, 0.55], [0.06, 1.18, 0.78], 0.013);
  block(gun, 0.06, 1.24, 0.22, 0.02, 0.025, 0.1);
  const paintMat: Mat = { name: "armor", baseColorFactor: ARMOR_PAINT, baseColorImage: null, metallicFactor: 0.45, roughnessFactor: 0.4, tintable: true };
  return withoutUnusedUvs({
    name: phase === null ? "soldier" : `soldier-walk-${phase.toFixed(2)}`,
    primitives: [
      toPrimitive(paint, paintMat),
      toPrimitive(suit, { name: "undersuit", baseColorFactor: [0.2, 0.21, 0.24, 1], baseColorImage: null, metallicFactor: 0.3, roughnessFactor: 0.6 }),
      toPrimitive(visor, { name: "visor", baseColorFactor: [0.95, 0.7, 0.28, 1], baseColorImage: null, metallicFactor: 0.9, roughnessFactor: 0.12, emissiveFactor: [0.35, 0.22, 0.05] }),
      toPrimitive(gun, { name: "rifle", baseColorFactor: [0.2, 0.21, 0.23, 1], baseColorImage: null, metallicFactor: 0.7, roughnessFactor: 0.4 }),
    ],
  });
}

/** Weapon ids, in the order their viewmodel instances follow the bots in the sidecar. */
export const LOCKOUT_VIEWMODELS = ["br", "smg", "shotgun", "sniper", "magnum", "sword"] as const;
type WeaponId = (typeof LOCKOUT_VIEWMODELS)[number];

/**
 * A first-person weapon viewmodel: origin at the firing hand, barrel along +Z,
 * with gloved hands and armoured sleeves so it reads as held. Original designs.
 */
function viewmodelMesh(id: WeaponId): MeshAsset {
  const metal = newStreams();
  const poly = newStreams();
  const accent = newStreams();
  const glow = newStreams();
  const glove = newStreams();
  const sleeve = newStreams();
  const dark = newStreams();
  // A gloved hand wrapped round a grip: palm, three finger segments and a
  // thumb, with an armoured sleeve running back out of frame.
  const rightHand = (x: number, y: number, z: number) => {
    block(glove, x + 0.012, y, z - 0.01, 0.028, 0.045, 0.04, 0.012); // palm
    for (let f = 0; f < 3; f += 1) block(glove, x - 0.022, y + 0.025 - f * 0.026, z + 0.022, 0.014, 0.011, 0.02); // fingers
    limb(glove, [x + 0.03, y + 0.04, z - 0.02], [x + 0.005, y + 0.06, z + 0.04], 0.012); // thumb
    limb(sleeve, [x + 0.01, y - 0.03, z - 0.04], [x + 0.14, y - 0.2, z - 0.42], 0.045, 0.06);
    block(sleeve, x + 0.03, y - 0.06, z - 0.1, 0.05, 0.02, 0.05, 0.015); // wrist plate
  };
  const leftHand = (x: number, y: number, z: number) => {
    block(glove, x, y, z, 0.038, 0.028, 0.05, 0.012); // palm under the handguard
    for (let f = 0; f < 3; f += 1) block(glove, x + 0.035, y + 0.01, z - 0.03 + f * 0.028, 0.01, 0.022, 0.012); // fingers over the top
    limb(sleeve, [x - 0.02, y - 0.02, z - 0.04], [x - 0.3, y - 0.22, z - 0.34], 0.045, 0.06);
  };
  /** A trigger guard: a thin loop under the receiver ahead of the grip. */
  const triggerGuard = (y: number, z0: number, z1: number) => {
    limb(metal, [0, y, z0], [0, y - 0.035, z0], 0.005);
    limb(metal, [0, y - 0.035, z0], [0, y - 0.035, z1], 0.005);
    limb(metal, [0, y - 0.035, z1], [0, y, z1], 0.005);
    limb(dark, [0, y - 0.005, z0 + 0.012], [0, y - 0.026, z0 + 0.016], 0.004); // trigger
  };
  /** Ridges down a magazine (or a grip) so it reads as moulded, not a slab. */
  const ridges = (x: number, y0: number, z: number, count: number, step: number) => {
    for (let r = 0; r < count; r += 1) block(accent, x, y0 - r * step, z, 0.004, 0.005, 0.02);
  };
  if (id === "br") {
    limb(poly, [0, 0, -0.18], [0, 0.005, 0.24], 0.04, 0.035, 1.5); // bullpup body
    block(metal, 0, 0.05, 0.02, 0.028, 0.012, 0.19); // top rail
    for (let r = 0; r < 8; r += 1) block(dark, 0, 0.064, -0.13 + r * 0.045, 0.024, 0.003, 0.008); // rail teeth
    limb(accent, [0, 0.015, 0.2], [0, 0.015, 0.38], 0.032, 0.03, 1.3); // handguard
    for (let v = 0; v < 4; v += 1) block(dark, 0.031, 0.015, 0.23 + v * 0.04, 0.003, 0.012, 0.012); // vents
    limb(metal, [0, 0.03, 0.38], [0, 0.03, 0.56], 0.012); // barrel
    block(metal, 0, 0.03, 0.57, 0.018, 0.018, 0.02, 0.006); // muzzle brake
    block(dark, 0.02, 0.03, 0.57, 0.002, 0.006, 0.012);
    block(metal, 0, 0.09, 0.05, 0.018, 0.018, 0.1, 0.006); // scope tube
    block(metal, 0, 0.068, -0.01, 0.012, 0.012, 0.012); // scope rings
    block(metal, 0, 0.068, 0.11, 0.012, 0.012, 0.012);
    block(glow, 0, 0.09, 0.152, 0.012, 0.012, 0.003); // objective lens
    block(dark, 0, 0.09, -0.052, 0.01, 0.01, 0.003); // eyepiece (dark: it faces the eye)
    block(dark, 0.041, 0.01, 0.02, 0.002, 0.014, 0.05); // ejection port
    limb(poly, [0, -0.04, -0.07], [0, -0.14, -0.1], 0.022, 0.024, 1.4); // magazine (behind the grip)
    ridges(0.024, -0.07, -0.085, 4, 0.02);
    limb(poly, [0, -0.03, 0.05], [0, -0.11, 0.03], 0.018, 0.02, 1.3); // grip
    triggerGuard(-0.03, 0.08, 0.14);
    block(poly, 0, -0.005, -0.19, 0.036, 0.045, 0.012, 0.01); // butt plate
    rightHand(0.0, -0.08, 0.04);
    leftHand(-0.01, -0.01, 0.3);
  } else if (id === "smg") {
    block(poly, 0, 0, 0.05, 0.035, 0.045, 0.14, 0.012);
    block(metal, 0, 0.05, 0.05, 0.03, 0.008, 0.14); // top cover
    block(accent, 0, 0.062, 0.04, 0.012, 0.01, 0.11); // sight rail
    block(metal, 0, 0.085, -0.06, 0.01, 0.015, 0.006); // rear sight
    block(metal, 0, 0.08, 0.15, 0.006, 0.012, 0.006); // front post
    limb(metal, [0, 0.015, 0.19], [0, 0.015, 0.3], 0.016); // barrel
    block(dark, 0, 0.015, 0.305, 0.008, 0.008, 0.004); // bore
    block(dark, 0.036, 0.015, 0.06, 0.002, 0.012, 0.035); // ejection port
    limb(poly, [0, -0.04, 0.13], [0, -0.22, 0.17], 0.018, 0.02, 1.8); // long magazine
    ridges(0.02, -0.07, 0.14, 6, 0.022);
    limb(poly, [0, -0.04, -0.02], [0, -0.12, -0.04], 0.018, 0.02, 1.3); // grip
    triggerGuard(-0.04, 0.0, 0.06);
    limb(metal, [0, 0.0, -0.09], [0, -0.03, -0.2], 0.008); // folded stock strut
    block(glow, 0, 0.07, 0.0, 0.006, 0.006, 0.006); // ammo counter
    rightHand(0, -0.08, -0.03);
    leftHand(-0.005, -0.15, 0.16);
  } else if (id === "shotgun") {
    limb(metal, [0, 0.02, 0.0], [0, 0.02, 0.6], 0.024); // barrel
    block(dark, 0, 0.02, 0.602, 0.016, 0.016, 0.003); // bore
    limb(metal, [0, -0.025, 0.05], [0, -0.025, 0.52], 0.018); // magazine tube
    block(metal, 0, -0.002, 0.5, 0.02, 0.03, 0.012); // barrel band
    limb(accent, [0, -0.02, 0.25], [0, -0.02, 0.42], 0.036, 0.034); // pump
    for (let g = 0; g < 5; g += 1) block(dark, 0, -0.056, 0.27 + g * 0.03, 0.02, 0.003, 0.006); // pump grooves
    block(poly, 0, 0, -0.04, 0.035, 0.05, 0.1, 0.012); // receiver
    block(dark, 0.036, 0.01, -0.03, 0.002, 0.015, 0.04); // loading port
    block(metal, 0, 0.048, 0.58, 0.004, 0.01, 0.006); // bead sight
    limb(poly, [0, -0.02, -0.14], [0, -0.07, -0.34], 0.03, 0.04, 1.6); // stock
    block(accent, 0, -0.075, -0.345, 0.03, 0.045, 0.012); // recoil pad
    triggerGuard(-0.05, -0.06, 0.0);
    rightHand(0, -0.07, -0.08);
    leftHand(-0.01, -0.05, 0.33);
  } else if (id === "sniper") {
    block(poly, 0, 0, 0.0, 0.034, 0.045, 0.2, 0.012);
    block(accent, 0, 0.05, 0.0, 0.028, 0.008, 0.18); // receiver top
    limb(metal, [0, 0.02, 0.2], [0, 0.02, 0.78], 0.016, 0.013); // long barrel
    for (let f = 0; f < 5; f += 1) block(dark, 0.014, 0.02, 0.3 + f * 0.08, 0.002, 0.004, 0.025); // barrel fluting
    block(metal, 0, 0.02, 0.8, 0.022, 0.022, 0.03, 0.008); // muzzle brake
    block(dark, 0.022, 0.02, 0.8, 0.002, 0.012, 0.018);
    limb(metal, [0, 0.1, -0.08], [0, 0.1, 0.2], 0.03, 0.034); // big scope
    block(metal, 0, 0.1, 0.02, 0.018, 0.018, 0.02); // turret
    block(metal, 0, 0.066, -0.04, 0.014, 0.02, 0.012); // scope mounts
    block(metal, 0, 0.066, 0.14, 0.014, 0.02, 0.012);
    block(glow, 0, 0.1, 0.206, 0.024, 0.024, 0.004); // objective lens
    block(dark, 0, 0.1, -0.084, 0.02, 0.02, 0.003); // eyepiece (dark: it faces the eye)
    limb(metal, [0.02, -0.03, 0.38], [0.03, -0.1, 0.46], 0.006); // folded bipod legs
    limb(metal, [-0.02, -0.03, 0.38], [-0.03, -0.1, 0.46], 0.006);
    limb(poly, [0, -0.03, -0.2], [0, -0.07, -0.36], 0.03, 0.038, 1.6); // stock
    block(accent, 0, -0.02, -0.28, 0.032, 0.014, 0.05); // cheek rest
    limb(poly, [0, -0.04, 0.1], [0, -0.13, 0.08], 0.018, 0.02, 1.3); // grip
    triggerGuard(-0.045, 0.12, 0.18);
    rightHand(0, -0.1, 0.08);
    leftHand(-0.01, -0.03, 0.34);
  } else if (id === "magnum") {
    block(metal, 0, 0.03, 0.08, 0.02, 0.028, 0.12, 0.008); // slide
    for (let g = 0; g < 5; g += 1) block(dark, 0.021, 0.035, -0.02 + g * 0.012, 0.002, 0.018, 0.003); // slide serrations
    block(dark, 0.021, 0.04, 0.1, 0.002, 0.01, 0.025); // ejection port
    limb(metal, [0, 0.025, 0.2], [0, 0.025, 0.24], 0.011); // muzzle
    block(dark, 0, 0.025, 0.242, 0.006, 0.006, 0.002);
    block(poly, 0, -0.005, 0.1, 0.018, 0.012, 0.09); // frame + dust-cover
    limb(poly, [0, 0.0, 0.0], [0, -0.1, -0.04], 0.02, 0.022, 1.3); // grip
    ridges(0.021, -0.02, -0.02, 4, 0.02);
    block(accent, 0, 0.065, 0.05, 0.006, 0.006, 0.06); // sight rail
    block(glow, 0, 0.07, 0.19, 0.003, 0.004, 0.003); // front sight dot
    triggerGuard(-0.02, 0.02, 0.07);
    rightHand(0, -0.05, -0.01);
  } else {
    // An original energy blade: a curved hilt and two glowing, tapering prongs.
    limb(metal, [0, -0.1, -0.02], [0, 0.02, 0.02], 0.03, 0.028, 1.4); // hilt
    for (let g = 0; g < 4; g += 1) block(dark, 0.029, -0.08 + g * 0.028, -0.01 + g * 0.009, 0.003, 0.008, 0.02); // grip bands
    limb(accent, [-0.05, 0.02, 0.02], [0.05, 0.02, 0.02], 0.02); // guard
    block(accent, 0, 0.035, 0.03, 0.04, 0.012, 0.03, 0.01); // emitter housing
    block(glow, 0, 0.05, 0.03, 0.03, 0.004, 0.02); // emitter glow
    for (const side of [-1, 1]) {
      limb(glow, [side * 0.04, 0.03, 0.03], [side * 0.03, 0.2, 0.34], 0.012, 0.018, 0.35);
      limb(glow, [side * 0.03, 0.2, 0.34], [side * 0.005, 0.3, 0.62], 0.018, 0.001, 0.35);
    }
    rightHand(0, -0.05, 0.0);
  }
  const glowColor: readonly [number, number, number, number] = id === "sword" ? [0.45, 0.85, 1, 1] : [0.3, 0.9, 1, 1];
  const primitives: MeshPrimitive[] = [
    toPrimitive(metal, { name: "gunmetal", baseColorFactor: [0.42, 0.45, 0.5, 1], baseColorImage: null, metallicFactor: 0.8, roughnessFactor: 0.3 }),
    toPrimitive(poly, { name: "polymer", baseColorFactor: [0.2, 0.21, 0.23, 1], baseColorImage: null, metallicFactor: 0.15, roughnessFactor: 0.5 }),
    toPrimitive(accent, { name: "accent", baseColorFactor: [0.42, 0.46, 0.38, 1], baseColorImage: null, metallicFactor: 0.5, roughnessFactor: 0.42 }),
    toPrimitive(glove, { name: "glove", baseColorFactor: [0.12, 0.12, 0.13, 1], baseColorImage: null, metallicFactor: 0.05, roughnessFactor: 0.8 }),
    toPrimitive(sleeve, { name: "sleeve", baseColorFactor: ARMOR_PAINT, baseColorImage: null, metallicFactor: 0.45, roughnessFactor: 0.4, tintable: true }),
    toPrimitive(dark, { name: "recess", baseColorFactor: [0.05, 0.05, 0.06, 1], baseColorImage: null, metallicFactor: 0.3, roughnessFactor: 0.7 }),
  ];
  if (glow.indices.length > 0) {
    primitives.push(
      toPrimitive(glow, {
        name: "glow",
        baseColorFactor: glowColor,
        baseColorImage: null,
        metallicFactor: 0,
        roughnessFactor: 0.4,
        emissiveFactor: id === "sword" ? [0.9, 2.0, 2.6] : [0.5, 1.6, 1.9],
      }),
    );
  }
  return withoutUnusedUvs({ name: `viewmodel-${id}`, primitives: primitives.filter((p) => p.indices.length > 0) });
}


/**
 * Viewmodels are authored at 1/1000 scale at the origin — invisible (and inside
 * the arena's bounds) unless posed. The cart poses only the weapon in hand,
 * scaled back up by this factor, so six guns share one pose slot.
 */
const VIEWMODEL_REST_SCALE = 0.001;

/** The scene's bounding-box centre over every vertex of the arena mesh (the bots
 *  are authored at the origin, inside this footprint, so they never extend it).
 *  The camera's target offset is relative to this, so it must match the runtime's
 *  own `parseMeshScene` bounds — a test pins all three axes. */
function sceneCenter(): [number, number, number] {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  const g = MAP_GEOMETRY;
  for (const p of [g.wall.positions, g.floor.positions, g.under.positions, g.snow.positions, g.trim.positions]) {
    for (let i = 0; i < p.length; i += 3) {
      mnx = Math.min(mnx, p[i]!); mny = Math.min(mny, p[i + 1]!); mnz = Math.min(mnz, p[i + 2]!);
      mxx = Math.max(mxx, p[i]!); mxy = Math.max(mxy, p[i + 1]!); mxz = Math.max(mxz, p[i + 2]!);
    }
  }
  return [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
}
const CENTER = sceneCenter();
export const LOCKOUT_CENTER_X = CENTER[0];
export const LOCKOUT_CENTER_Y = CENTER[1];
export const LOCKOUT_CENTER_Z = CENTER[2];

/**
 * The authored Modern-tier lighting rig: a cool Forerunner skybox (image-based
 * lighting the metals reflect), a warm-white directional key with a cooler fill,
 * a cyan point light down in the Sword pit, ACES tone mapping so the emissive
 * energy and specular highlights roll off instead of clipping, and directional
 * shadows the towers and bridge cast onto the floor.
 */
export const LOCKOUT_LIGHTING: SceneLighting = {
  environment: {
    sky: [0.42, 0.56, 0.8],
    horizon: [0.55, 0.66, 0.74],
    ground: [0.2, 0.22, 0.26],
    // The baked sky dome (below) is the environment map, and it is far brighter
    // than the gradient it replaced, so its intensity sits well under 1: the sky
    // fills the shadows with cold blue, and the sun does the modelling.
    intensity: 0.6,
  },
  ambient: 0.45,
  exposure: 1.0,
  tonemap: true,
  shadows: true,
  lights: [
    // Key: a low-ish, warm-white sun, strong enough that shadows read clearly
    // (direction points *towards* the light).
    { kind: "directional", direction: [0.45, 0.62, -0.5], color: [1, 0.95, 0.86], intensity: 2.3 },
    // Fill: a faint cold bounce from the opposite side so shadows aren't black.
    { kind: "directional", direction: [-0.5, 0.35, 0.55], color: [0.5, 0.62, 0.8], intensity: 0.35 },
    // The Sword pit's cyan glow, at the bottom-mid centre.
    { kind: "point", position: [0, 0.9, 0], color: [0.4, 0.95, 1], intensity: 2.4, range: 4.5 }, // kept in the pit, off the walkway above
  ],
  // A procedural alpine dome (original art, baked at load): a cold overcast sky
  // over two rings of snow-capped peaks, with a misty glacier valley far below —
  // the arena reads as a facility perched high in the mountains. The same bake
  // is the image-based light, so the metal panels reflect these clouds.
  sky: {
    zenith: [0.3, 0.41, 0.58],
    horizon: [0.78, 0.83, 0.89],
    below: [0.66, 0.72, 0.8],
    sunDirection: [0.45, 0.62, -0.5], // matches the key light
    sunColor: [1, 0.95, 0.85],
    clouds: 0.62,
    cloudColor: [0.9, 0.93, 0.97],
    mountains: [
      { height: 8, peaks: 11, rock: [0.44, 0.49, 0.57], snow: [0.88, 0.92, 0.97], snowLine: 0.25, haze: 0.55, seed: 11 },
      { height: 15, peaks: 7, rock: [0.24, 0.27, 0.32], snow: [0.93, 0.95, 0.98], snowLine: 0.42, haze: 0.18, seed: 29 },
    ],
    seed: 7,
  },
  // Cold haze that thickens across the arena, tinted to the horizon.
  // Kept light: the arena is only ~30 units across, so heavy fog just washes it out.
  fog: { color: [0.74, 0.8, 0.87], density: 0.02, start: 12, max: 0.35 },
};

/**
 * The arena's post-FX stack — the cold Halo-era grade: bloom so the cyan energy
 * and sun-lit snow glow past their edges, a touch more contrast and a touch less
 * saturation, a split tone that pushes shadows toward steel blue while keeping
 * highlights a pale, slightly warm white, and a faint vignette. The player's
 * `PostFxSettings` shape as plain JSON; every effect not named stays off.
 */
export const LOCKOUT_FX = {
  enabled: { bloom: true, grade: true, splittone: true, vignette: true },
  values: {
    // Calibrated against the player's real bloom pyramid (HDR, multi-scale):
    // just the brightest glow — cyan trim, sun-lit snow — past threshold, and a
    // hair of brightness back, so the frame sits where the grade was designed.
    "bloom.strength": 0.2,
    "bloom.threshold": 0.9,
    "bloom.radius": 0.55,
    "grade.brightness": 0.95,
    "grade.contrast": 1.12,
    "grade.saturation": 0.85,
    "splittone.strength": 0.28,
    "splittone.balance": 0.45,
    "vignette.strength": 0.18,
  },
  colors: {
    "splittone.shadows": "#5a6c8e", // ×2 in the shader: mid-grey is neutral, so this cools shadows
    "splittone.highlights": "#86827a", // …and this warms highlights only slightly
  },
} as const;

let meshSidecar: string | null = null;

/**
 * The arena's mesh sidecar (map + 7 bots + the lighting rig), built on first
 * call and memoised — it carries the baked textures, see {@link lockoutTextures}.
 */
export function lockoutMeshSidecar(): string {
  if (meshSidecar === null) {
    const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const rest = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [VIEWMODEL_REST_SCALE, VIEWMODEL_REST_SCALE, VIEWMODEL_REST_SCALE] };
    // One soldier mesh (tinted per bot at runtime) plus its walk-cycle frames,
    // stored once in the sidecar's shared library however many bots use it.
    const soldier = serializeMeshAsset(soldierMesh(null));
    const walk = Array.from({ length: LOCKOUT_WALK_FRAMES }, (_, k) =>
      serializeMeshAsset(soldierMesh((k / LOCKOUT_WALK_FRAMES) * Math.PI * 2)),
    );
    const meshes: { id: string; name: string; mesh: string; frames?: string[]; transform: unknown }[] = [
      { id: "lockout-map", name: "Lockout arena", mesh: serializeMeshAsset(mapMesh()), transform: identity },
    ];
    // Instances 1..7: the bots.
    for (let i = 1; i <= BOT_COUNT; i += 1) {
      meshes.push({ id: `bot-${i}`, name: `bot ${i}`, mesh: soldier, frames: walk, transform: identity });
    }
    // Instances 8..13: one first-person viewmodel per weapon, at rest scale.
    for (const id of LOCKOUT_VIEWMODELS) {
      meshes.push({ id: `viewmodel-${id}`, name: `viewmodel ${id}`, mesh: serializeMeshAsset(viewmodelMesh(id)), transform: rest });
    }
    const packed = packMeshLibrary(meshes);
    meshSidecar = JSON.stringify({ version: 2, meshes: packed.entries, library: packed.library, lighting: LOCKOUT_LIGHTING });
  }
  return meshSidecar;
}

export const LOCKOUT_SCENE_TRIANGLES = (() => {
  const g = MAP_GEOMETRY;
  const map =
    [g.wall, g.floor, g.under, g.snow].reduce((n, st) => n + st.indices.length / 3, 0) + g.trim.indices.length / 3;
  const bot = soldierMesh(null).primitives.reduce((n, p) => n + p.indices.length / 3, 0);
  return map + bot * BOT_COUNT;
})();

// --- The cart code --------------------------------------------------------

function collidersLua(): string {
  const nums: number[] = [];
  for (const [cx, cy, cz, hx, hy, hz] of STRUCT) nums.push(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz);
  return nums.map((n) => n.toFixed(2)).join(",");
}
function spawnsLua(): string {
  return SPAWNS.flat().map((n) => n.toFixed(2)).join(",");
}
function navLua(): string {
  const nodes = NAV_NODES.flat().map((n) => n.toFixed(2)).join(",");
  const links = NAV_LINKS.flat().map((n) => n + 1).join(","); // Lua is 1-based
  const drops = NAV_DROPS.flat().map((n) => n + 1).join(",");
  const jumps = NAV_JUMPS.flat().map((n) => n + 1).join(",");
  const power = NAV_POWER.map((n) => n + 1).join(",");
  return `local NAVN = {${nodes}}\nlocal NAVL = {${links}}\nlocal NAVD = {${drops}}\nlocal NAVJ = {${jumps}}\nlocal POWER = {${power}}`;
}
function markersLua(): string {
  return MARKERS.map(([cx, cy, cz]) => `${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)}`).join(",");
}
function markerWeaponsLua(): string {
  return MARKER_WEAPONS.map((w) => `"${w}"`).join(",");
}

export const LOCKOUT_CODE = `-- title:  Lockout arena
-- author: you
-- desc:   A vertical Forerunner-arena FPS homage -- you + 7 bots, 7 game types, Xbox 360 core
-- script: lua

-- Cartbox has no netcode, so "8 players" is you + 7 AI bots in one local match.
-- The web player forwards only 8 buttons (arrows + Z X A S), so this is a
-- single-stick console FPS with vertical auto-aim:
--   Up/Down move . Left/Right turn . hold A strafe . double-tap A = grenade
--   Z fire (auto-melee point-blank) . X jump . S swap weapon
--   menu: Up/Down pick . Z start   |   sniper: hold A still to zoom

local CENTER_X = ${LOCKOUT_CENTER_X.toFixed(4)}
local CENTER_Y = ${LOCKOUT_CENTER_Y.toFixed(4)}
local CENTER_Z = ${LOCKOUT_CENTER_Z.toFixed(4)}
local COL = {${collidersLua()}}
local SPN = {${spawnsLua()}}
local MRK = {${markersLua()}}
local MW  = {${markerWeaponsLua()}}
local NBOT = ${BOT_COUNT}
${navLua()}

-- ---------------------------------------------------------------------------
-- Weapon sandbox. dmg per shot, cool = frames between shots, rng world units,
-- hs = headshot multiplier, mag/pel/spr = clip/pellets/spread, auto = hold to
-- fire, reserve = spare rounds. A Forerunner homage sandbox, not Halo's numbers.
local W = {
  br      = { name="Battle Rifle",  dmg=17, cool=9,  rng=64, hs=1.7, mag=36, pel=1, spr=0.02, auto=false, reserve=108 },
  smg     = { name="SMG",           dmg=7,  cool=3,  rng=26, hs=1.2, mag=60, pel=1, spr=0.05, auto=true,  reserve=180 },
  shotgun = { name="Shotgun",       dmg=12, cool=22, rng=12, hs=1.0, mag=6,  pel=8, spr=0.14, auto=false, reserve=24 },
  sniper  = { name="Sniper Rifle",  dmg=80, cool=44, rng=150,hs=3.0, mag=4,  pel=1, spr=0.0,  auto=false, reserve=12, zoom=true },
  magnum  = { name="Magnum",        dmg=20, cool=13, rng=42, hs=2.0, mag=12, pel=1, spr=0.012,auto=false, reserve=48 },
  sword   = { name="Energy Sword",  dmg=220,cool=20, rng=3.2,hs=1.0, mag=99, pel=1, spr=0.0,  auto=false, reserve=0, melee=true },
}

-- Game types. teams/shields/radar toggle the rules; obj names the objective
-- ("slayer" = kills); target is the score that ends the match.
local MODES = {
  ffa    = { name="Free for All",  obj="slayer", teams=false, shields=true,  radar=true,  start="br",     target=15, weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  slayer = { name="Team Slayer",   obj="slayer", teams=true,  shields=true,  radar=true,  start="br",     target=40, weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  swat   = { name="SWAT",          obj="slayer", teams=true,  shields=false, radar=false, start="br",     target=40, weapons={} },
  snipe  = { name="Team Snipers",  obj="slayer", teams=true,  shields=true,  radar=false, start="sniper", target=25, weapons={} },
  ball   = { name="Oddball",       obj="ball",   teams=false, shields=true,  radar=true,  start="magnum", target=100,weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  koth   = { name="King of the Hill",obj="hill", teams=false, shields=true,  radar=true,  start="br",     target=100,weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  jugg   = { name="Juggernaut",    obj="jugg",   teams=false, shields=true,  radar=true,  start="magnum", target=15, weapons={br=true,shotgun=true,sniper=true,sword=true} },
}
local MODE_KEYS = {"ffa","slayer","swat","snipe","ball","koth","jugg"}

-- Hill locations King-of-the-Hill rotates through (the named power positions).
local HILL_MOVE = 1800   -- the hill moves every 30s
local HILLS = { {0,3.65,0}, {-6.7,7.0,-8.6}, {9.6,4.0,7.2}, {0,0.7,0}, {-9,2.2,6} }

local PR,PH,EYE,STEP = 0.55,1.7,1.5,0.6
local GRAV,MOVE,JUMP,TURN = 0.028,0.15,0.5,0.045

local phase = "menu"
local sel = 1
local MODE = MODES.ffa
local p = nil
local bots = {}
local team = { blue=0, red=0 }
local mtimer = {}
local grenades = {}
local feed = {}          -- kill feed: {text,color,t}
local announce = {t=0, text="", color=12}
local winner = ""
local prev = {}
local bob = 0
local flash = 0
local tick = 0
local ball = { x=0,y=0,z=0, carrier=nil, live=false }
local hill = { x=0,y=0,z=0, next=0, idx=1 }
local shot = {t=0, x=0, y=0, z=0}   -- last shot tracer for a beam flash

-- ---------------------------------------------------------------------------
local function ncol() return #COL // 6 end
local function edge(k, held) local was = prev[k]; prev[k] = held; return held and not was end
local function clamp(v,a,b) if v<a then return a elseif v>b then return b else return v end end
local function d3(ax,ay,az,bx,by,bz) return math.sqrt((ax-bx)^2+(ay-by)^2+(az-bz)^2) end

-- Segment vs every solid collider: true if the shot from A to B hits a wall
-- before maxt (world units). Slab test per box, nearest hit kept -- this is
-- what stops shots (yours and the bots') passing through the Forerunner walls.
function seg_blocked(x0,y0,z0, x1,y1,z1, maxt)
  local dx,dy,dz = x1-x0, y1-y0, z1-z0
  for i=0,ncol()-1 do
    local b=i*6
    local tmin,tmax = 0.0, 1.0
    local ok = true
    local lo,hi
    for a=1,3 do
      local o = (a==1) and x0 or (a==2) and y0 or z0
      local d = (a==1) and dx or (a==2) and dy or dz
      lo = COL[b+a]; hi = COL[b+a+3]
      if math.abs(d) < 1e-6 then
        if o < lo or o > hi then ok=false break end
      else
        local t1=(lo-o)/d; local t2=(hi-o)/d
        if t1>t2 then t1,t2=t2,t1 end
        if t1>tmin then tmin=t1 end
        if t2<tmax then tmax=t2 end
        if tmin>tmax then ok=false break end
      end
    end
    if ok and tmin>0.02 and tmin*1.0 < (maxt or 1) then return true end
  end
  return false
end

local function move_axis(ax, d)
  if ax == "x" then p.x = p.x + d else p.z = p.z + d end
  local feet, head = p.y, p.y + PH
  for i = 0, ncol() - 1 do
    local b = i*6
    local x0,y0,z0,x1,y1,z1 = COL[b+1],COL[b+2],COL[b+3],COL[b+4],COL[b+5],COL[b+6]
    if p.x+PR>x0 and p.x-PR<x1 and p.z+PR>z0 and p.z-PR<z1 and head>y0 and feet<y1 then
      if y1-feet<=STEP and y1-feet>0 then p.y=y1; feet=y1; head=y1+PH
      else
        if ax=="x" then if d>0 then p.x=x0-PR else p.x=x1+PR end
        else if d>0 then p.z=z0-PR else p.z=z1+PR end end
      end
    end
  end
end

local function move_vertical()
  p.vy = p.vy - GRAV
  p.y = p.y + p.vy
  p.grounded = false
  local feet, head = p.y, p.y + PH
  for i = 0, ncol() - 1 do
    local b = i*6
    local x0,y0,z0,x1,y1,z1 = COL[b+1],COL[b+2],COL[b+3],COL[b+4],COL[b+5],COL[b+6]
    if p.x+PR>x0 and p.x-PR<x1 and p.z+PR>z0 and p.z-PR<z1 then
      if p.vy<=0 and feet<y1 and feet>y1-1.2 then p.y=y1; p.vy=0; p.grounded=true; feet=y1; head=y1+PH
      elseif p.vy>0 and head>y0 and feet<y0 then p.y=y0-PH; p.vy=0 end
    end
  end
  if p.y < -6 then p.hp=0; kill_ent(p, p, false) end   -- fell off the arena
end

function respawn(who)
  local s = (math.random(0, NBOT)) * 3
  who.x,who.y,who.z = SPN[s+1],SPN[s+2],SPN[s+3]
  who.ay = math.atan(-who.x, -who.z)  -- face into the arena, not the spawn wall
  who.vy=0; who.hp=100; who.sh = MODE.shields and 100 or 0
  who.dead=false; who.respawn=0
end

local function give(who, slot, id) who["g"..slot]=id; who["a"..slot]=W[id].mag; who["r"..slot]=W[id].reserve or 0 end

function enemy_of(a, o)
  if MODE.obj=="jugg" then return a.jugg ~= o.jugg end  -- everyone vs the juggernaut
  if not MODE.teams then return true end
  return a.team ~= o.team
end

-- ---------------------------------------------------------------------------
-- Online multiplayer. The page relays state + events between browsers through
-- the SDK's cartbox.net* channel (pmem 0..118, so this cart keeps no save data
-- there). Each of the 8 slots is a player: this browser's own (p), another
-- human, or a bot -- simulated by the room's host and mirrored to everyone
-- else. Each client is authoritative for its own player; a hit on someone else
-- is sent to them as an event, and a victim announces its own death.
local NETMODE, MYSLOT, HUMANS = 0, 0, 0     -- 0 offline / 1 client / 2 host
local WLIST = {"br","smg","shotgun","sniper","magnum","sword"}
local WIDX_OF = {}; for i,id in ipairs(WLIST) do WIDX_OF[id]=i-1 end
local EV_HIT, EV_KILL, EV_OBJ, EV_SCORE = 1, 2, 3, 4
local net_match_id, net_seen_match = 0, -1

local function s16(v) v = v & 0xffff; if v >= 32768 then v = v - 65536 end; return v end
local function u16(v) return math.floor(v + 0.5) & 0xffff end
local function wrap_angle(a) while a > math.pi do a = a - 2*math.pi end; while a < -math.pi do a = a + 2*math.pi end; return a end

-- Pack a player into 3 words: position (cm), yaw, and the bits others need
-- to draw and fight it (health, shields, weapon, dead/moving, team).
local function net_pack(e)
  local wid = (e == p) and (p.slot==1 and p.g1 or p.g2) or (e.g1 or "br")
  local w0 = u16(e.x*100) | (u16(e.z*100) << 16)
  local w1 = u16(e.y*100) | (u16(wrap_angle(e == p and e.ay or (e.face or 0))*10000) << 16)
  local hp = math.max(0, math.min(127, math.floor(e.hp or 0)))
  local sh = math.max(0, math.min(127, math.floor((e.sh or 0)/2)))
  local w2 = hp | (sh << 7) | ((WIDX_OF[wid] or 0) << 14) | ((e.dead and 1 or 0) << 17)
    | ((e.moving and 1 or 0) << 18) | ((e.team=="red" and 1 or 0) << 19)
  return w0, w1, w2
end

-- Apply a remote player's state to its local stand-in, smoothing the motion.
local function net_apply(e, w0, w1, w2)
  local tx, tz, ty = s16(w0)/100, s16(w0 >> 16)/100, s16(w1)/100
  local far = math.abs(tx-e.x) + math.abs(tz-e.z) + math.abs(ty-e.y) > 4
  local k = far and 1 or 0.35                              -- snap on respawn, else ease
  e.x, e.y, e.z = e.x+(tx-e.x)*k, e.y+(ty-e.y)*k, e.z+(tz-e.z)*k
  e.face = s16(w1 >> 16)/10000
  e.hp, e.sh = w2 & 127, ((w2 >> 7) & 127)*2
  e.g1 = WLIST[((w2 >> 14) & 7) + 1] or "br"
  e.dead = ((w2 >> 17) & 1) == 1
  e.moving = ((w2 >> 18) & 1) == 1
end

-- The local stand-in for a slot (p for my own).
function ent_by_slot(ns)
  if ns == MYSLOT then return p end
  for _,o in ipairs(bots) do if o.ns == ns then return o end end
  return nil
end

local function ev_word(kind, from, to, head, value)
  return kind | ((from & 7) << 4) | ((to & 7) << 7) | ((head and 1 or 0) << 10) | ((math.floor(value) & 0xffff) << 16)
end

-- A kill of a player this browser owns: score it here, and tell everyone.
function kill_ent(killer, victim, head)
  if victim.dead then return end
  register_kill(killer, victim, head)
  if NETMODE ~= 0 then cartbox.netsend(ev_word(EV_KILL, (killer or victim).ns, victim.ns, head, 0), 0) end
end

-- Every hit in the game lands here: shields soak first, then health. A player
-- another browser owns gets the hit as an event instead -- it applies it and
-- announces the kill if it dies.
function damage(target, dmg, attacker, head)
  if not target or target.dead then return end
  if target.remote then
    cartbox.netsend(ev_word(EV_HIT, (attacker or target).ns, target.ns, head, dmg), 0)
    return
  end
  if (target.sh or 0) > 0 then
    target.sh = target.sh - dmg
    if target.sh < 0 then target.hp = target.hp + target.sh; target.sh = 0 end
  else
    target.hp = target.hp - dmg
  end
  target.lasthit = attacker
  if target.hp <= 0 then kill_ent(attacker, target, head) end
end

-- Read the room: mode, my slot, and who is human; (re)assign every slot's role.
local function net_roles()
  local mode, myslot, humans = cartbox.net()
  if NETMODE == 1 and mode == 2 then net_match_id = net_seen_match end   -- took over as host
  NETMODE, HUMANS = mode, humans
  if mode ~= 0 then MYSLOT = myslot else MYSLOT = 0; HUMANS = 1 end
  if p then p.ns = MYSLOT; p.team = (MYSLOT % 2 == 0) and "blue" or "red" end
  for i,o in ipairs(bots) do
    o.ns = (i-1 < MYSLOT) and (i-1) or i
    o.team = (o.ns % 2 == 0) and "blue" or "red"
    local human = (HUMANS >> o.ns) & 1 == 1
    local remote = NETMODE ~= 0 and (human or NETMODE == 1)
    if o.remote and not remote then respawn(o); nav_place(o) end   -- the host takes over an empty slot
    o.remote, o.human = remote, human
    o.tag = human and ("Player "..(o.ns+1)) or ("Bot "..o.ns)
  end
end

-- Per tick in a match: mirror remote players, then apply incoming hits/kills.
local function net_receive()
  if NETMODE == 0 then return end
  for _,o in ipairs(bots) do
    if o.remote then
      local a, b, c, live = cartbox.netpeer(o.ns)
      if live then net_apply(o, a, b, c) else o.dead = true end
    end
  end
  for _,ev in ipairs(cartbox.netevents()) do
    local a = ev[1]
    local kind, from, to, head, value = a & 15, (a >> 4) & 7, (a >> 7) & 7, ((a >> 10) & 1) == 1, (a >> 16) & 0xffff
    local src, dst = ent_by_slot(from), ent_by_slot(to)
    if kind == EV_HIT and dst and not dst.remote then damage(dst, value, src, head)
    elseif kind == EV_KILL and dst then register_kill(src, dst, head)
    elseif NETMODE == 1 and kind == EV_SCORE and dst then dst.score = value
    elseif NETMODE == 1 and kind == EV_OBJ then net_objective(from == 1 and dst or nil, head, value, ev[2]) end
  end
end

-- A guest applies the host's objective state: who holds the ball / is the
-- juggernaut, where a loose ball lies, which hill is live.
function net_objective(holder, live, value, b)
  if MODE.obj == "ball" then
    if holder == p and ball.carrier ~= p then say("You have the ball",9) end
    ball.carrier, ball.live = holder, live
    if not holder then ball.x, ball.z, ball.y = s16(b)/100, s16(b >> 16)/100, s16(value)/100 end
  elseif MODE.obj == "hill" and value ~= hill.idx and HILLS[value] then
    hill.idx = value
    local h = HILLS[value]; hill.x,hill.y,hill.z = h[1],h[2],h[3]
    say("Hill moved",12)
  elseif MODE.obj == "jugg" and holder and not holder.jugg then
    for _,o in ipairs(all_players()) do o.jugg = false end
    holder.jugg = true
  end
end

-- The host sends the objective (4 Hz) and any changed scores (3 Hz).
local sent_score = {}
local function net_objective_publish()
  if NETMODE ~= 2 or MODE.obj == "slayer" then return end
  if tick % 15 == 5 then
    local holder, value, b = nil, 0, 0
    if MODE.obj == "ball" then
      holder = ball.carrier
      value = u16(ball.y*100); b = u16(ball.x*100) | (u16(ball.z*100) << 16)
    elseif MODE.obj == "hill" then value = hill.idx
    else for _,o in ipairs(all_players()) do if o.jugg then holder = o end end end
    cartbox.netsend(ev_word(EV_OBJ, holder and 1 or 0, holder and holder.ns or 0, MODE.obj == "ball" and ball.live, value), b)
  end
  if tick % 20 == 0 then
    for _,o in ipairs(all_players()) do
      local sc = math.floor(o.score or 0)
      if sent_score[o.ns] ~= sc then sent_score[o.ns] = sc; cartbox.netsend(ev_word(EV_SCORE, 0, o.ns, false, sc), 0) end
    end
  end
end

-- Per tick: publish my player (and, as host, my bots) for everyone else.
local function net_publish()
  if NETMODE == 0 or not p then return end
  cartbox.netpublish(MYSLOT, net_pack(p))
  if NETMODE == 2 then
    for _,o in ipairs(bots) do if not o.remote then cartbox.netpublish(o.ns, net_pack(o)) end end
  end
end

-- Forward vector from yaw + auto-aim pitch.
local function forward()
  local cp = math.cos(p.ap)
  return cp*math.sin(p.ay), math.sin(p.ap), cp*math.cos(p.ay)
end

local function drive_camera()
  local fx,fy,fz = forward()
  local ex,ey,ez = p.x, p.y+EYE, p.z
  local d = 0.5
  local tx,ty,tz = ex+fx*d, ey+fy*d, ez+fz*d
  local oy = math.atan(-fx, -fz)
  local op = math.asin(clamp(-fy,-0.999,0.999))
  cartbox.worldcam(oy, op, d, p.zoom and 0.5 or 1.15, tx-CENTER_X, ty-CENTER_Y, tz-CENTER_Z)
end

-- Nearest live enemy inside the player's forward yaw cone AND with clear line of
-- sight, for auto-aim (no manual pitch on an 8-button pad). Returns bot,distance.
local function auto_target()
  local best, bd = nil, 1e9
  local ex,ey,ez = p.x, p.y+EYE, p.z
  for _, o in ipairs(bots) do
    if not o.dead and enemy_of(p, o) then
      local dx,dz = o.x-p.x, o.z-p.z
      local m = math.sqrt(dx*dx+dz*dz)
      if m > 0.3 then
        local ang = math.atan(dx, dz) - p.ay
        while ang > math.pi do ang = ang - 2*math.pi end
        while ang < -math.pi do ang = ang + 2*math.pi end
        if math.abs(ang) < 0.28 and m < bd and not seg_blocked(ex,ey,ez, o.x,o.y+1.2,o.z, 1) then
          best, bd = o, m
        end
      end
    end
  end
  return best, bd
end

function add_feed(txt, color)
  table.insert(feed, 1, {text=txt, color=color, t=180})
  if #feed > 5 then table.remove(feed) end
end

function say(txt, color)
  announce.text=txt; announce.color=color or 12; announce.t=110
end

-- Register a kill: scoring, sprees, multikills, feed, and juggernaut handover.
function register_kill(killer, victim, hs)
  victim.dead=true; victim.respawn = MODE.obj=="jugg" and 70 or 100
  victim.deaths=(victim.deaths or 0)+1
  victim.streak=0
  if killer and killer~=victim then
    if MODE.obj=="ball" or MODE.obj=="hill" then
      -- objective modes: kills don't score, holding does
    elseif MODE.obj=="jugg" then
      if victim.jugg then killer.jugg=true; victim.jugg=false; killer.score=(killer.score or 0)+1; if killer==p then say("JUGGERNAUT",9) elseif victim==p then say("YOU ARE THE HUNTED",6) end
      elseif killer.jugg then killer.score=(killer.score or 0)+1 end   -- the juggernaut scores its kills
    elseif MODE.teams then
      team[killer.team]=team[killer.team]+1
    else
      killer.score=(killer.score or 0)+1
    end
    killer.streak=(killer.streak or 0)+1
    -- multikill window (~4s)
    if tick-(killer.lastkill or -999) < 240 then killer.multi=(killer.multi or 1)+1 else killer.multi=1 end
    killer.lastkill=tick
    if killer==p then
      local m = {"","","Double Kill!","Triple Kill!","Overkill!","Killtacular!"}
      if killer.multi>=2 then say(m[math.min(6,killer.multi)] or "Killtacular!",9) end
      local sp = {[5]="Killing Spree!",[10]="Killing Frenzy!",[15]="Running Riot!"}
      if sp[killer.streak] then say(sp[killer.streak],6) end
    end
    add_feed((killer.tag or "?").." > "..(victim.tag or "?")..(hs and "  (headshot)" or ""), killer==p and 6 or 13)
  end
  if MODE.obj=="ball" and ball.carrier==victim then ball.live=true; ball.carrier=nil; ball.x=victim.x; ball.y=victim.y+0.6; ball.z=victim.z end
end

function score_of(who)
  if MODE.teams and MODE.obj=="slayer" then return team[who.team] end
  return who.score or 0
end

-- ---------------------------------------------------------------------------
-- Grenades: a thrown frag arcs under gravity, bounces off floor level, and
-- detonates on a fuse, dealing splash to everyone in range.
function throw_grenade(who, fx,fy,fz)
  if (who.nade or 0) <= 0 then return end
  who.nade = who.nade - 1
  table.insert(grenades, { x=who.x, y=who.y+EYE, z=who.z, vx=fx*0.5, vy=fy*0.5+0.12, vz=fz*0.5, t=90, owner=who })
end

local function explode(g)
  flash = math.max(flash, 3)
  local function splash(o)
    if not o or o.dead then return end
    local m = d3(g.x,g.y,g.z, o.x,o.y+1,o.z)
    if m < 4.5 then damage(o, (1 - m/4.5) * 90, g.owner, false) end
  end
  splash(p)
  for _,o in ipairs(bots) do splash(o) end
end

local function update_grenades()
  for i=#grenades,1,-1 do
    local g=grenades[i]
    g.vy = g.vy - GRAV*0.7
    g.x=g.x+g.vx; g.y=g.y+g.vy; g.z=g.z+g.vz
    -- crude floor / ledge bounce
    for j=0,ncol()-1 do local b=j*6
      if g.x>COL[b+1] and g.x<COL[b+4] and g.z>COL[b+3] and g.z<COL[b+6] and g.y<COL[b+5] and g.y>COL[b+5]-0.6 and g.vy<0 then
        g.y=COL[b+5]; g.vy=-g.vy*0.4; g.vx=g.vx*0.6; g.vz=g.vz*0.6
      end
    end
    g.t=g.t-1
    if g.t<=0 or g.y<-8 then explode(g); table.remove(grenades,i) end
  end
end

local function player_fire()
  if p.cool>0 or p.dead then return end
  local wid = p.slot==1 and p.g1 or p.g2
  local w = W[wid]
  local ammo = p.slot==1 and p.a1 or p.a2
  -- auto-melee when an enemy is right in front
  local aim,ad = auto_target()
  if aim and ad < 2.4 then
    p.cool=18; flash=3
    if not aim.dead then damage(aim, (aim.sh or 0) + 90, p, false) end   -- melee strips shields
    return
  end
  if ammo<=0 then
    -- reload from reserve, else fall back to the magnum
    local res = p.slot==1 and p.r1 or p.r2
    if res>0 then
      local take=math.min(w.mag,res)
      if p.slot==1 then p.a1=take; p.r1=res-take else p.a2=take; p.r2=res-take end
      p.cool=40; return
    end
    p.slot=(p.slot==1) and 2 or 1; return
  end
  p.cool = w.cool; flash = 4
  if p.slot==1 then p.a1=p.a1-1 else p.a2=p.a2-1 end
  local ex,ey,ez = p.x, p.y+EYE, p.z
  shot.t=3; shot.x=ex; shot.y=ey; shot.z=ez
  for _=1,w.pel do
    local fx,fy,fz
    if aim then
      fx,fy,fz = aim.x-ex, (aim.y+1.2)-ey, aim.z-ez
      local m=math.sqrt(fx*fx+fy*fy+fz*fz); fx,fy,fz=fx/m,fy/m,fz/m
    else fx,fy,fz = forward() end
    if w.spr>0 then fx=fx+(math.random()-0.5)*w.spr; fz=fz+(math.random()-0.5)*w.spr end
    local best,bt=nil,1e9
    for _,o in ipairs(bots) do
      if not o.dead and enemy_of(p,o) then
        local t=(o.x-ex)*fx+(o.y+1.2-ey)*fy+(o.z-ez)*fz
        if t>0.4 and t<w.rng then
          local hx,hy,hz=ex+fx*t, ey+fy*t, ez+fz*t
          local m=math.sqrt((o.x-hx)^2+(o.y+1.2-hy)^2+(o.z-hz)^2)
          if m<0.9 and t<bt and not seg_blocked(ex,ey,ez, hx,hy,hz, 1) then best,bt=o,t; o._hy=hy end
        end
      end
    end
    if best then
      local dmg=w.dmg
      local head = best._hy and best._hy>best.y+1.5
      if head then dmg=dmg*w.hs end
      damage(best, dmg, p, head)
    end
  end
end

local function try_pickups()
  for i=0,(#MRK//3)-1 do
    local id=MW[i+1]; local legal=MODE.weapons[id]
    mtimer[i+1]=math.max(0,(mtimer[i+1] or 0)-1)
    if legal and mtimer[i+1]==0 then
      local mx,my,mz=MRK[i*3+1],MRK[i*3+2],MRK[i*3+3]
      if math.abs(p.x-mx)<1.4 and math.abs(p.z-mz)<1.6 and math.abs((p.y+1)-my)<2.0 then
        give(p,1,id); p.slot=1; mtimer[i+1]=540; say("Picked up "..W[id].name,12)
      end
    end
  end
  -- ammo/grenade top-up when standing on a marker (light resupply)
end

-- ---------------------------------------------------------------------------
-- Bot navigation. Bots walk the waypoint graph (NAVN nodes; NAVL two-way
-- walks, NAVD one-way drops, NAVJ jumps) rather than sliding in a straight line
-- through walls: an all-pairs next-hop table is built once at load, and each
-- bot moves along one edge at a time -- up the ramps to the sniper deck, onto
-- the walkway, over the BR rail -- arcing on jumps and falling on drops.
local NN = #NAVN // 3
local nav_kind, nav_next = {}, {}
local function nav_pos(i) return NAVN[i*3-2], NAVN[i*3-1], NAVN[i*3] end
local function nav_len(a, b)
  local ax,ay,az = nav_pos(a); local bx,by,bz = nav_pos(b)
  return math.sqrt((ax-bx)^2 + (ay-by)^2 + (az-bz)^2)
end
local function nav_build()
  local INF = 1e9
  local d = {}
  for i=1,NN do d[i]={}; nav_next[i]={}; nav_kind[i]={}; for j=1,NN do d[i][j] = (i==j) and 0 or INF end end
  local function link(a,b,k)
    nav_kind[a][b] = k
    local w = nav_len(a,b) * (k==2 and 1.5 or 1)   -- jumps cost a little more
    if w < d[a][b] then d[a][b]=w; nav_next[a][b]=b end
  end
  for i=1,#NAVL,2 do link(NAVL[i],NAVL[i+1],0); link(NAVL[i+1],NAVL[i],0) end
  for i=1,#NAVD,2 do link(NAVD[i],NAVD[i+1],1) end
  for i=1,#NAVJ,2 do link(NAVJ[i],NAVJ[i+1],2); link(NAVJ[i+1],NAVJ[i],2) end
  for k=1,NN do local dk=d[k]
    for i=1,NN do local di=d[i]; local dik=di[k]
      if dik<INF then local ni=nav_next[i]; local nik=ni[k]
        for j=1,NN do local v=dik+dk[j]; if v<di[j] then di[j]=v; ni[j]=nik end end
      end
    end
  end
end
nav_build()

-- The node nearest a point (height counts triple: a bot under the walkway is
-- not "at" the walkway).
local function nav_nearest(x, y, z)
  local best, bd = 1, 1e9
  for i=1,NN do local nx,ny,nz = nav_pos(i)
    local dd = (nx-x)^2 + ((ny-y)*3)^2 + (nz-z)^2
    if dd < bd then best, bd = i, dd end
  end
  return best
end

-- Stand a (re)spawned bot on the waypoint nearest its spawn.
function nav_place(o)
  o.na = nav_nearest(o.x, o.y, o.z)
  o.x, o.y, o.z = nav_pos(o.na)
  o.nb, o.nt, o.goal, o.offgraph = nil, 0, o.na, false
end

local function nav_goto(o, g)
  o.goal = g
  if not o.nb and g ~= o.na then o.nb = nav_next[o.na][g] end
end

-- Advance a bot along its current edge; true while it is moving.
local function nav_step(o, speed)
  if o.offgraph then
    -- Walked off the graph (to a loose ball): head back to the waypoint first.
    local nx,ny,nz = nav_pos(o.na)
    local dx,dz = nx-o.x, nz-o.z
    local m = math.sqrt(dx*dx+dz*dz)
    if m <= speed then o.x,o.y,o.z = nx,ny,nz; o.offgraph = false
    else o.x, o.z = o.x+dx/m*speed, o.z+dz/m*speed; o.mface = math.atan(dx,dz) end
    return true
  end
  if not o.nb then return false end
  local ax,ay,az = nav_pos(o.na); local bx,by,bz = nav_pos(o.nb)
  local kind = nav_kind[o.na][o.nb] or 0
  o.nt = o.nt + speed / math.max(0.1, nav_len(o.na, o.nb))
  if o.nt >= 1 then
    o.na, o.nt = o.nb, 0
    o.x, o.y, o.z = bx, by, bz
    o.nb = (o.na ~= o.goal) and nav_next[o.na][o.goal] or nil
    return true
  end
  local t = o.nt
  o.x, o.z = ax+(bx-ax)*t, az+(bz-az)*t
  if kind==2 then o.y = ay+(by-ay)*t + math.sin(t*math.pi)*1.1      -- jump arc
  elseif kind==1 then o.y = ay+(by-ay)*t*t                          -- fall off the ledge
  else o.y = ay+(by-ay)*t end                                        -- walk (ramps included)
  o.mface = math.atan(bx-ax, bz-az)
  return true
end

-- Where a bot wants to be, as a waypoint, by game type.
local function bot_goal(o)
  if MODE.obj=="ball" then
    if ball.carrier==o then return POWER[math.random(1,#POWER)] end      -- run it somewhere high
    if ball.live then return nav_nearest(ball.x, ball.y, ball.z) end
    local c = ball.carrier; if c then return nav_nearest(c.x, c.y, c.z) end
  elseif MODE.obj=="hill" then return nav_nearest(hill.x, hill.y, hill.z)
  elseif MODE.obj=="jugg" then
    if o.jugg then return POWER[1] end                                   -- the juggernaut holds the deck
    local j = p.jugg and p or nil
    for _,b in ipairs(bots) do if b.jugg then j=b end end
    if j then return nav_nearest(j.x, j.y, j.z) end
  end
  local r = math.random()
  if r < 0.45 then                                                                      -- hunt someone
    local prey = (math.random() < 0.5) and p or bots[math.random(1, #bots)]
    if prey and prey ~= o and not prey.dead and enemy_of(o, prey) then return nav_nearest(prey.x, prey.y, prey.z) end
  end
  if r < 0.75 then return POWER[math.random(1,#POWER)] end                             -- take a power position
  return math.random(1, NN)                                                             -- roam
end

-- Every player a bot could be fighting: the local player and all the others.
function all_players()
  local list = { p }
  for _,o in ipairs(bots) do list[#list+1] = o end
  return list
end

-- Weapon markers as waypoints, so bots can go and pick them up.
local MRK_NODE = {}
for i=0,(#MRK//3)-1 do MRK_NODE[i+1] = nav_nearest(MRK[i*3+1], MRK[i*3+2]-0.4, MRK[i*3+3]) end

-- A bot that walks over a live weapon marker takes the weapon.
local function bot_pickups(o)
  for i=0,(#MRK//3)-1 do
    local id=MW[i+1]
    if MODE.weapons[id] and (mtimer[i+1] or 0)==0 and o.g1 ~= id then
      local mx,my,mz=MRK[i*3+1],MRK[i*3+2],MRK[i*3+3]
      if math.abs(o.x-mx)<1.4 and math.abs(o.z-mz)<1.6 and math.abs((o.y+1)-my)<2.0 then
        o.g1=id; mtimer[i+1]=540
      end
    end
  end
end

local function think_bot(o)
  if o.remote then return end        -- another browser (or the host) drives it
  if o.dead then o.respawn=o.respawn-1; if o.respawn<=0 then respawn(o); nav_place(o) end return end
  o.moving=false
  -- Pick a target a few times a second: the nearest enemy in line of sight --
  -- the player, another human, or another bot. Bots fight each other now.
  if (tick + (o.id or 0)*7) % 10 == 0 then
    o.target = nil
    local bd = 40
    for _,e in ipairs(all_players()) do
      if e ~= o and e and not e.dead and enemy_of(o, e) then
        local m = d3(o.x,o.y,o.z, e.x,e.y,e.z)
        if m < bd and not seg_blocked(o.x,o.y+1.4,o.z, e.x,e.y+1.4,e.z, 1) then o.target, bd = e, m end
      end
    end
  end
  local tg = o.target
  if tg and tg.dead then tg = nil; o.target = nil end
  local w = W[o.g1 or "br"]
  if tg then
    local dx,dz = tg.x-o.x, tg.z-o.z
    local m = math.sqrt(dx*dx+dz*dz)
    o.face = math.atan(dx,dz)
    o.cool=(o.cool or 0)-1
    if m < (w.rng or 40) and o.cool<=0 then
      o.cool = (w.cool or 10) + math.random(0,6)
      local acc = MODE.shields and 0.30 or 0.5    -- SWAT bots hit harder
      if w.melee then acc = (m < 3) and 0.9 or 0 end
      if math.random() < acc then
        local dmg = (w.dmg or 12) * (w.pel or 1) * 0.6
        local head = math.random() < 0.12
        if head then dmg = dmg*(w.hs or 1.5) end
        damage(tg, dmg, o, head)
      end
    end
    -- close the distance if out of range, otherwise keep walking the route
    -- (slowly) so a fight isn't two statues trading shots
    if m > (w.rng or 40)*0.7 then nav_goto(o, nav_nearest(tg.x,tg.y,tg.z)) end
    if nav_step(o, 0.035) then o.moving=true end
  else
    -- pick a new destination when idle, and re-think every couple of seconds;
    -- now and then go and grab a weapon from a marker
    if not o.nb or (tick + (o.id or 0)*23) % 150 == 0 then
      if math.random() < 0.2 then
        local k = math.random(1, #MRK_NODE)
        if MODE.weapons[MW[k]] then nav_goto(o, MRK_NODE[k]) else nav_goto(o, bot_goal(o)) end
      else nav_goto(o, bot_goal(o)) end
    end
    -- The last few metres to a loose ball are off the graph: walk straight at it.
    local bx, bz = ball.x - o.x, ball.z - o.z
    local bm = math.sqrt(bx*bx + bz*bz)
    if MODE.obj=="ball" and ball.live and not o.nb and bm < 5 and bm > 0.2 and math.abs(o.y - (ball.y-0.5)) < 0.8
      and not seg_blocked(o.x,o.y+0.5,o.z, ball.x,ball.y,ball.z, 1) then
      o.x, o.z = o.x+bx/bm*0.075, o.z+bz/bm*0.075
      o.offgraph, o.moving, o.mface = true, true, math.atan(bx,bz)
    elseif nav_step(o, 0.075) then o.moving=true end
    o.face = o.mface or o.face
  end
  bot_pickups(o)
end

-- ---------------------------------------------------------------------------
local function update_objective()
  -- Online, the host owns the objective and every score; a guest only draws it
  -- (net_objective applies what the host sends).
  if NETMODE == 1 then
    if MODE.obj=="ball" and ball.carrier and not ball.carrier.dead then
      ball.x,ball.y,ball.z = ball.carrier.x, ball.carrier.y+1.6, ball.carrier.z
    end
    return
  end
  if MODE.obj=="ball" then
    if ball.carrier and not ball.carrier.dead then
      ball.x,ball.y,ball.z = ball.carrier.x, ball.carrier.y+1.6, ball.carrier.z
      if tick%60==0 then ball.carrier.score=(ball.carrier.score or 0)+1 end   -- a point a second held
    end
    -- anyone (me, a bot, another player's stand-in) grabs a loose ball
    if ball.live then
      for _,o in ipairs(all_players()) do
        if not o.dead and d3(o.x,o.y,o.z, ball.x,ball.y,ball.z) < ((o==p) and 1.5 or 1.3) then
          ball.carrier=o; ball.live=false
          if o==p then say("You have the ball",9) end
          break
        end
      end
    end
  elseif MODE.obj=="hill" then
    if tick>=hill.next then
      hill.idx = hill.idx % #HILLS + 1
      local h=HILLS[hill.idx]; hill.x,hill.y,hill.z=h[1],h[2],h[3]; hill.next=tick+HILL_MOVE
      if tick>1 then say("Hill moved",12) end
    end
    local function inhill(o) return (not o.dead) and math.abs(o.x-hill.x)<3 and math.abs(o.z-hill.z)<3 end
    -- a point for every second in the hill
    if tick%60==0 then for _,o in ipairs(all_players()) do if inhill(o) then o.score=(o.score or 0)+1 end end end
  elseif MODE.obj=="jugg" then
    -- the juggernaut earns points just for surviving as the hunted
    local jg=nil
    if p.jugg then jg=p else for _,o in ipairs(bots) do if o.jugg then jg=o break end end end
    if jg and not jg.dead and tick%600==0 then jg.score=(jg.score or 0)+1 end
  end
end

function reached_target()
  if MODE.teams and MODE.obj=="slayer" then
    if team.blue>=MODE.target then return "BLUE TEAM WINS" end
    if team.red>=MODE.target then return "RED TEAM WINS" end
  else
    if (p.score or 0)>=MODE.target then return "YOU WIN" end
    for _,o in ipairs(bots) do if (o.score or 0)>=MODE.target then return (o.tag or "A bot").." WINS" end end
  end
end

local function start_match(key)
  MODE = MODES[key]; team.blue,team.red,winner = 0,0,""
  tick=0; feed={}; grenades={}; announce.t=0
  for i=1,(#MRK//3) do mtimer[i]=0 end
  p = { ay=0, ap=0, vy=0, cool=0, score=0, deaths=0, slot=1, team="blue", dead=false, respawn=0, nade=2, tag="You", streak=0 }
  respawn(p); give(p,1,MODE.start); give(p,2,"magnum")
  bots = {}
  for i=1,NBOT do
    -- Teams alternate by slot (even slots blue, odd red), so a room of any
    -- size splits evenly; net_roles below fills in slots, owners and names.
    local o = { id=i, face=0, score=0, deaths=0, team=(i%2==0) and "blue" or "red", g1=MODE.start, cool=0, tag="Bot "..i, streak=0 }
    respawn(o); nav_place(o); bots[i]=o
  end
  net_roles()
  if MODE.obj=="ball" then ball={x=0,y=1.1,z=0,carrier=nil,live=true} end
  if MODE.obj=="hill" then hill={x=HILLS[1][1],y=HILLS[1][2],z=HILLS[1][3],next=HILL_MOVE,idx=1} end
  if MODE.obj=="jugg" then local j = ent_by_slot(1) or bots[1]; j.jugg=true; j.sh=200 end
  for k in pairs(sent_score) do sent_score[k] = nil end
  phase = "play"
  if NETMODE == 2 then net_match_id = net_match_id + 1 end
end

-- 8-button controls: tank move + turn, hold A to strafe, double-tap A grenade.
local function play_input()
  local aheld = btn(6)
  if edge("a", aheld) then
    if tick-(p.lastA or -99) < 14 and not p.dead then local fx,fy,fz=forward(); throw_grenade(p,fx,fy,fz) end
    p.lastA=tick
  end
  local sy,cy = math.sin(p.ay), math.cos(p.ay)
  local mvx,mvz = 0,0
  local moving=false
  if not p.dead then
    if btn(0) then mvx=mvx+sy; mvz=mvz+cy; moving=true end
    if btn(1) then mvx=mvx-sy; mvz=mvz-cy; moving=true end
    if aheld then
      if btn(2) then mvx=mvx-cy; mvz=mvz+sy; moving=true end
      if btn(3) then mvx=mvx+cy; mvz=mvz-sy; moving=true end
    else
      if btn(2) then p.ay=p.ay-TURN end
      if btn(3) then p.ay=p.ay+TURN end
    end
    local mm=math.sqrt(mvx*mvx+mvz*mvz)
    if mm>0 then move_axis("x",mvx/mm*MOVE); move_axis("z",mvz/mm*MOVE) end
  end
  if moving then bob=bob+0.28 end
  -- auto-aim pitch eases toward the locked enemy
  local aim=auto_target()
  local want=0
  if aim then
    local hd=math.sqrt((aim.x-p.x)^2+(aim.z-p.z)^2)
    want=math.asin(clamp(((aim.y+1.2)-(p.y+EYE))/math.max(1,hd),-0.9,0.9))
  end
  p.ap=p.ap+(want-p.ap)*0.2
  if btn(5) and p.grounded and not p.dead then p.vy=JUMP; p.grounded=false end
  if edge("swap", btn(7)) then p.slot=(p.slot==1) and 2 or 1 end
  local cur=W[p.slot==1 and p.g1 or p.g2]
  p.zoom = cur.zoom and aheld and not (btn(0) or btn(1) or btn(2) or btn(3))
  if p.cool>0 then p.cool=p.cool-1 end
  local firing = cur.auto and btn(4) or edge("fire", btn(4))
  if firing then player_fire() end
end

-- ---------------------------------------------------------------------------
-- Presentation.
local function sky()
  for i=0,8 do rect(0, i*40, 1280, 40, i<3 and 1 or (i<5 and 2 or 3)) end
  rect(0, 360, 1280, 360, 3)
  -- a few Forerunner stars up high
  for i=1,40 do local sx=(i*131)%1280; local sy=(i*71)%180; pix(sx,sy,12) end
end

-- First-person weapon: a real 3D viewmodel. Each weapon is its own mesh
-- instance (8..13) authored at 1/1000 scale, so it is invisible until posed;
-- each frame only the weapon in hand is posed just in front of the eye (scaled
-- back up by WS), bobbing with the walk and kicking back when it fires.
local WIDX = { br=8, smg=9, shotgun=10, sniper=11, magnum=12, sword=13 }
-- Armour tints (the runtime's 15-colour tint palette): red/blue by team in team
-- modes; in Free for All every player wears their own colour.
local TINT_RED, TINT_BLUE, TINT_GREEN = 1, 2, 3
local FFA_TINTS = { 1, 4, 5, 6, 8, 12, 9 }
function armor_tint(o)
  if MODE.teams then return o.team=="blue" and TINT_BLUE or TINT_RED end
  if o == p then return TINT_GREEN end
  for i=1,NBOT do if bots[i]==o then return FFA_TINTS[i] end end
  return TINT_GREEN
end
local WS = 1000
local function pose_viewmodel(wid)
  local idx = WIDX[wid]
  if not idx or p.dead or p.zoom then return end
  local s, c = math.sin(p.ay), math.cos(p.ay)
  local cp, sp = math.cos(p.ap), math.sin(p.ap)
  local fx, fy, fz = cp*s, sp, cp*c        -- forward
  local rx, rz = -c, s                     -- right (horizontal)
  local ux, uy, uz = -s*sp, cp, -c*sp      -- up
  local kick = flash*0.012
  local fwd, rgt, up = 0.4 - kick, 0.19 + math.sin(bob)*0.012, -0.235 - math.abs(math.cos(bob))*0.01
  if wid=="sword" then fwd, rgt, up = 0.3, 0.13 + math.sin(bob)*0.012, -0.24 end
  if wid=="magnum" then rgt = rgt - 0.03; fwd = fwd - 0.03 end
  local ex, ey, ez = p.x, p.y+EYE, p.z
  local px = ex + fx*fwd + rx*rgt + ux*up
  local py = ey + fy*fwd + uy*up
  local pz = ez + fz*fwd + rz*rgt + uz*up
  -- Front layer: drawn over the finished scene, so it never clips into a wall.
  cartbox.meshpose(idx, px*WS, py*WS, pz*WS, p.ay, -p.ap - flash*0.03, 0, WS, 0, armor_tint(p), true)
end

-- The muzzle flash stays a 2D HUD flare, drawn where the barrel sits on screen.
local function draw_muzzle_flash(cur)
  if flash<=0 or cur.melee then return end
  local mx, my = 752, 482
  circ(mx,my,10+flash*4,9); circ(mx,my,5+flash*2,12)
end

-- Circular motion tracker (bottom-left): allies yellow, moving/firing enemies
-- red, rotated so the player faces "up". Classic radar -- it only sees motion.
local function draw_tracker()
  local rx,ry,rr=140,560,96
  circ(rx,ry,rr,1); circb(rx,ry,rr,13); circb(rx,ry,rr//2,2)
  -- sweep
  local sw=(tick*0.05)%(2*math.pi)
  line(rx,ry, rx+math.sin(sw)*rr, ry-math.cos(sw)*rr, 2)
  local function blip(o,col)
    local dx,dz=o.x-p.x, o.z-p.z
    local m=math.sqrt(dx*dx+dz*dz)
    if m>28 then return end
    local ang=math.atan(dx,dz)-p.ay
    local px=rx+math.sin(ang)*(m/28)*rr
    local py=ry-math.cos(ang)*(m/28)*rr
    circ(px,py,3,col)
  end
  for _,o in ipairs(bots) do
    if not o.dead and enemy_of(p,o) then if o.moving or MODE.obj=="jugg" and o.jugg then blip(o,6) end
    elseif not o.dead then blip(o,9) end
  end
  tri(rx,ry-7, rx-5,ry+5, rx+5,ry+5, 12)  -- player
  print("MOTION",rx-34,ry+rr+6,13,false,1,true)
end

local function draw_hud()
  -- shield (top) + health (under), segmented. Backgrounds use index 5 (a dark
  -- slate), never 0: in HUD mode index 0 is the transparent "world" key.
  rect(40,40,300,20,5)
  local sc = p.sh>0 and 9 or 6
  rect(42,42,math.max(0,2.96*(MODE.shields and p.sh or p.hp)),16,sc)
  if MODE.shields then rect(40,66,300,12,5); rect(42,68,math.max(0,2.96*p.hp),8,6) end
  -- weapon + ammo (top-right)
  local cur=W[p.slot==1 and p.g1 or p.g2]
  local ammo=p.slot==1 and p.a1 or p.a2
  local res=p.slot==1 and p.r1 or p.r2
  print(cur.name,900,40,12,false,2,true)
  print(ammo.." / "..res,1040,74,cur.melee and 13 or 12,false,2,true)
  -- grenades
  for i=1,(p.nade or 0) do circ(1150+i*22,120,8,6); circb(1150+i*22,120,8,12) end
  print("FRAG",1150,96,13,false,1,true)
  -- objective / score readout (top center)
  local st
  if MODE.obj=="slayer" and MODE.teams then st="BLUE "..team.blue.."   RED "..team.red.."   /"..MODE.target
  elseif MODE.obj=="ball" then st=(ball.carrier==p and "YOU HOLD THE BALL  " or "").."Ball "..(p.score or 0).." /"..MODE.target
  elseif MODE.obj=="hill" then st="Hill "..(p.score or 0).." /"..MODE.target
  elseif MODE.obj=="jugg" then st=(p.jugg and "YOU ARE THE JUGGERNAUT  " or "Hunt the Juggernaut  ")..(p.score or 0).." /"..MODE.target
  else st="Score "..(p.score or 0).."   Deaths "..p.deaths.."   /"..MODE.target end
  print(MODE.name,540,40,13,false,1,true)
  print(st,540,58,12,false,2,true)
  -- kill feed (right, under ammo)
  for i,f in ipairs(feed) do print(f.text,880,150+i*22,f.color,false,1,true); f.t=f.t-1 end
  for i=#feed,1,-1 do if feed[i].t<=0 then table.remove(feed,i) end end
  -- announcer / medal (center)
  if announce.t>0 then announce.t=announce.t-1; print(announce.text,540,150,announce.color,false,3,true) end
  if MODE.radar then draw_tracker() end
end

local function draw_reticle()
  local cx,cy=640,360
  local cur=W[p.slot==1 and p.g1 or p.g2]
  local locked=auto_target()~=nil
  local rc=locked and 6 or 12
  if p.zoom then circb(cx,cy,210,13); line(cx-240,cy,cx+240,cy,13); line(cx,cy-240,cx,cy+240,13) end
  if cur.melee then
    line(cx-14,cy-14,cx+14,cy+14,rc); line(cx-14,cy+14,cx+14,cy-14,rc)
  elseif cur.pel>1 then
    circb(cx,cy,18,rc); circb(cx,cy,4,rc)
  else
    circb(cx,cy,10,rc); line(cx-16,cy,cx-6,cy,rc); line(cx+6,cy,cx+16,cy,rc)
    line(cx,cy-16,cx,cy-6,rc); line(cx,cy+6,cx,cy+16,rc)
  end
end

-- The mesh overlay always composites the 3D scene ON TOP of the cart's 2D frame,
-- so on the 2D-only screens (menu, results) every instance must be pushed off
-- screen -- otherwise the engine's default auto-orbit spins the arena over the
-- menu text (index 0 is the map; 1..NBOT are the bots; scale 0 hides).
function hide_scene()
  cartbox.clearposes()
  for i=0,NBOT do cartbox.meshpose(i,0,-999,0,0,0,0,0) end
end

-- The game types that work online (the objective modes need a shared ball,
-- hill or juggernaut, which stay single-player for now).
ONLINE_KEYS = {"ffa","slayer","swat","snipe","ball","koth","jugg"}

-- The host's shared match word: bit 0 a match is on, bits 1-3 the game type,
-- bits 4+ a match number (so guests join each new match exactly once).
function net_match_word()
  local idx = 0
  for i,k in ipairs(ONLINE_KEYS) do if MODES[k] == MODE then idx = i-1 end end
  return ((phase=="play") and 1 or 0) | (idx << 1) | ((net_match_id & 0xffff) << 4)
end

-- In a match, a guest follows the host: the host's next match starts here too,
-- and the host's end of this one ends it here.
local function net_follow_host()
  if NETMODE ~= 1 then return end
  local _, _, _, word = cartbox.net()
  local id = word >> 4
  if (word & 1) == 1 and id ~= net_seen_match then
    net_seen_match = id
    start_match(ONLINE_KEYS[((word >> 1) & 7) + 1] or "ffa")
  elseif (word & 1) == 0 and id == net_seen_match then
    winner = reached_target() or "MATCH OVER"; phase = "over"
  end
end

-- Outside a match: keep the room roles fresh, publish that we're not in play,
-- and (as a guest) join the host's match when it starts.
function net_menu_sync()
  local was = NETMODE
  local mode, myslot, humans, word = cartbox.net()
  NETMODE, HUMANS = mode, humans
  MYSLOT = (mode ~= 0) and myslot or 0
  if was == 1 and NETMODE == 2 then net_match_id = net_seen_match end   -- took over as host
  if NETMODE == 2 then cartbox.netmatch(net_match_word()) end
  if NETMODE == 1 and (word & 1) == 1 and (word >> 4) ~= net_seen_match then
    net_seen_match = word >> 4
    start_match(ONLINE_KEYS[((word >> 1) & 7) + 1] or "ffa")
  end
  if p then p.dead = true; net_publish() end   -- in the lobby: don't draw me in anyone's arena
end

-- ---------------------------------------------------------------------------
function TIC()
  cls(0)
  tick=tick+1

  if phase=="menu" or phase=="over" then net_menu_sync() end

  if phase=="menu" then
    hide_scene()
    cartbox.hud(0)  -- 2D-only screen: draw the menu normally, not as a HUD over meshes
    sky()
    print("LOCKOUT ARENA",452,96,12,false,3,true)
    if NETMODE == 1 then
      -- An online guest: the host picks the game type.
      print("ONLINE  --  you are Player "..(MYSLOT+1),470,170,9,false,2,true)
      print("Waiting for the host to start a match...",430,240,12,false,2,true)
      local y = 300
      for ns=0,7 do if (HUMANS >> ns) & 1 == 1 then
        print("Player "..(ns+1)..(ns==0 and "  (host)" or "")..(ns==MYSLOT and "  <- you" or ""),470,y,13,false,2,true); y=y+34
      end end
      return
    end
    local keys = (NETMODE == 2) and ONLINE_KEYS or MODE_KEYS
    local n=#keys
    if sel > n then sel = 1 end
    if edge("up", btn(0)) then sel=(sel-2)%n+1 end
    if edge("down", btn(1)) then sel=sel%n+1 end
    if edge("go", btn(4)) or edge("go2", btn(5)) then start_match(keys[sel]) end
    if NETMODE == 2 then
      local humans = 0
      for ns=0,7 do if (HUMANS >> ns) & 1 == 1 then humans = humans + 1 end end
      print("ONLINE  --  you are the host  --  "..humans.." player"..(humans==1 and "" or "s").." + "..(8-humans).." bots",360,150,9,false,1,true)
    else
      print("you + 7 bots  --  a Forerunner-style homage on the Xbox 360 core",396,150,13,false,1,true)
    end
    for i=1,n do
      local mo=MODES[keys[i]]
      local y=210+(i-1)*44
      if i==sel then rect(470,y-6,360,36,1) end
      print(mo.name,492,y,(i==sel) and 12 or 13,false,2,true)
    end
    print("Up/Down choose . Z (or A) start",470,540,13,false,1,true)
    print("Move Up/Down . Turn Left/Right . hold A strafe . dbl-tap A grenade",300,584,13,false,1,true)
    print("Z fire (auto-melee close) . X jump . S swap . sniper: hold A to zoom",300,612,13,false,1,true)
    return
  end

  if phase=="over" then
    hide_scene()
    cartbox.hud(0)
    sky()
    print(winner,520,260,12,false,3,true)
    -- simple scoreboard
    print("You: "..(p.score or 0).." kills, "..p.deaths.." deaths",520,340,6,false,2,true)
    if MODE.teams then print("BLUE "..team.blue.."   RED "..team.red,520,380,9,false,2,true) end
    print(NETMODE == 1 and "Z -> back to the lobby" or "Z -> back to game types",520,460,13,false,1,true)
    if edge("go", btn(4)) then phase="menu" end
    net_publish()
    return
  end

  net_follow_host()
  if phase ~= "play" then return end
  net_roles()
  net_receive()
  play_input()
  if p.dead then p.respawn=p.respawn-1; if p.respawn<=0 then respawn(p) end
  else move_vertical(); try_pickups() end
  for _,o in ipairs(bots) do think_bot(o) end
  update_grenades()
  update_objective()
  local w=reached_target(); if w then winner=w; phase="over" end
  net_publish()
  net_objective_publish()
  if NETMODE == 2 then cartbox.netmatch(net_match_word()) end
  if flash>0 then flash=flash-1 end
  if shot.t>0 then shot.t=shot.t-1 end

  -- No 2D sky in play: HUD mode composites this frame OVER the 3D scene, so the
  -- cls(0) void is transparent (the arena + engine sky show through) and only the
  -- HUD we draw below lands on top.
  -- The arena's own rig lights the world; the objectives glow in it, so you can
  -- see the ball and the hill from across the map.
  cartbox.clearlights()
  if MODE.obj=="ball" then cartbox.light3d(ball.x, ball.y+0.6, ball.z, 5, 90,220,255, 3.2) end
  if MODE.obj=="hill" then cartbox.light3d(hill.x, hill.y+1.2, hill.z, 5.5, 120,255,150, 3.4) end

  cartbox.clearposes()
  for i=1,NBOT do local o=bots[i]
    if o.dead then cartbox.meshpose(i,0,-50,0,0,0,0,0)
    else
      -- Walk cycle: step through the soldier's 4 stride frames (frame 0 is the
      -- idle stance), with a small bob and sway, and paint it by team.
      if o.moving then o.walk=(o.walk or 0)+0.31 end
      local wk = o.walk or 0
      local frame = o.moving and (1 + math.floor(wk / (math.pi/2)) % 4) or 0
      local lift = o.moving and math.abs(math.sin(wk))*0.03 or 0
      local sway = o.moving and math.sin(wk)*0.03 or 0
      cartbox.meshpose(i,o.x,o.y+lift,o.z,o.face,0,sway, o.jugg and 1.25 or 1, frame, armor_tint(o))
    end
  end
  local cur_id = p.slot==1 and p.g1 or p.g2
  pose_viewmodel(cur_id)
  drive_camera()
  cartbox.hud(1)  -- composite this 2D frame as a HUD over the 3D arena

  draw_reticle()
  draw_muzzle_flash(W[cur_id])
  draw_hud()
  if p.dead then print("RESPAWNING...",520,330,6,false,3,true) end
end
`;

/** Seed a fresh cart with the Lockout arena code and a cool Forerunner palette. */
/** Lockout's palette over the default Sweetie-16: index → hex. */
const LOCKOUT_PALETTE: ReadonlyArray<readonly [number, string]> = [
  [0, "#000000"], // void — pure black so HUD mode keys it transparent (the 3D shows through)
  [1, "#1a2740"], // upper sky
  [2, "#2b3f5e"], // mid sky
  [3, "#3f5a72"], // horizon haze (greenish-grey Lockout mood)
  [5, "#202838"], // HUD dark slate (bright enough to survive the HUD transparent key)
  [6, "#37e0a0"], // health / hit green
  [9, "#5cd0ff"], // shield / energy cyan
  [12, "#eaf2ff"], // ink
  [13, "#a7bad4"], // dim ink
];

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

export function seedLockoutCart(engine: CartEngine): void {
  engine.setLanguage("lua");
  engine.setCode(LOCKOUT_CODE);
  for (const [index, hex] of LOCKOUT_PALETTE) engine.setPaletteColor(index, ...hexRgb(hex));
}

/**
 * The Lockout cartridge as .tic bytes — its code and palette, exactly what the
 * starter seeds — for playing it outside the editor (the /lockout page). The
 * cart has no sprites, map or sound, so its palette and code are the whole cart.
 */
export function lockoutCartridge(): Uint8Array {
  const code = new TextEncoder().encode(LOCKOUT_CODE);
  const palette = new Uint8Array(16 * 3);
  SWEETIE_16.forEach((hex, i) => palette.set(hexRgb(hex), i * 3));
  for (const [index, hex] of LOCKOUT_PALETTE) palette.set(hexRgb(hex), index * 3);
  const chunk = (type: number, data: Uint8Array) => {
    const out = new Uint8Array(4 + data.length);
    out.set([type, data.length & 0xff, (data.length >> 8) & 0xff, 0], 0);
    out.set(data, 4);
    return out;
  };
  // Code over 64 KB spans banks: the engine joins them from the highest bank
  // down, so the start of the code goes in the highest bank used.
  const banks = Math.max(1, Math.ceil(code.length / 0x10000));
  const parts = [chunk(12, palette)]; // CHUNK_PALETTE
  for (let k = 0; k < banks; k += 1) parts.push(chunk(5 | ((banks - 1 - k) << 5), code.subarray(k * 0x10000, (k + 1) * 0x10000)));
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
