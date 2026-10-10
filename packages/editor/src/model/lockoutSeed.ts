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
import { meshBounds, serializeMeshAsset, type EncodedImage, type MeshAsset, type MeshPrimitive } from "./MeshAsset";
import type { AnimationClip, ClipChannel, SkinJoint } from "./skeleton";
import { INFINITE_TINTS, type SceneLighting } from "./SceneLighting";
import { plasmaMaterial, type PlasmaLook } from "./plasma";
import type { MeshTrail } from "../render/meshTrails";
import type { SceneLight } from "../render/meshRasterizer";
import { chamferedRect, newStreams, pushBox, pushLoft, toPrimitive, toPrimitive as streamPrimitive, type Streams } from "./seedGeometry";
import { packMeshLibrary } from "./meshLibrary";
import { encodeLods, generateLods, type StoredLods } from "./meshSimplify";
import { reverseClip } from "./clipEdit";
import { serializeFoliage, type FoliageLayer, type SerializedFoliage } from "./foliage";
import { boulderMesh, driftMesh, pineMesh } from "./foliagePresets";
import type { SceneAudio, SceneSound, SynthPreset } from "./sound";
import type { UiDocument, UiWidget } from "./ui";
import type { ComponentDef } from "./components";
import { compileScriptGraph, type ScriptGraph, type ScriptNode, type ScriptWire } from "./scriptGraph";
import type { InputAction } from "./inputActions";
import type { StringTable } from "./strings";
import { bakeNavMesh, boxTriangles, serializeNavMesh, type NavMesh } from "./navmesh";
import { serializeTerrain, terrainMesh, type Terrain } from "./terrain";
import type { SceneTimeline } from "./timeline";
import { builtinDetailGrain } from "./materialEffects";
import { reliefFromHeight } from "./materialLayers";
import type { MaterialGraph } from "./materialGraph";
import { particlePreset, type ParticleEffect } from "./particleEffects";
import { decalPreset, type DecalDef, type DecalMark } from "./decals";
import { applyLightmapImage, bakeLightProbes, bakeLightmap, layoutFingerprint, layoutLightmap, type LightmapLayout } from "./lightmap";
import { base64ToBytes } from "./base64";
import { LOCKOUT_LIGHTMAP } from "./lockoutLightmap.generated";
import { LOCKOUT_PROBES } from "./lockoutProbes.generated";
import { planProbeGrid, type LightProbeGrid, type StoredLightProbes } from "./lightProbes";
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
  /** Height and curvature from the same height field (I4), for wear masks. */
  relief: EncodedImage;
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
      // Alpha: the reflection mask (materialEffects.ts) — polished metal
      // mirrors fully, worn and rough patches much less.
      mr[o + 3] = clampByte(255 * Math.min(1, 0.3 + (1 - s.rough) * 1.2));
      emissive[o] = Math.round(s.r * s.emis);
      emissive[o + 1] = Math.round(s.g * s.emis);
      emissive[o + 2] = Math.round(s.b * s.emis);
      emissive[o + 3] = 255;
    }
  }
  const png = (rgba: Uint8ClampedArray): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(rgba, TEX, TEX, { compress: true }) });
  // The relief (I4): the height the normal map was derived from, and its
  // curvature — the panels' raised rims read as edges, the seams as cavities.
  const relief = reliefFromHeight(samples.map((s) => s.h), TEX, TEX, 8);
  return { albedo: png(albedo), normal: png(normal), metallicRoughness: png(mr), emissive: png(emissive), relief: png(relief) };
}

/**
 * Mountain rock: dark, weathered, split by strata and frost-filled cracks. The
 * terrain maps it flat from above, so on the cliff faces it stretches into the
 * vertical streaks of rain- and ice-worn stone.
 */
function rockSurface(x: number, y: number): Surf {
  const warp = tfbm(x, y, 4, 81, 3) * 40;
  const strata = Math.sin(((y + warp) / TEX) * Math.PI * 2 * 9) * 0.5 + 0.5;
  const grain = tfbm(x, y, 16, 83, 4);
  const crack = seamDistance(wrap(y + warp * 1.7), [30, 101, 170, 222]) < 1.5 && tnoise(x, y, 8, 87) > 0.45 ? 1 : 0;
  const v = 128 + (grain - 0.5) * 70 + (strata - 0.5) * 36 + crack * 70; // cracks hold frost
  const h = tfbm(x, y, 8, 83, 2) * 0.5 + strata * 0.5 - crack * 0.4; // broad relief: small to store
  return { r: clampByte(v - 4), g: clampByte(v), b: clampByte(v + 8), h, rough: 0.9, metal: 0, emis: 0 };
}

/** A small surface baked to just albedo + normal (landscape: no metal, no glow). */
function bakeLandscape(surface: (x: number, y: number) => Surf, strength: number, size: number): { albedo: EncodedImage; normal: EncodedImage } {
  const k = TEX / size; // sample the 256-space painters at this size, still tiling
  const at = (x: number, y: number): Surf => surface((((x % size) + size) % size) * k, (((y % size) + size) % size) * k);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const normal = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      const s = at(x, y);
      albedo.set([s.r, s.g, s.b, 255], o);
      const nx0 = -(at(x + 1, y).h - at(x - 1, y).h) * strength;
      const ny0 = -(at(x, y + 1).h - at(x, y - 1).h) * strength;
      const len = Math.hypot(nx0, ny0, 1);
      normal.set([Math.round((nx0 / len) * 127.5 + 127.5), Math.round((ny0 / len) * 127.5 + 127.5), Math.round((1 / len) * 127.5 + 127.5), 255], o);
    }
  }
  const png = (rgba: Uint8ClampedArray): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(rgba, size, size, { compress: true }) });
  return { albedo: png(albedo), normal: png(normal) };
}

let rockTexture: { albedo: EncodedImage; normal: EncodedImage } | null = null;

interface LockoutTextures {
  readonly wall: BakedSurface;
  readonly floor: BakedSurface;
  readonly snow: BakedSurface;
  /** The fine grain tiled over the metal up close (a detail map; the editor's built-in one). */
  readonly grain: EncodedImage;
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
    grain: builtinDetailGrain(),
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
  flight("x", 8.3, 0.9, 4.4, -1, 1.8, 0), // floor -> the BR lower deck (climbs east onto its open west side, clear of the spur's underside)
  flight("x", 8.95, 1.05, 8.0, -1, 4.0, 1.8), // lower deck -> BR top (climbs east)
  flight("z", 0, 1.4, -6.5, -1, 3.65, 0), // walkway ends: ramps down to the floor, meeting the walkway without a gap
  flight("z", 0, 1.4, 6.5, 1, 3.65, 0),
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

/**
 * What a killed soldier's ragdoll lands on (HALO2_STYLE_ROADMAP.md H9): the
 * same collider boxes the cart collides with, so a body sprawls on the deck,
 * slumps down a ramp or tumbles off a tower edge onto the level below.
 */
export const LOCKOUT_RAGDOLL_COLLIDERS = STRUCT.map(([cx, cy, cz, hx, hy, hz]) => ({ center: [cx, cy, cz] as const, half: [hx, hy, hz] as const }));

/**
 * The bots' walkable surface, baked from the same collider boxes the cart
 * collides with (see navmesh.ts): a soldier's radius from every wall and edge,
 * up every flight of steps, with drops off the ledges. The bots find their own
 * routes over it instead of walking a hand-placed waypoint graph.
 */
export const LOCKOUT_NAV_AGENT = { radius: 0.45, height: 1.7, climb: 0.6, maxSlope: 45, maxDrop: 5 } as const;
let navMesh: NavMesh | null = null;
export function lockoutNavMesh(): NavMesh {
  navMesh ??= bakeNavMesh(boxTriangles(STRUCT), { cell: 0.25, agent: LOCKOUT_NAV_AGENT });
  return navMesh;
}

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

/**
 * Light from the energy trim and markers (EP8): a small cyan point light every
 * ~1.6 m along each strip (and one per vent), just off its face, and one over
 * each weapon marker but the Sword's (the pit light covers it).
 */
function energyLights(): SceneLight[] {
  const cyan = [0.35, 0.92, 1] as const;
  const lights: SceneLight[] = [];
  for (const [cx, cy, cz, hx, , hz] of TRIM) {
    const long = Math.max(hx, hz);
    const n = Math.max(1, Math.round((long * 2) / 1.6));
    for (let i = 0; i < n; i += 1) {
      const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const x = cx + (hx >= hz ? t * hx * 0.9 : 0);
      const z = cz + (hz > hx ? t * hz * 0.9 : 0);
      lights.push({ kind: "point", position: [x, cy + 0.25, z], color: cyan, intensity: 0.7, range: 1.8 });
    }
  }
  for (const [cx, cy, cz] of MARKERS) {
    if (cx === 0 && cy < 2) continue; // the Sword's, lit by the pit
    lights.push({ kind: "point", position: [cx, cy + 0.2, cz], color: cyan, intensity: 1.2, range: 2.4 });
  }
  return lights;
}

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
  [2.6, 0, 11.2], // floor beside the BR structure (south of its ramp)
  [9.9, 4.0, 8.4], // BR top
  [0, 3.65, 0], // central walkway
  [0, 0.7, 0], // sword pit
  [-9, 0, 1.5], // outside the shotgun room
  [6, 0, -6], // floor
];

const BOT_COUNT = 7;

// --- Bot destinations ---------------------------------------------------------
// The bots find their own routes over the arena's baked navmesh (see
// lockoutNavMesh); these are only the places worth going: spots all over the
// floor, the ramps, the tower decks, the walkway and the pit (a test checks each
// stands on the walkable surface and can be reached from every spawn).

/** Places bots roam between: [x, y (feet height), z]. */
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

/** Power positions bots like to hold (indices into NAV_NODES): the sniper deck, the BR top, the walkway centre, the shotgun room. */
const NAV_POWER: readonly number[] = [42, 41, 49, 48, 24, 51];


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

/**
 * The arena's particle effects (HALO2_STYLE_ROADMAP.md H5), fired from the
 * cart with cartbox.burst: sparks where rounds strike the metal, a cyan flare
 * off a shield that takes a hit, a grenade's blast and its smoke, the energy
 * sword's glowing swipe, and snow the wind lifts off the high ledges.
 */
export const LOCKOUT_EFFECTS: readonly ParticleEffect[] = [
  { ...particlePreset("sparks", "spark"), count: 10 },
  { ...particlePreset("plasma", "shield"), count: 10, color: [0.55, 0.95, 1], colorEnd: [0.15, 0.55, 1], size: 0.09, speed: 2.2, life: 0.3 },
  { ...particlePreset("explosion", "blast"), count: 48 },
  { ...particlePreset("smoke", "smoke"), count: 12, color: [0.3, 0.3, 0.32], colorEnd: [0.55, 0.56, 0.6] },
  { ...particlePreset("trail", "slash"), count: 28, color: [0.75, 0.92, 1], colorEnd: [0.25, 0.45, 1] },
  { ...particlePreset("snow", "drift"), count: 16, speed: 1.8, spread: 0.5, gravity: 0.8, life: 2 },
  // A plasma grenade's burst (I10): a ball of blue-white plasma, no fire.
  { ...particlePreset("explosion", "plasmablast"), count: 44, color: [0.7, 0.92, 1], colorEnd: [0.1, 0.35, 1], glow: 4 },
];

/**
 * The arena's decals (HALO2_STYLE_ROADMAP.md H6): pocks where rounds strike
 * and soot burns under grenades (laid by the cart, fading), and — placed for
 * good — cyan Forerunner glyphs on the towers and frost streaked down their
 * weather sides.
 */
export const LOCKOUT_DECALS: readonly DecalDef[] = [
  decalPreset("pock"),
  decalPreset("burn"),
  { ...decalPreset("glyph"), size: 0.9 },
  decalPreset("frost"),
];
export const LOCKOUT_DECAL_MARKS: readonly DecalMark[] = [
  // Glyphs facing the arena: the sniper tower's deck face, the BR tower's west face.
  { decal: "glyph", position: [-4.55, 5.3, -8.6], normal: [1, 0, 0], size: 0, spin: 0 },
  { decal: "glyph", position: [-4.55, 5.3, -10.1], normal: [1, 0, 0], size: 0.6, spin: 90 },
  { decal: "glyph", position: [7.95, 2.7, 6.8], normal: [-1, 0, 0], size: 0, spin: 0 },
  { decal: "glyph", position: [7.95, 2.7, 8.6], normal: [-1, 0, 0], size: 0.6, spin: 270 },
  // Frost streaked down the towers from their tops.
  { decal: "frost", position: [-6.7, 6.1, -6.15], normal: [0, 0, 1], size: 1.8, spin: 0 },
  { decal: "frost", position: [9.6, 3.2, 3.55], normal: [0, 0, -1], size: 1.6, spin: 0 },
  { decal: "frost", position: [-8.4, 6.1, -6.15], normal: [0, 0, 1], size: 1.2, spin: 0 },
];

/** The energy's slow breath (cycles per second, dip at the trough); the panels' glow follows it, gentler. */
const ENERGY_PULSE = { rate: 0.35, depth: 0.35 } as const;
const ENERGY_PULSE_WALL = { rate: 0.35, depth: 0.2 } as const;

/**
 * The energy's glow as a material graph (EP7): its HDR cyan × bands running
 * diagonally across the arena (dot of the world position with an axis, minus
 * time) × the breath (cos of time at ENERGY_PULSE's rate, dipping by a third).
 */
const ENERGY_FLOW: MaterialGraph = {
  nodes: [
    { id: "pos", op: "position", x: 20, y: 20 },
    { id: "axis", op: "constant", params: { value: [2.5, 0.6, 2.5] }, x: 20, y: 90 },
    { id: "along", op: "dot", inputs: { a: "pos", b: "axis" }, x: 210, y: 30 },
    { id: "time", op: "time", x: 20, y: 180 },
    { id: "speed", op: "constant", params: { value: 3 }, x: 20, y: 240 },
    { id: "shift", op: "multiply", inputs: { a: "time", b: "speed" }, x: 210, y: 160 },
    { id: "phase", op: "subtract", inputs: { a: "along", b: "shift" }, x: 400, y: 60 },
    { id: "wave", op: "sin", inputs: { x: "phase" }, x: 400, y: 150 },
    { id: "half", op: "constant", params: { value: 0.5 }, x: 210, y: 260 },
    { id: "wave01", op: "multiply", inputs: { a: "wave", b: "half" }, x: 590, y: 120 },
    { id: "band", op: "add", inputs: { a: "wave01", b: "half" }, x: 590, y: 200 },
    { id: "dim", op: "constant", params: { value: 0.6 }, x: 400, y: 260 },
    { id: "full", op: "constant", params: { value: 1 }, x: 400, y: 330 },
    { id: "flow", op: "mix", inputs: { a: "dim", b: "full", t: "band" }, x: 780, y: 220 },
    { id: "rate", op: "constant", params: { value: 2 * Math.PI * ENERGY_PULSE.rate }, x: 20, y: 330 },
    { id: "beat", op: "multiply", inputs: { a: "time", b: "rate" }, x: 210, y: 340 },
    { id: "cos", op: "cos", inputs: { x: "beat" }, x: 210, y: 420 },
    { id: "swing", op: "constant", params: { value: ENERGY_PULSE.depth / 2 }, x: 20, y: 420 },
    { id: "sway", op: "multiply", inputs: { a: "cos", b: "swing" }, x: 400, y: 420 },
    { id: "rest", op: "constant", params: { value: 1 - ENERGY_PULSE.depth / 2 }, x: 400, y: 500 },
    { id: "breath", op: "add", inputs: { a: "sway", b: "rest" }, x: 590, y: 440 },
    { id: "cyan", op: "constant", params: { value: [0.5, 1.7, 1.9] }, x: 590, y: 300 },
    { id: "lit", op: "multiply", inputs: { a: "cyan", b: "flow" }, x: 960, y: 260 },
    { id: "glow", op: "multiply", inputs: { a: "lit", b: "breath" }, x: 960, y: 380 },
  ],
  outputs: { emissive: "glow" },
};

/**
 * Chipped paint on the Forerunner walls (HALO_INFINITE_STYLE_ROADMAP.md I4): the
 * wall's own colour worn back to bright bare metal along the panels' raised
 * rims, broken up by noise so it chips rather than outlines, and grime settled
 * in the seams — wear masks over the relief baked from the wall's height.
 */
const WALL_WEAR: MaterialGraph = {
  nodes: [
    { id: "paint", op: "baseColor", x: 20, y: 20 },
    { id: "pos", op: "position", x: 20, y: 110 },
    { id: "noise", op: "noise", inputs: { position: "pos" }, params: { scale: 5, octaves: 3 }, x: 210, y: 110 },
    { id: "lo", op: "constant", params: { value: -0.4 }, x: 210, y: 200 },
    { id: "hi", op: "constant", params: { value: 2 }, x: 210, y: 270 },
    { id: "breakup", op: "mix", inputs: { a: "lo", b: "hi", t: "noise" }, x: 400, y: 160 },
    { id: "edge", op: "wear", inputs: { breakup: "breakup" }, params: { side: "edge", amount: 0.5, sharpness: 6 }, x: 590, y: 120 },
    { id: "cavity", op: "wear", params: { side: "cavity", amount: 0.55, sharpness: 3 }, x: 590, y: 260 },
    { id: "bare", op: "constant", params: { value: [0.93, 0.95, 0.98] }, x: 590, y: 20 },
    { id: "chipped", op: "mix", inputs: { a: "paint", b: "bare", t: "edge" }, x: 780, y: 60 },
    { id: "clean", op: "constant", params: { value: 1 }, x: 590, y: 360 },
    { id: "grime", op: "constant", params: { value: 0.55 }, x: 590, y: 430 },
    { id: "dirt", op: "mix", inputs: { a: "clean", b: "grime", t: "cavity" }, x: 780, y: 300 },
    { id: "colour", op: "multiply", inputs: { a: "chipped", b: "dirt" }, x: 970, y: 160 },
  ],
  outputs: { baseColor: "colour" },
};

function mapMesh(): MeshAsset {
  const tex = lockoutTextures();
  const WALL_TEX = tex.wall;
  const FLOOR_TEX = tex.floor;
  const SNOW_TEX = tex.snow;
  // PBR metallic-roughness: the panels are near-pure metal that mirrors the skybox,
  // normal-mapped for relief, with a baked emissive map for the cyan channel.
  const structMat: MeshPrimitive["material"] = {
    name: "forerunner",
    // A cool blue-steel cast over the painted panels: Forerunner metal in the
    // snow light reads blue, never neutral grey.
    baseColorFactor: [0.84, 0.92, 1, 1],
    baseColorImage: WALL_TEX.albedo,
    normalImage: WALL_TEX.normal,
    metallicRoughnessImage: WALL_TEX.metallicRoughness,
    emissiveImage: WALL_TEX.emissive,
    metallicFactor: 0.6, // the map carries per-texel metal; this keeps albedo legible
    roughnessFactor: 1,
    emissiveFactor: [1.6, 1.6, 1.6], // push the baked glow above 1 so it blooms through the tone-map
    // Surface effects (HALO2_STYLE_ROADMAP.md H3): grain up close, the glow
    // breathing with the trim, a cold sheen at grazing angles, and reflections
    // masked to the polished metal.
    detailImage: tex.grain,
    detailScale: 10,
    detailStrength: 0.45,
    emissivePulse: ENERGY_PULSE_WALL,
    rim: { color: [0.55, 0.7, 0.9], power: 4, strength: 0.18 },
    reflectivity: 1.2,
    reflectionMask: true,
    // Chipped edges (I4): wear masks over the wall's relief.
    reliefImage: WALL_TEX.relief,
    graph: WALL_WEAR,
  };
  const floorMat: MeshPrimitive["material"] = {
    name: "forerunner-deck",
    baseColorFactor: [0.82, 0.88, 0.96, 1],
    baseColorImage: FLOOR_TEX.albedo,
    normalImage: FLOOR_TEX.normal,
    metallicRoughnessImage: FLOOR_TEX.metallicRoughness,
    emissiveImage: FLOOR_TEX.emissive,
    metallicFactor: 0.4, // a deck is worn, not a mirror
    // Polished plates (HALO_INFINITE_STYLE_ROADMAP.md I3): smooth enough that the
    // towers and soldiers show in them in screen space; the frosted joints stay rough.
    roughnessFactor: 0.7,
    emissiveFactor: [1.4, 1.4, 1.4],
    detailImage: tex.grain, // the same grain (stored once in the sidecar)
    detailScale: 8,
    detailStrength: 0.5,
    emissivePulse: ENERGY_PULSE_WALL,
    reflectionMask: true,
  };
  // The wall metal, darker and without the glowing channel, for the underside.
  const underMat: MeshPrimitive["material"] = {
    ...structMat,
    name: "forerunner-underside",
    baseColorFactor: [0.5, 0.55, 0.62, 1],
    emissiveImage: null,
    emissiveFactor: [0, 0, 0],
    emissivePulse: undefined,
  };
  // Packed snow: rough, non-metal and cold. Its albedo is held below white
  // because the rig's exposure lifts it — a white albedo blows out to flat paper.
  const snowMat: MeshPrimitive["material"] = {
    name: "snow",
    baseColorFactor: [0.8, 0.82, 0.86, 1],
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
    // The energy trim breathes: a slow pulse, dipping by a third.
    emissivePulse: ENERGY_PULSE,
    // …and flows (ENGINE_PARITY_ROADMAP.md EP7): a material graph runs bands of
    // light along the strips and markers, over the same slow breath.
    graph: ENERGY_FLOW,
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

// --- Baked lighting -----------------------------------------------------------
// The arena ships with a baked light map (lightmap.ts): sky visibility and one
// bounce of sun, so its corners, the walkway's underside and the pit darken and
// the snow lifts the walls beside it. The bake runs offline (npm run
// bake:lockout) and is stored as a PNG in lockoutLightmap.generated.ts; the
// layout is recomputed here (cheap and deterministic) and must match the one the
// stored bake was made for, which its fingerprint checks.

const LIGHTMAP_DENSITY = 4;
let mapLayout: LightmapLayout | null = null;

/** The arena's light-map layout: the map mesh with its second UV set. */
export function lockoutMapLayout(): LightmapLayout {
  mapLayout ??= layoutLightmap(mapMesh(), IDENTITY, { density: LIGHTMAP_DENSITY, maxSize: 1024 });
  return mapLayout;
}

/** Bake the arena's light map from scratch (seconds; the build does this, not the page). */
export function bakeLockoutLightmap(progress?: (done: number) => void): Uint8ClampedArray {
  const layout = lockoutMapLayout();
  return bakeLightmap(layout, [{ mesh: layout.mesh, model: IDENTITY }], { rays: 64, distance: 7, sun: LOCKOUT_KEY_DIRECTION, bounce: 0.9, contrast: 1.25 }, progress);
}

/**
 * Bake the arena's light probes from scratch (EP9): a grid over the map,
 * traced against it with the light map's settings.
 */
export function bakeLockoutProbes(progress?: (done: number) => void): LightProbeGrid {
  const layout = lockoutMapLayout();
  const b = meshBounds(layout.mesh) ?? { min: [-1, -1, -1] as const, max: [1, 1, 1] as const };
  const min: [number, number, number] = [b.min[0] - 1, b.min[1], b.min[2] - 1];
  const max: [number, number, number] = [b.max[0] + 1, b.max[1] + 2, b.max[2] + 1];
  return bakeLightProbes(min, max, planProbeGrid(min, max, 2.5), [{ mesh: layout.mesh, model: IDENTITY }], { rays: 64, distance: 7, sun: LOCKOUT_KEY_DIRECTION, bounce: 0.9, contrast: 1.25 }, progress);
}

/** The stored probe bake, when it was made for the arena as it is now (null when stale or not yet baked). */
function lockoutProbes(): StoredLightProbes | null {
  return LOCKOUT_PROBES.probes && LOCKOUT_PROBES.fingerprint === layoutFingerprint(lockoutMapLayout()) ? LOCKOUT_PROBES.probes : null;
}

/** The map as it ships: laid out and carrying the stored bake (or unlit, when the bake is stale). */
function litMapMesh(): MeshAsset {
  const layout = lockoutMapLayout();
  if (LOCKOUT_LIGHTMAP.fingerprint !== layoutFingerprint(layout)) return mapMesh();
  return applyLightmapImage(layout.mesh, { mime: "image/png", bytes: base64ToBytes(LOCKOUT_LIGHTMAP.png) });
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
/** Toward the sun (matches the lighting rig's key light): high noon, about 52° up (I8). */
const LOCKOUT_KEY_DIRECTION: readonly [number, number, number] = [0.42, 0.8, -0.46];

// --- The mountains ------------------------------------------------------------
// Lockout hangs in a gorge high in an icy range: sheer cliffs drop from all
// round the facility into a chasm with no visible floor, and snow-loaded peaks
// crowd in above them. That landscape is a terrain (a heightfield the player
// builds into geometry at load), so it costs a few kilobytes, not a mesh.

/** Hashed value noise over an unbounded plane (period 2²⁰ — no visible repeat). */
function vnoise(x: number, y: number, seed: number, periodX = 1 << 20): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = thash(xi, yi, seed, periodX);
  const b = thash(xi + 1, yi, seed, periodX);
  const c = thash(xi, yi + 1, seed, periodX);
  const d = thash(xi + 1, yi + 1, seed, periodX);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Ridged multifractal: sharp crests where plain noise would be rounded hills. */
function ridged(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i += 1) {
    const f = 1 << i;
    let n = 1 - Math.abs(vnoise(x * f, y * f, seed + i * 17) * 2 - 1);
    n *= n * weight;
    weight = Math.min(1, n * 1.6);
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

const smooth = (e0: number, e1: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** How deep the chasm goes — well past where the fog swallows it. */
const CHASM = -95;
const TERRAIN_SIZE = 320;
const TERRAIN_SAMPLES = 97;

/** The ground height round the arena at (x, z): chasm, cliff, rim, then peaks. */
function lockoutGround(x: number, z: number): number {
  // An ellipse hugging the deck (wider in X), wobbling round its circumference.
  const r = Math.hypot(x * 0.95, z * 1.12);
  const turn = (Math.atan2(z, x) / (Math.PI * 2) + 1) % 1; // 0..1 round the arena
  const around = (cycles: number, seed: number) => vnoise(turn * cycles, 0.5, seed, cycles);
  const inner = 30 + 8 * around(9, 3) + 3 * around(23, 5);
  // The rim stands tallest behind the sniper tower (north-west) and dips on the
  // east, so the far range shows through a notch.
  const west = Math.cos((turn - 0.62) * Math.PI * 2) * 0.5 + 0.5;
  const rim = 3 + 20 * around(5, 7) * (0.45 + 0.55 * west) + 10 * west;
  if (r < inner) return CHASM;
  // Sheer walls: most of the height gained in the first few units, broken into
  // buttresses and gullies by noise that runs down the face.
  const wall = smooth(0, 1, (r - inner) / 11) ** 0.55;
  const gullies = (vnoise(turn * 60, (r - inner) * 0.08, 11, 60) - 0.5) * 9;
  const cliff = CHASM + (rim - CHASM) * wall + gullies * wall * (1 - wall) * 4;
  // Beyond the rim, the range: ridged crests rising toward a ring of peaks.
  const out = smooth(inner + 8, inner + 70, r);
  const peaks = 22 + 85 * ridged(x / 70, z / 70, 21);
  let h = cliff + (peaks - rim) * out + (vnoise(x / 9, z / 9, 31) - 0.5) * 5 * smooth(inner + 5, inner + 20, r);
  // The edge of the grid falls away behind the crests, so it never shows.
  h -= smooth(TERRAIN_SIZE * 0.4, TERRAIN_SIZE * 0.5, Math.max(Math.abs(x), Math.abs(z))) * 120;
  return h;
}

let terrain: Terrain | null = null;

/** Lockout's landscape: the gorge, its cliffs and the range round it. */
export function lockoutTerrain(): Terrain {
  if (terrain) return terrain;
  const n = TERRAIN_SAMPLES;
  const origin: [number, number, number] = [-TERRAIN_SIZE / 2, 0, -TERRAIN_SIZE / 2];
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      heights[j * n + i] = lockoutGround(origin[0] + (i / (n - 1)) * TERRAIN_SIZE, origin[2] + (j / (n - 1)) * TERRAIN_SIZE);
    }
  }
  // Snow wherever it can lie, and dark weathered rock on the faces too steep to
  // hold it (one texture, stored once).
  const snow: MeshPrimitive["material"] = { name: "terrain-snow", baseColorFactor: [0.86, 0.88, 0.92, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.85 };
  rockTexture ??= bakeLandscape(rockSurface, 3, 128);
  const stone = { baseColorImage: rockTexture.albedo, normalImage: rockTexture.normal, metallicFactor: 0 };
  const rock: MeshPrimitive["material"] = { name: "terrain-rock", baseColorFactor: [0.26, 0.28, 0.32, 1], ...stone, roughnessFactor: 0.9 };
  terrain = {
    id: "lockout-range",
    name: "Mountains",
    origin,
    size: [TERRAIN_SIZE, TERRAIN_SIZE],
    samples: n,
    heights,
    layers: [
      { material: snow, up: [0.7, 1] },
      { material: rock },
    ],
    floor: CHASM + 25,
    tile: 14,
    // On the map, so the menus' hiding the map hides the mountains with it.
    parent: "lockout-map",
    // Snow thins into rock across a band of slope, its edge wandering so it
    // reads as drifts in the hollows and wind-scoured ridges (H4)…
    blend: { up: 0.16, height: 2, noise: 0.7 },
    // …and the gorge walls shade the deck when the sun is low.
    castShadows: true,
  };
  return terrain;
}

/**
 * A forest canopy seen from far off: dark crowns in clumps, gaps of shadow
 * between them and a frosting of snow on the tops.
 */
function forestSurface(x: number, y: number): Surf {
  const crowns = tfbm(x, y, 24, 91, 3);
  const clumps = tfbm(x, y, 6, 93, 2);
  const gap = crowns < 0.42 ? 1 : 0;
  const frost = crowns > 0.62 && tnoise(x, y, 32, 95) > 0.55 ? 1 : 0;
  const v = 70 + (crowns - 0.5) * 60 + (clumps - 0.5) * 30 - gap * 30;
  return { r: clampByte(v * 0.55 + frost * 90), g: clampByte(v * 0.8 + frost * 90), b: clampByte(v * 0.62 + frost * 100), h: crowns - gap * 0.3, rough: 0.95, metal: 0, emis: 0 };
}

let forestTexture: { albedo: EncodedImage; normal: EncodedImage } | null = null;
let farRockTexture: { albedo: EncodedImage; normal: EncodedImage } | null = null;
/** The vista's texture size (texels a side). */
const VISTA_TEXTURE = 48;

/** The vista's extent (I7): far past the near range, out to the great peaks. */
const VISTA_SIZE = 2400;
const VISTA_SAMPLES = 97;
/** The vista leaves out this square round the arena (half its side). */
const VISTA_HOLE = 170;
/** The far ground at (x, z): a forested valley ringing the near range, rising to a wall of great peaks. */
function lockoutFarGround(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const valley = 5 + (vnoise(x / 70, z / 70, 51) - 0.5) * 40 + ridged(x / 120, z / 120, 55) * 50 * smooth(180, 400, r);
  const peaks = 220 + 700 * ridged(x / 280, z / 280, 53);
  return valley + (peaks - valley) * smooth(420, 1000, r);
}

let vista: Terrain | null = null;

/**
 * Lockout's distant vista (HALO_INFINITE_STYLE_ROADMAP.md I7): the forested
 * valleys round the near range and the great peaks beyond, drawn once into
 * the sky — snow on the heights, rock on the faces, forest on the low ground.
 */
export function lockoutVista(): Terrain {
  if (vista) return vista;
  const n = VISTA_SAMPLES;
  const origin: [number, number, number] = [-VISTA_SIZE / 2, 0, -VISTA_SIZE / 2];
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      heights[j * n + i] = lockoutFarGround(origin[0] + (i / (n - 1)) * VISTA_SIZE, origin[2] + (j / (n - 1)) * VISTA_SIZE);
    }
  }
  // The middle is cut away: the near range and the gorge (bottomless mist) are real geometry.
  const holes = new Uint8Array((n - 1) * (n - 1));
  const cell = VISTA_SIZE / (n - 1);
  for (let j = 0; j < n - 1; j += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      const x = origin[0] + (i + 0.5) * cell;
      const z = origin[2] + (j + 0.5) * cell;
      if (Math.max(Math.abs(x), Math.abs(z)) < VISTA_HOLE) holes[j * (n - 1) + i] = 1;
    }
  }
  // Small maps (seen from kilometres off, a finer grain only shimmers), so the range costs little to store.
  farRockTexture ??= bakeLandscape(rockSurface, 3, VISTA_TEXTURE);
  forestTexture ??= bakeLandscape(forestSurface, 2, VISTA_TEXTURE);
  const snow: MeshPrimitive["material"] = { name: "vista-snow", baseColorFactor: [0.82, 0.86, 0.92, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.85 };
  const forest: MeshPrimitive["material"] = { name: "vista-forest", baseColorFactor: [0.38, 0.46, 0.4, 1], baseColorImage: forestTexture.albedo, normalImage: forestTexture.normal, metallicFactor: 0, roughnessFactor: 0.95 };
  const rock: MeshPrimitive["material"] = { name: "vista-rock", baseColorFactor: [0.3, 0.32, 0.36, 1], baseColorImage: farRockTexture.albedo, normalImage: farRockTexture.normal, metallicFactor: 0, roughnessFactor: 0.9 };
  vista = {
    id: "lockout-vista",
    name: "Far range",
    origin,
    size: [VISTA_SIZE, VISTA_SIZE],
    samples: n,
    heights,
    layers: [
      { material: snow, up: [0.6, 1], height: [220, 5000] },
      { material: forest, up: [0.62, 1], height: [-200, 180] },
      { material: rock },
    ],
    holes,
    // Broad repeats: from this far, a fine rock grain only shimmers.
    tile: 180,
    blend: { up: 0.14, height: 40, noise: 0.7 },
    vista: { haze: 0.4 },
  };
  return vista;
}

/** The preset pine in the dark needles of a mountain forest (the preset's are a garden green). */
function farPine(): MeshAsset {
  const pine = pineMesh();
  return { ...pine, primitives: pine.primitives.map((p) => (p.material.name === "needles" ? { ...p, material: { ...p.material, baseColorFactor: [0.07, 0.14, 0.09, 1] } } : p)) };
}

/** The forest edge on the vista: pines over the valleys' gentle ground, giant at this range. */
export const LOCKOUT_VISTA_FOREST: FoliageLayer = {
  id: "lockout-vista-pines",
  name: "Far pines",
  terrain: "lockout-vista",
  density: 0.06,
  scale: [5, 8],
  align: 0,
  sink: 0.1,
  cull: 3000,
  copies: [],
  fill: { seed: 61, up: [0.75, 1], height: [-200, 150] },
};

/**
 * Lockout's foliage (EP11): boulders strewn over the range's slopes and snow
 * drifts banked on its flats, filled by rules (nothing stored per copy) and
 * kept back from the gorge so none of it reaches the play space.
 */
export const LOCKOUT_FOLIAGE: readonly FoliageLayer[] = [
  {
    id: "lockout-boulders",
    name: "Boulders",
    terrain: "lockout-range",
    density: 0.5,
    scale: [1.2, 4.2],
    align: 0.85,
    sink: 0.15,
    cull: 260,
    copies: [],
    fill: { seed: 41, up: [0.45, 0.93], height: [-40, 400], clear: [TERRAIN_SIZE / 2, TERRAIN_SIZE / 2, 48] },
  },
  {
    id: "lockout-drifts",
    name: "Snow drifts",
    terrain: "lockout-range",
    density: 0.7,
    scale: [1.4, 4],
    align: 1,
    sink: 0.05,
    cull: 220,
    copies: [],
    fill: { seed: 7, up: [0.84, 1], height: [-20, 400], clear: [TERRAIN_SIZE / 2, TERRAIN_SIZE / 2, 48] },
  },
];

/**
 * Lockout's sound (EP12): every weapon's report, the sword's swing and a
 * grenade's blast synthesised from built-in recipes (positional, so a bot's
 * fire across the map pans and fades), the wind moaning through the gorge,
 * and the announcer calling multikills and sprees — a few hundred bytes.
 */
/**
 * Lockout's HUD and start menu as UI documents (EP13), laid out on its
 * 1280 × 720 screen: the cart sets their bindings (shield, ammo, the score
 * line, the kill feed, the announcer) and draws them with cartbox.ui; the
 * menu's game-type list moves with the d-pad. Drawn custom still: the
 * reticle, the grenade pips and the motion tracker.
 */
const txt = (id: string, x: number, y: number, w: number, h: number, text: string, color: number, scale: number, extra: Partial<UiWidget> = {}): UiWidget => ({ id, kind: "text", anchor: [0, 0], pivot: [0, 0], offset: [x, y], size: [w, h], text, color, scale, small: true, ...extra });
export const LOCKOUT_UI: UiDocument[] = [
  {
    name: "hud",
    widgets: [
      { id: "shield", kind: "bar", anchor: [0, 0], pivot: [0, 0], offset: [40, 40], size: [300, 20], fill: 5, color: 9, value: "hp1", tint: "hpc" },
      { id: "health", kind: "bar", anchor: [0, 0], pivot: [0, 0], offset: [40, 66], size: [300, 12], fill: 5, color: 6, value: "hp2", visible: "shields" },
      txt("weapon", 900, 40, 340, 12, "{weapon}", 12, 2),
      txt("ammo", 1040, 74, 200, 12, "{ammo}", 12, 2, { tint: "ammoc" }),
      txt("frag", 1150, 96, 60, 6, "@hud.frag", 13, 1),
      txt("mode", 540, 40, 700, 6, "{mode}", 13, 1),
      txt("status", 540, 58, 700, 12, "{status}", 12, 2),
      { id: "feed", kind: "list", anchor: [0, 0], pivot: [0, 0], offset: [872, 165], size: [400, 132], row: 22, value: "feed", color: 12, scale: 1, small: true },
      txt("announce", 540, 150, 700, 18, "{announce}", 12, 3, { tint: "announcec", visible: "announce" }),
      txt("respawn", 520, 330, 400, 18, "@hud.respawn", 6, 3, { visible: "dead" }),
    ],
  },
  {
    name: "menu",
    widgets: [
      txt("top", 330, 150, 800, 6, "{menutop}", 13, 1, { tint: "menutopc" }),
      { id: "modes", kind: "list", anchor: [0, 0], pivot: [0, 0], offset: [470, 190], size: [360, 320], row: 40, value: "modes", color: 13, focusFill: 1, focusColor: 12, scale: 2, small: true },
      txt("keys", 430, 540, 800, 6, "@menu.keys", 13, 1),
      txt("move", 300, 584, 900, 6, "@menu.move", 13, 1),
      txt("fire", 300, 612, 900, 6, "@menu.fire", 13, 1),
      txt("pad", 260, 640, 1000, 6, "@menu.pad", 13, 1),
      txt("career", 330, 676, 800, 6, "{career}", 9, 1),
    ],
  },
];

/**
 * Lockout's string table (EP19b): its UI's fixed texts, game type and weapon
 * names, and the in-match messages (announcements, kill feed, status line) in
 * English and Spanish. The console font is ASCII, so the Spanish is written
 * without accents. Lua reads it through cartbox.text, keeping the English as
 * written when no table is loaded (see T in LOCKOUT_CODE).
 */
export const LOCKOUT_STRINGS: StringTable = {
  languages: ["en", "es"],
  fallback: "en",
  entries: [
    { key: "hud.frag", text: { en: "FRAG", es: "GRANADA" } },
    { key: "hud.respawn", text: { en: "RESPAWNING...", es: "REAPARECIENDO..." } },
    { key: "menu.keys", text: { en: "Up/Down choose . Z (or A) select . Start: controls, audio & more", es: "Arriba/Abajo elige . Z (o A) acepta . Start: controles, audio y mas" } },
    { key: "menu.move", text: { en: "Move Up/Down . Turn Left/Right . hold A strafe . dbl-tap A grenade", es: "Mover Arriba/Abajo . Girar Izq/Der . manten A lateral . doble A granada" } },
    { key: "menu.fire", text: { en: "Z fire (auto-melee close) . X/Space jump . S/Tab swap . G/Q grenade . sniper: Shift (or hold A) to zoom", es: "Z dispara (cuerpo a cuerpo de cerca) . X/Espacio salta . S/Tab cambia . G/Q granada . francotirador: Shift (o manten A) apunta" } },
    { key: "menu.pad", text: { en: "Touch/controller: left stick moves . right stick aims . A fire . B jump . X zoom/grenade . Y swap . LT grenade", es: "Tactil/mando: stick izq mueve . stick der apunta . A dispara . B salta . X zoom/granada . Y cambia . LT granada" } },
    { key: "menu.top", text: { en: "Matchmaking finds players online . or play the game types below vs 7 bots", es: "Partida en linea busca jugadores . o juega estos modos contra 7 bots" } },
    { key: "menu.matchmaking", text: { en: "Matchmaking (online)", es: "Partida en linea" } },
    { key: "mode.ffa", text: { en: "Free for All", es: "Todos contra todos" } },
    { key: "mode.slayer", text: { en: "Team Slayer", es: "Asesino por equipos" } },
    { key: "mode.swat", text: { en: "SWAT", es: "SWAT" } },
    { key: "mode.snipe", text: { en: "Team Snipers", es: "Francotiradores" } },
    { key: "mode.ball", text: { en: "Oddball", es: "Bola rara" } },
    { key: "mode.koth", text: { en: "King of the Hill", es: "Rey de la colina" } },
    { key: "mode.jugg", text: { en: "Juggernaut", es: "Coloso" } },
    { key: "menu.host", text: { en: "ONLINE  --  you are the host  --  {1} player(s) + {2} bots", es: "EN LINEA  --  eres el anfitrion  --  {1} jugador(es) + {2} bots" } },
    { key: "weapon.br", text: { en: "Battle Rifle", es: "Rifle de batalla" } },
    { key: "weapon.smg", text: { en: "SMG", es: "Subfusil" } },
    { key: "weapon.shotgun", text: { en: "Shotgun", es: "Escopeta" } },
    { key: "weapon.sniper", text: { en: "Sniper Rifle", es: "Rifle de precision" } },
    { key: "weapon.magnum", text: { en: "Magnum", es: "Magnum" } },
    { key: "weapon.sword", text: { en: "Energy Sword", es: "Espada de energia" } },
    { key: "msg.ball", text: { en: "You have the ball", es: "Tienes la bola" } },
    { key: "msg.hill", text: { en: "Hill moved", es: "La colina se movio" } },
    { key: "msg.jugg", text: { en: "JUGGERNAUT", es: "COLOSO" } },
    { key: "msg.hunted", text: { en: "YOU ARE THE HUNTED", es: "ERES LA PRESA" } },
    { key: "msg.double", text: { en: "Double Kill!", es: "Doble baja!" } },
    { key: "msg.triple", text: { en: "Triple Kill!", es: "Triple baja!" } },
    { key: "msg.overkill", text: { en: "Overkill!", es: "Masacre!" } },
    { key: "msg.killtacular", text: { en: "Killtacular!", es: "Bajatacular!" } },
    { key: "msg.spree", text: { en: "Killing Spree!", es: "Racha asesina!" } },
    { key: "msg.frenzy", text: { en: "Killing Frenzy!", es: "Frenesi asesino!" } },
    { key: "msg.riot", text: { en: "Running Riot!", es: "Imparable!" } },
    { key: "msg.pickup", text: { en: "Picked up {1}", es: "Recogiste {1}" } },
    { key: "feed.headshot", text: { en: "  (headshot)", es: "  (a la cabeza)" } },
    { key: "status.teams", text: { en: "BLUE {1}   RED {2}   /{3}", es: "AZUL {1}   ROJO {2}   /{3}" } },
    { key: "status.holdball", text: { en: "YOU HOLD THE BALL  ", es: "TIENES LA BOLA  " } },
    { key: "status.ball", text: { en: "Ball {1} /{2}", es: "Bola {1} /{2}" } },
    { key: "status.hill", text: { en: "Hill {1} /{2}", es: "Colina {1} /{2}" } },
    { key: "status.youjugg", text: { en: "YOU ARE THE JUGGERNAUT  ", es: "ERES EL COLOSO  " } },
    { key: "status.huntjugg", text: { en: "Hunt the Juggernaut  ", es: "Caza al Coloso  " } },
    { key: "status.score", text: { en: "Score {1}   Deaths {2}   /{3}", es: "Puntos {1}   Muertes {2}   /{3}" } },
    { key: "hud.motion", text: { en: "MOTION", es: "RADAR" } },
  ],
};

const gun = (id: string, synth: SynthPreset): SceneSound => ({ name: `fire_${id}`, source: { kind: "synth", synth }, bus: "sfx", volume: 0.8, range: [6, 90] });
const vox = (name: string, text: string): SceneSound => ({ name, source: { kind: "speech", text }, bus: "voice", volume: 1 });
export const LOCKOUT_AUDIO: SceneAudio = {
  buses: [
    { name: "sfx", volume: 0.9 },
    { name: "voice", volume: 1 },
    { name: "ambience", volume: 0.5 },
  ],
  sounds: [
    gun("br", "rifle"),
    gun("smg", "smg"),
    gun("shotgun", "shotgun"),
    gun("sniper", "sniper"),
    gun("magnum", "pistol"),
    gun("sword", "swing"),
    { name: "blast", source: { kind: "synth", synth: "explosion" }, bus: "sfx", volume: 1, range: [8, 120] },
    { name: "wind", source: { kind: "synth", synth: "wind" }, bus: "ambience", volume: 1, loop: true },
    vox("v2", "Double kill"),
    vox("v3", "Triple kill"),
    vox("v4", "Overkill"),
    vox("v5", "Killtacular"),
    vox("s5", "Killing spree"),
    vox("s10", "Killing frenzy"),
    vox("s15", "Running riot"),
    vox("jug", "Juggernaut"),
  ],
  emitters: [{ sound: "wind", volume: 1 }],
};

function lockoutFoliage(): SerializedFoliage[] {
  const t = lockoutTerrain();
  const meshes = [serializeMeshAsset(boulderMesh(11, [0.3, 0.31, 0.34])), serializeMeshAsset(driftMesh(5))];
  return [...LOCKOUT_FOLIAGE.map((layer, k) => serializeFoliage(t, layer, meshes[k]!)), serializeFoliage(lockoutVista(), LOCKOUT_VISTA_FOREST, serializeMeshAsset(farPine()))];
}

/** Triangles the landscape draws (it isn't part of the arena's budget). */
export function lockoutTerrainTriangles(): number {
  return terrainMesh(lockoutTerrain()).primitives.reduce((n, p) => n + p.indices.length / 3, 0);
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
/** The armour paint's lacquer (I4): a glossy clearcoat the base shows through. */
const ARMOR_LACQUER = { clearcoat: 0.8, clearcoatRoughness: 0.08 } as const;

/**
 * Drop texture coordinates from primitives that have no texture — the soldiers
 * and weapons are flat PBR colours, and UVs are a quarter of every vertex. A
 * brushed (anisotropic) surface keeps them: its grain runs along U (I4).
 */
function withoutUnusedUvs(mesh: MeshAsset): MeshAsset {
  return {
    name: mesh.name,
    primitives: mesh.primitives.map((p) =>
      p.material.baseColorImage || p.material.normalImage || p.material.metallicRoughnessImage || p.material.emissiveImage || p.material.reliefImage || (p.material.anisotropy ?? 0) !== 0
        ? p
        : { ...p, uvs: null },
    ),
  };
}

// --- The soldier's skeleton -------------------------------------------------
// Each armour piece is bound rigidly to one bone (plates don't stretch), and the
// clips move the bones, so the engine's skeletal animation (skeleton.ts) plays a
// real run cycle — blended from idle by speed, a jump pose in the air, a fall
// when killed — instead of flipping between a few baked stride frames.

/** Bone indices of the soldier's skeleton. */
const J = {
  hips: 0, spine: 1, chest: 2, head: 3,
  armL: 4, foreL: 5, armR: 6, foreR: 7,
  thighL: 8, shinL: 9, footL: 10, thighR: 11, shinR: 12, footR: 13,
} as const;

/** A point `length` down from `from`, swung forward by `angle` about the X axis. */
function swing(from: P3, length: number, angle: number): P3 {
  return [from[0], from[1] - length * Math.cos(angle), from[2] + length * Math.sin(angle)];
}

/** Where each bone sits at rest (world space, feet at y = 0), and its parent. */
function soldierBones(): { name: string; parent: number; at: P3 }[] {
  const hipL: P3 = [-0.13 * 1.05, 0.92, 0];
  const hipR: P3 = [0.13 * 1.05, 0.92, 0];
  const knee = (hip: P3) => swing(hip, 0.42, 0);
  const ankle = (hip: P3) => swing(knee(hip), 0.4, -0.05);
  return [
    { name: "hips", parent: -1, at: [0, 0.94, 0] },
    { name: "spine", parent: J.hips, at: [0, 1.07, 0] },
    { name: "chest", parent: J.spine, at: [0, 1.27, 0] },
    { name: "head", parent: J.chest, at: [0, 1.55, 0] },
    { name: "upperarm_l", parent: J.chest, at: [-0.33, 1.42, 0] },
    { name: "forearm_l", parent: J.armL, at: [-0.3, 1.12, 0.05] },
    { name: "upperarm_r", parent: J.chest, at: [0.33, 1.42, 0] },
    { name: "forearm_r", parent: J.armR, at: [0.3, 1.12, 0.05] },
    { name: "thigh_l", parent: J.hips, at: hipL },
    { name: "shin_l", parent: J.thighL, at: knee(hipL) },
    { name: "foot_l", parent: J.shinL, at: ankle(hipL) },
    { name: "thigh_r", parent: J.hips, at: hipR },
    { name: "shin_r", parent: J.thighR, at: knee(hipR) },
    { name: "foot_r", parent: J.shinR, at: ankle(hipR) },
  ];
}

/** Geometry for one material, remembering which bone each vertex belongs to. */
interface Bound {
  readonly s: Streams;
  readonly bone: number[];
}
const bound = (): Bound => ({ s: newStreams(), bone: [] });
/** Draw into `b`, binding every new vertex to `joint`. */
function on(b: Bound, joint: number, draw: (s: Streams) => void): void {
  const before = b.s.positions.length / 3;
  draw(b.s);
  for (let i = before; i < b.s.positions.length / 3; i += 1) b.bone.push(joint);
}
function boundPrimitive(b: Bound, material: Mat): MeshPrimitive {
  const n = b.bone.length;
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    joints[i * 4] = b.bone[i]!;
    weights[i * 4] = 1;
  }
  return { ...toPrimitive(b.s, material), uvs: null, joints, weights };
}

/** A quaternion turning `angle` radians about a unit axis. */
function quat(ax: number, ay: number, az: number, angle: number): [number, number, number, number] {
  const h = angle / 2;
  const s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
}
/** q = a then b (b applied after a). */
function qmul(b: readonly number[], a: readonly number[]): [number, number, number, number] {
  return [
    b[3]! * a[0]! + b[0]! * a[3]! + b[1]! * a[2]! - b[2]! * a[1]!,
    b[3]! * a[1]! - b[0]! * a[2]! + b[1]! * a[3]! + b[2]! * a[0]!,
    b[3]! * a[2]! + b[0]! * a[1]! - b[1]! * a[0]! + b[2]! * a[3]!,
    b[3]! * a[3]! - b[0]! * a[0]! - b[1]! * a[1]! - b[2]! * a[2]!,
  ];
}
/** Pitch (about X: positive tips +Y toward +Z, so a leg swung by a negative pitch reaches forward), then yaw. */
const pitchYaw = (pitch: number, yaw = 0, roll = 0) => qmul(quat(0, 0, 1, roll), qmul(quat(0, 1, 0, yaw), quat(1, 0, 0, pitch)));

/**
 * A clip from per-bone rotation curves (and a hips height/offset curve),
 * sampled at `keys` evenly spaced moments over `duration` seconds; `at(t)` gets
 * the phase 0..1 and returns each animated bone's rotation.
 */
function clipFrom(
  name: string,
  duration: number,
  keys: number,
  bones: readonly { at: P3 }[],
  sample: (t: number) => { rot: Partial<Record<number, readonly number[]>>; hips?: P3 },
): AnimationClip {
  const times = new Float32Array(keys);
  const rots = new Map<number, number[]>();
  const hips: number[] = [];
  for (let k = 0; k < keys; k += 1) {
    const t = keys === 1 ? 0 : k / (keys - 1);
    times[k] = t * duration;
    const pose = sample(t);
    for (const [joint, q] of Object.entries(pose.rot)) {
      const list = rots.get(Number(joint)) ?? [];
      list.push(...q!);
      rots.set(Number(joint), list);
    }
    const h = pose.hips ?? [0, 0, 0];
    hips.push(bones[J.hips]!.at[0] + h[0], bones[J.hips]!.at[1] + h[1], bones[J.hips]!.at[2] + h[2]);
  }
  const channels: ClipChannel[] = [...rots].map(([joint, values]) => ({
    joint,
    path: "rotation" as const,
    interpolation: "linear" as const,
    times,
    values: new Float32Array(values),
  }));
  channels.push({ joint: J.hips, path: "translation", interpolation: "linear", times, values: new Float32Array(hips) });
  return { name, duration, channels };
}

/** The soldier's clips: idle, run, air (a jump pose), die (topples back and lies still). */
function soldierClips(bones: readonly { at: P3 }[]): AnimationClip[] {
  const TAU = Math.PI * 2;
  const idle = clipFrom("idle", 2.4, 9, bones, (t) => {
    const breathe = Math.sin(t * TAU);
    return {
      rot: {
        [J.spine]: pitchYaw(0.03 + breathe * 0.015),
        [J.head]: pitchYaw(0, Math.sin(t * TAU) * 0.12),
        [J.shinL]: pitchYaw(0.08),
        [J.shinR]: pitchYaw(0.08),
        [J.thighL]: pitchYaw(-0.05),
        [J.thighR]: pitchYaw(-0.05),
      },
      hips: [0, -0.01 + breathe * 0.004, 0],
    };
  });
  // A jogging stride: thighs swing opposite each other, the knee folds as the
  // leg comes through and the foot flicks level, the body leans in, bobs twice
  // a cycle and twists against the legs.
  const leg = (phase: number) => {
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const thigh = -0.55 * s; // negative pitch = forward
    const knee = 0.2 + 0.85 * Math.max(0, c); // fold while the leg swings through
    return { thigh: pitchYaw(thigh), shin: pitchYaw(knee), foot: pitchYaw(-0.3 * Math.max(0, c) + 0.15 * Math.max(0, -s)) };
  };
  const run = clipFrom("run", 0.66, 13, bones, (t) => {
    const a = t * TAU;
    const l = leg(a);
    const r = leg(a + Math.PI);
    return {
      rot: {
        [J.thighL]: l.thigh, [J.shinL]: l.shin, [J.footL]: l.foot,
        [J.thighR]: r.thigh, [J.shinR]: r.shin, [J.footR]: r.foot,
        [J.hips]: pitchYaw(0, Math.sin(a) * 0.12),
        [J.spine]: pitchYaw(0.14, -Math.sin(a) * 0.16),
        [J.chest]: pitchYaw(0.04 + Math.abs(Math.cos(a)) * 0.03),
        [J.head]: pitchYaw(-0.16),
      },
      hips: [0, -0.05 + Math.abs(Math.cos(a)) * 0.05, 0],
    };
  });
  const air = clipFrom("air", 0.5, 2, bones, () => ({
    rot: {
      [J.thighL]: pitchYaw(-0.9), [J.shinL]: pitchYaw(1.3), [J.footL]: pitchYaw(-0.3),
      [J.thighR]: pitchYaw(-0.2), [J.shinR]: pitchYaw(0.7),
      [J.spine]: pitchYaw(0.12),
      [J.armL]: pitchYaw(-0.2, 0, -0.15), [J.armR]: pitchYaw(-0.2, 0, 0.15),
    },
    hips: [0, 0.04, 0],
  }));
  // Knocked back off its feet: the body tips back about the hips as it drops,
  // the knees buckle and the arms fly out, then it lies still.
  const die = clipFrom("die", 0.9, 10, bones, (t) => {
    const fall = Math.min(1, t * 1.25);
    const ease = 1 - (1 - fall) * (1 - fall);
    return {
      rot: {
        [J.hips]: pitchYaw(-1.45 * ease),
        [J.spine]: pitchYaw(-0.2 * ease),
        [J.head]: pitchYaw(-0.3 * ease),
        [J.thighL]: pitchYaw(-1.1 * ease), [J.shinL]: pitchYaw(1.2 * ease),
        [J.thighR]: pitchYaw(-0.6 * ease), [J.shinR]: pitchYaw(0.5 * ease),
        [J.armL]: pitchYaw(-1.4 * ease, 0, -0.5 * ease), [J.armR]: pitchYaw(-1.2 * ease, 0, 0.6 * ease),
      },
      hips: [0, -0.74 * ease, -0.35 * ease],
    };
  });
  // For the 2D move blend (EP17b): stepping sideways while facing ahead — the
  // legs swing out to the side, the hips turn into the step and the chest
  // turns back to face forward — and a back-pedal (the run played backwards).
  const strafe = (name: string, dir: 1 | -1) =>
    clipFrom(name, 0.6, 9, bones, (t) => {
      const a = t * TAU;
      const s = Math.sin(a);
      const fold = (c: number) => 0.25 + 0.6 * Math.max(0, c);
      return {
        rot: {
          [J.thighL]: pitchYaw(-0.15, 0, dir * 0.35 * s), [J.shinL]: pitchYaw(fold(Math.cos(a))),
          [J.thighR]: pitchYaw(-0.15, 0, dir * 0.35 * s), [J.shinR]: pitchYaw(fold(-Math.cos(a))),
          [J.hips]: pitchYaw(0, dir * 0.35),
          [J.spine]: pitchYaw(0.1, -dir * 0.35),
        },
        hips: [0, -0.04 + Math.abs(Math.cos(a)) * 0.04, 0],
      };
    });
  const back = { ...reverseClip(run), name: "back" };
  return [idle, run, air, die, strafe("strafeR", 1), strafe("strafeL", -1), back];
}

/**
 * The soldier's state machine: a 2D blend space (EP17b) by `speed` (forward,
 * −1 back-pedalling … 1 running) and `side` (−1 left … 1 right) — idle in the
 * middle, run ahead, back-pedal behind, a strafe to each side — `air` while not
 * `grounded`, `die` while `dead`.
 */
export const LOCKOUT_SOLDIER_ANIMATOR = {
  params: [
    { name: "speed", kind: "number", initial: 0 },
    { name: "side", kind: "number", initial: 0 },
    { name: "grounded", kind: "bool", initial: 1 },
    { name: "dead", kind: "bool", initial: 0 },
  ],
  states: [
    {
      name: "move",
      clip: null,
      speed: 1,
      loop: true,
      blend: {
        param: "speed",
        param2: "side",
        points: [
          { clip: "idle", at: 0, at2: 0 },
          { clip: "run", at: 1, at2: 0 },
          { clip: "back", at: -1, at2: 0 },
          { clip: "strafeR", at: 0, at2: 1 },
          { clip: "strafeL", at: 0, at2: -1 },
        ],
      },
    },
    { name: "air", clip: "air", speed: 1, loop: true },
    { name: "die", clip: "die", speed: 1, loop: false },
  ],
  transitions: [
    { from: "move", to: "die", when: [{ param: "dead", op: "true", value: 1 }], fade: 0.08 },
    { from: "air", to: "die", when: [{ param: "dead", op: "true", value: 1 }], fade: 0.08 },
    { from: "die", to: "move", when: [{ param: "dead", op: "false", value: 0 }], fade: 0 },
    { from: "move", to: "air", when: [{ param: "grounded", op: "false", value: 0 }], fade: 0.12 },
    { from: "air", to: "move", when: [{ param: "grounded", op: "true", value: 1 }], fade: 0.1 },
  ],
  events: [],
} as const;

/**
 * An armoured soldier: team-paintable plates (helmet, chest, shoulders, thighs,
 * shins) over a dark undersuit, a mirrored gold visor, a backpack and a rifle
 * held at the ready. Feet at y = 0, facing +Z; roughly 1.85 tall so the cart's
 * eye height (1.5) sits at the visor. Skinned: every piece rides one bone of
 * {@link soldierBones}, and it carries the clips of {@link soldierClips}.
 */
function soldierMesh(): MeshAsset {
  const paint = bound();
  const suit = bound();
  const visor = bound();
  const gun = bound();
  const bones = soldierBones();
  for (const side of [-1, 1]) {
    const L = side < 0;
    const thighJ = L ? J.thighL : J.thighR;
    const shinJ = L ? J.shinL : J.shinR;
    const footJ = L ? J.footL : J.footR;
    const armJ = L ? J.armL : J.armR;
    const foreJ = L ? J.foreL : J.foreR;
    const hip = bones[thighJ]!.at;
    const kneeAt = bones[shinJ]!.at;
    const ankle = bones[footJ]!.at;
    on(suit, thighJ, (s) => limb(s, hip, kneeAt, 0.12, 0.1)); // thigh
    on(paint, thighJ, (s) => limb(s, swing([hip[0], hip[1], hip[2] + 0.07], 0.12, 0), swing([hip[0], hip[1], hip[2] + 0.07], 0.34, 0), 0.075, 0.06, 0.5)); // thigh plate
    on(paint, shinJ, (s) => block(s, kneeAt[0], kneeAt[1], kneeAt[2] + 0.08, 0.06, 0.05, 0.03)); // knee pad
    on(suit, shinJ, (s) => limb(s, kneeAt, ankle, 0.085, 0.075)); // shin
    on(paint, shinJ, (s) => limb(s, swing([kneeAt[0], kneeAt[1], kneeAt[2] + 0.06], 0.08, -0.05), swing([kneeAt[0], kneeAt[1], kneeAt[2] + 0.06], 0.34, -0.05), 0.07, 0.06, 0.5)); // shin guard
    on(suit, footJ, (s) => block(s, ankle[0], Math.max(0.06, ankle[1] - 0.02), ankle[2] + 0.03, 0.085, 0.06, 0.15)); // boot
    // Shoulder pad, upper arm, and a forearm reaching forward to the rifle.
    on(paint, armJ, (s) => block(s, side * 0.31, 1.46, -0.01, 0.1, 0.075, 0.12, 0.05, 0.35));
    on(suit, armJ, (s) => limb(s, [side * 0.33, 1.42, 0], [side * 0.3, 1.12, 0.05], 0.065));
    on(paint, foreJ, (s) => limb(s, [side * 0.3, 1.12, 0.05], [side * 0.1 + 0.06, 1.15, L ? 0.42 : 0.2], 0.06, 0.05));
    on(suit, foreJ, (s) => block(s, side * 0.1 + 0.06, 1.15, L ? 0.44 : 0.22, 0.045, 0.045, 0.05)); // glove
  }
  on(suit, J.hips, (s) => block(s, 0, 0.94, 0, 0.21, 0.07, 0.13, 0.05)); // belt / hips
  on(suit, J.spine, (s) => block(s, 0, 1.07, 0, 0.18, 0.07, 0.12, 0.05)); // abdomen
  // Chest: a plate widening toward the shoulders, with a raised front piece.
  on(paint, J.chest, (s) => pushLoft(s, chamferedRect(0, 0, 0.23, 0.15, 0.07, 1.13), chamferedRect(0, 0.01, 0.28, 0.17, 0.09, 1.5), 1));
  on(paint, J.chest, (s) => block(s, 0, 1.32, 0.16, 0.16, 0.13, 0.03, 0.05, 0.1));
  on(suit, J.chest, (s) => block(s, 0, 1.28, -0.21, 0.17, 0.17, 0.06)); // backpack
  on(suit, J.chest, (s) => block(s, 0, 1.55, 0, 0.07, 0.05, 0.07)); // neck
  // Helmet: a rounded crown over a jaw, with the visor set into its face.
  on(paint, J.head, (s) => block(s, 0, 1.69, 0, 0.13, 0.11, 0.15, 0.06, 0.18));
  on(paint, J.head, (s) => block(s, 0, 1.6, 0.05, 0.11, 0.04, 0.11, 0.04));
  on(visor, J.head, (s) =>
    pushLoft(s, [[-0.1, 1.64, 0.145], [0.1, 1.64, 0.145], [0.1, 1.64, 0.1], [-0.1, 1.64, 0.1]], [[-0.095, 1.76, 0.13], [0.095, 1.76, 0.13], [0.095, 1.76, 0.09], [-0.095, 1.76, 0.09]], 1),
  );
  // The rifle, held across the body: it rides the right forearm, with the hands.
  on(gun, J.foreR, (s) => limb(s, [0.06, 1.16, 0.0], [0.06, 1.16, 0.55], 0.035, 0.03, 1.6));
  on(gun, J.foreR, (s) => limb(s, [0.06, 1.18, 0.55], [0.06, 1.18, 0.78], 0.013));
  on(gun, J.foreR, (s) => block(s, 0.06, 1.24, 0.22, 0.02, 0.025, 0.1));

  // Bones rest unrotated, so each one's rest transform is its offset from its
  // parent and its inverse bind matrix is a plain translation back to the origin.
  const inverseBind = new Float32Array(bones.length * 16);
  bones.forEach((bone, j) => {
    inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.at[0], -bone.at[1], -bone.at[2], 1], j * 16);
  });
  const joints: SkinJoint[] = bones.map((bone) => {
    const parent = bone.parent >= 0 ? bones[bone.parent]!.at : ([0, 0, 0] as P3);
    return {
      name: bone.name,
      parent: bone.parent,
      translation: [bone.at[0] - parent[0], bone.at[1] - parent[1], bone.at[2] - parent[2]],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  });
  // Lacquered armour (I4): the team paint under a glossy clearcoat, and a coated visor.
  const paintMat: Mat = { name: "armor", baseColorFactor: ARMOR_PAINT, baseColorImage: null, metallicFactor: 0.45, roughnessFactor: 0.4, tintable: true, ...ARMOR_LACQUER };
  return {
    name: "soldier",
    primitives: [
      boundPrimitive(paint, paintMat),
      boundPrimitive(suit, { name: "undersuit", baseColorFactor: [0.2, 0.21, 0.24, 1], baseColorImage: null, metallicFactor: 0.3, roughnessFactor: 0.6 }),
      boundPrimitive(visor, { name: "visor", baseColorFactor: [0.95, 0.7, 0.28, 1], baseColorImage: null, metallicFactor: 0.9, roughnessFactor: 0.12, emissiveFactor: [0.35, 0.22, 0.05], clearcoat: 1, clearcoatRoughness: 0.03 }),
      boundPrimitive(gun, { name: "rifle", baseColorFactor: [0.2, 0.21, 0.23, 1], baseColorImage: null, metallicFactor: 0.7, roughnessFactor: 0.4 }),
    ],
    skin: { joints, inverseBind },
    clips: soldierClips(bones),
  };
}

// --- First-person arms (HALO_INFINITE_STYLE_ROADMAP.md I9) --------------------
// Each viewmodel is skinned to a three-bone rig: the root (the whole held
// assembly: idle sway, the run's bob, a melee lunge, the raise on a swap), the
// weapon under it (recoil, a reload's tilt) and the left hand under that, which
// a reload takes off the gun to the magazine and back. A state machine plays
// the clips: the cart sets `speed` and fires `fire`, `reload`, `melee` and
// `ready` as they happen.

/** Bone indices of the viewmodel rig. */
const VM = { root: 0, weapon: 1, handL: 2 } as const;

function viewmodelBones(leftAt: P3): { name: string; parent: number; at: P3 }[] {
  return [
    { name: "root", parent: -1, at: [0, 0, 0] },
    { name: "weapon", parent: VM.root, at: [0, 0, 0] },
    { name: "hand_l", parent: VM.weapon, at: leftAt },
  ];
}

/** A skin over unrotated rest bones: each joint's offset from its parent, inverse binds as plain translations. */
function rigSkin(bones: readonly { name: string; parent: number; at: P3 }[]): NonNullable<MeshAsset["skin"]> {
  const inverseBind = new Float32Array(bones.length * 16);
  bones.forEach((bone, j) => inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.at[0], -bone.at[1], -bone.at[2], 1], j * 16));
  const joints: SkinJoint[] = bones.map((bone) => {
    const parent = bone.parent >= 0 ? bones[bone.parent]!.at : ([0, 0, 0] as P3);
    return { name: bone.name, parent: bone.parent, translation: [bone.at[0] - parent[0], bone.at[1] - parent[1], bone.at[2] - parent[2]], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  });
  return { joints, inverseBind };
}

/** A pose of the viewmodel rig: rotations and offsets from rest, per bone. */
interface RigPose {
  readonly rot?: Partial<Record<number, readonly number[]>>;
  readonly move?: Partial<Record<number, P3>>;
}

/**
 * A clip of the rig sampled at `keys` moments over `duration` seconds: a
 * rotation and a translation channel for each bone it moves.
 */
function rigClip(name: string, duration: number, keys: number, bones: readonly { parent: number; at: P3 }[], sample: (t: number) => RigPose): AnimationClip {
  const times = new Float32Array(keys);
  const rot = bones.map(() => [] as number[]);
  const pos = bones.map(() => [] as number[]);
  const moved = new Set<number>();
  for (let k = 0; k < keys; k += 1) {
    const t = k / (keys - 1);
    times[k] = t * duration;
    const pose = sample(t);
    for (const j of [...Object.keys(pose.rot ?? {}), ...Object.keys(pose.move ?? {})]) moved.add(Number(j));
    bones.forEach((bone, j) => {
      rot[j]!.push(...(pose.rot?.[j] ?? [0, 0, 0, 1]));
      const parent = bone.parent >= 0 ? bones[bone.parent]!.at : ([0, 0, 0] as P3);
      const m = pose.move?.[j] ?? [0, 0, 0];
      pos[j]!.push(bone.at[0] - parent[0] + m[0], bone.at[1] - parent[1] + m[1], bone.at[2] - parent[2] + m[2]);
    });
  }
  // Only the bones the clip moves get channels; the others hold their rest pose.
  const channels: ClipChannel[] = [...moved].sort((a, b) => a - b).flatMap((j) => [
    { joint: j, path: "rotation" as const, interpolation: "linear" as const, times, values: new Float32Array(rot[j]!) },
    { joint: j, path: "translation" as const, interpolation: "linear" as const, times, values: new Float32Array(pos[j]!) },
  ]);
  return { name, duration, channels };
}

/** 0 → 1 → 0 over a clip: up fast by `peak`, then eased back down. */
function pulse(t: number, peak: number): number {
  if (t <= 0 || t >= 1) return 0;
  if (t < peak) return Math.sin((t / peak) * (Math.PI / 2));
  const u = (t - peak) / (1 - peak);
  return 0.5 + 0.5 * Math.cos(u * Math.PI);
}

/** Weight of a window [a, b] of a clip: in and out smoothly. */
function windowed(t: number, a: number, b: number): number {
  return t <= a || t >= b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI);
}

/**
 * The viewmodel's clips: `idle` (a slow breathing sway), `run` (a stepping
 * figure-eight bob), `fire` (the kick: back and muzzle up, then settle),
 * `reload` (the gun tips over, the left hand drops to the magazine, slaps it
 * home and returns), `melee` (a lunge, the stock leading), and `ready` (raised
 * into view from below). The sword's `fire` and `melee` are one swing, right
 * to left across the view, and it never reloads (a flourish stands in).
 */
function viewmodelClips(id: WeaponId, bones: readonly { parent: number; at: P3 }[]): AnimationClip[] {
  const TAU = Math.PI * 2;
  const heavy = id === "sniper" || id === "shotgun";
  const idle = rigClip("idle", 3.2, 9, bones, (t) => ({
    rot: { [VM.root]: pitchYaw(Math.sin(t * TAU) * 0.012, Math.sin(t * TAU + 1.3) * 0.01) },
    move: { [VM.root]: [Math.sin(t * TAU + 1.3) * 0.003, Math.sin(t * TAU * 2) * 0.003, 0] },
  }));
  const run = rigClip("run", 0.75, 13, bones, (t) => {
    const step = Math.sin(t * TAU);
    return {
      rot: { [VM.root]: pitchYaw(Math.sin(t * TAU * 2) * 0.025, step * 0.03, step * 0.05) },
      move: { [VM.root]: [step * 0.014, -Math.abs(Math.cos(t * TAU)) * 0.014, 0] },
    };
  });
  const ready = rigClip("ready", 0.35, 9, bones, (t) => {
    const down = (1 - t) * (1 - t);
    return { rot: { [VM.root]: pitchYaw(down * 0.7, down * -0.2) }, move: { [VM.root]: [0, -down * 0.22, -down * 0.08] } };
  });
  if (id === "sword") {
    // One swing serves the attack and the melee: wound back to the right, then
    // across to the left and down, the blade leading.
    const swing = (name: string) =>
      rigClip(name, 0.45, 13, bones, (t) => {
        const wind = windowed(t, 0, 0.3);
        const cut = t < 0.18 ? 0 : Math.sin(Math.min(1, (t - 0.18) / 0.4) * Math.PI) * (1 - Math.max(0, (t - 0.58) / 0.42));
        return {
          rot: { [VM.root]: pitchYaw(-wind * 0.15 + cut * 0.35, wind * 0.5 - cut * 0.9, wind * 0.4 - cut * 0.7) },
          move: { [VM.root]: [wind * 0.06 - cut * 0.18, wind * 0.04 - cut * 0.05, cut * 0.1] },
        };
      });
    const flourish = rigClip("reload", 0.8, 13, bones, (t) => ({ rot: { [VM.weapon]: pitchYaw(0, 0, Math.sin(t * Math.PI) * 0.6) } }));
    return [idle, run, swing("fire"), swing("melee"), flourish, ready];
  }
  const kick = heavy ? 1.6 : id === "smg" ? 0.5 : 1;
  const fire = rigClip("fire", heavy ? 0.32 : 0.18, 9, bones, (t) => {
    const k = pulse(t, 0.15) * kick;
    return { rot: { [VM.weapon]: pitchYaw(-k * 0.07, 0, k * 0.02) }, move: { [VM.root]: [0, k * 0.008, -k * 0.035] } };
  });
  const reload = rigClip("reload", heavy ? 1.6 : 1.25, 17, bones, (t) => {
    const tilt = windowed(t, 0.02, 0.98);
    const away = windowed(t, 0.18, 0.62); // to the magazine and back with a fresh one
    const slap = windowed(t, 0.58, 0.72); // and slapped home
    return {
      rot: { [VM.weapon]: pitchYaw(-tilt * 0.22, tilt * 0.12, tilt * 0.55 - slap * 0.08) },
      move: {
        [VM.root]: [0, -tilt * 0.05, -tilt * 0.02],
        [VM.handL]: [-away * 0.02, -away * 0.13 + slap * 0.02, -away * 0.12],
      },
    };
  });
  const melee = rigClip("melee", 0.45, 9, bones, (t) => {
    const lunge = pulse(t, 0.3);
    return { rot: { [VM.root]: pitchYaw(lunge * 0.2, -lunge * 0.55, -lunge * 0.35) }, move: { [VM.root]: [-lunge * 0.1, lunge * 0.04, lunge * 0.14] } };
  });
  return [idle, run, fire, reload, melee, ready];
}

/**
 * The viewmodel's state machine (EP17): a blend from idle to run by `speed`,
 * and one-shot states the cart's triggers start — each plays through and
 * fades back. A shot during a shot starts the kick again.
 */
export const LOCKOUT_VIEWMODEL_ANIMATOR = {
  params: [
    { name: "speed", kind: "number", initial: 0 },
    { name: "fire", kind: "trigger", initial: 0 },
    { name: "reload", kind: "trigger", initial: 0 },
    { name: "melee", kind: "trigger", initial: 0 },
    { name: "ready", kind: "trigger", initial: 0 },
  ],
  states: [
    { name: "move", clip: null, speed: 1, loop: true, blend: { param: "speed", points: [{ clip: "idle", at: 0 }, { clip: "run", at: 1 }] } },
    { name: "fire", clip: "fire", speed: 1, loop: false },
    { name: "reload", clip: "reload", speed: 1, loop: false },
    { name: "melee", clip: "melee", speed: 1, loop: false },
    { name: "ready", clip: "ready", speed: 1, loop: false },
  ],
  transitions: [
    { from: "*", to: "ready", when: [{ param: "ready", op: "set", value: 1 }], fade: 0 },
    { from: "*", to: "melee", when: [{ param: "melee", op: "set", value: 1 }], fade: 0.04 },
    { from: "*", to: "reload", when: [{ param: "reload", op: "set", value: 1 }], fade: 0.1 },
    { from: "fire", to: "fire", when: [{ param: "fire", op: "set", value: 1 }], fade: 0.02 },
    { from: "*", to: "fire", when: [{ param: "fire", op: "set", value: 1 }], fade: 0.03 },
    { from: "fire", to: "move", when: [], fade: 0.1, exitTime: 1 },
    { from: "reload", to: "move", when: [], fade: 0.15, exitTime: 1 },
    { from: "melee", to: "move", when: [], fade: 0.12, exitTime: 1 },
    { from: "ready", to: "move", when: [], fade: 0.08, exitTime: 1 },
  ],
  events: [],
} as const;

/** The sword's swing trail (I10): emitter to tips, on the weapon bone, only while it really swings. */
const SWORD_TRAIL: MeshTrail = { from: [0, 0.05, 0.03], to: [0, 0.3, 0.62], joint: VM.weapon, life: 0.16, color: [0.3, 0.6, 1], intensity: 1.6, minSpeed: 1.2 };

/** A plasma grenade's charge (I10): hotter and bluer than the sword, boiling harder. */
const PLASMA_CHARGE: PlasmaLook = { core: [1.4, 2.2, 3], edge: [0.08, 0.3, 2.6], falloff: 1.1, boil: 0.5, scale: 30 };

/** A sphere of `r` round `c`, smooth-shaded. */
function sphere(s: Streams, c: P3, r: number, rings = 8, segs = 12): void {
  const base = s.positions.length / 3;
  for (let i = 0; i <= rings; i += 1) {
    const th = (i / rings) * Math.PI;
    for (let j = 0; j <= segs; j += 1) {
      const ph = (j / segs) * Math.PI * 2;
      const n: P3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      s.positions.push(c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r);
      s.normals.push(...n);
      s.uvs.push(j / segs, i / rings);
    }
  }
  for (let i = 0; i < rings; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      const a = base + i * (segs + 1) + j;
      const b = a + segs + 1;
      s.indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
}

/**
 * A plasma grenade (I10): a boiling blue charge held in a cage of three dark
 * prongs, about the size of a fist. It leaves a short trail of light in flight.
 */
function plasmaGrenadeMesh(): MeshAsset {
  const core = newStreams();
  const cage = newStreams();
  sphere(core, [0, 0, 0], 0.075);
  for (let k = 0; k < 3; k += 1) {
    const a = (k / 3) * Math.PI * 2;
    const [x, z] = [Math.cos(a), Math.sin(a)];
    limb(cage, [x * 0.02, -0.095, z * 0.02], [x * 0.085, -0.02, z * 0.085], 0.008);
    limb(cage, [x * 0.085, -0.02, z * 0.085], [x * 0.06, 0.07, z * 0.06], 0.008, 0.004);
  }
  limb(cage, [0, -0.11, 0], [0, -0.085, 0], 0.025, 0.02); // the base the prongs rise from
  return {
    ...withoutUnusedUvs({
      name: "plasma-grenade",
      primitives: [
        toPrimitive(core, plasmaMaterial("plasma", PLASMA_CHARGE)),
        toPrimitive(cage, { name: "cage", baseColorFactor: [0.12, 0.14, 0.2, 1], baseColorImage: null, metallicFactor: 0.8, roughnessFactor: 0.3 }),
      ],
    }),
    trails: [{ from: [0, -0.04, 0], to: [0, 0.04, 0], life: 0.22, color: [0.35, 0.6, 1], intensity: 2, minSpeed: 2 }],
  };
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
  // The shimmer round a plasma blade (I5): wider than the blade, faint, and bending the view behind it.
  const haze = newStreams();
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
  // The left hand rides its own bone (I9), so a reload can take it off the gun:
  // its glove and sleeve are parts of their own.
  let leftAt: P3 = [0, 0, 0];
  const gloveL = newStreams();
  const sleeveL = newStreams();
  const leftHand = (x: number, y: number, z: number) => {
    leftAt = [x, y, z];
    block(gloveL, x, y, z, 0.038, 0.028, 0.05, 0.012); // palm under the handguard
    for (let f = 0; f < 3; f += 1) block(gloveL, x + 0.035, y + 0.01, z - 0.03 + f * 0.028, 0.01, 0.022, 0.012); // fingers over the top
    limb(sleeveL, [x - 0.02, y - 0.02, z - 0.04], [x - 0.3, y - 0.22, z - 0.34], 0.045, 0.06);
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
      limb(haze, [side * 0.04, 0.03, 0.03], [side * 0.03, 0.2, 0.34], 0.04, 0.055, 0.5);
      limb(haze, [side * 0.03, 0.2, 0.34], [side * 0.005, 0.3, 0.62], 0.055, 0.012, 0.5);
    }
    rightHand(0, -0.05, 0.0);
  }
  const glowColor: readonly [number, number, number, number] = id === "sword" ? [0.45, 0.85, 1, 1] : [0.3, 0.9, 1, 1];
  // Skinned (I9), every part rigidly: the left hand's on its bone, the rest on the weapon's.
  const toPrimitive = (st: Streams, material: Mat): MeshPrimitive => {
    const n = st.positions.length / 3;
    const joints = new Uint16Array(n * 4).fill(0);
    const weights = new Float32Array(n * 4);
    const bone = st === gloveL || st === sleeveL ? VM.handL : VM.weapon;
    for (let i = 0; i < n; i += 1) {
      joints[i * 4] = bone;
      weights[i * 4] = 1;
    }
    return { ...streamPrimitive(st, material), joints, weights };
  };
  const gloveMat: Mat = { name: "glove", baseColorFactor: [0.12, 0.12, 0.13, 1], baseColorImage: null, metallicFactor: 0.05, roughnessFactor: 0.8 };
  const sleeveMat: Mat = { name: "sleeve", baseColorFactor: ARMOR_PAINT, baseColorImage: null, metallicFactor: 0.45, roughnessFactor: 0.4, tintable: true, ...ARMOR_LACQUER };
  const primitives: MeshPrimitive[] = [
    // Brushed gunmetal (I4): the highlight drawn out along the barrel.
    toPrimitive(metal, { name: "gunmetal", baseColorFactor: [0.42, 0.45, 0.5, 1], baseColorImage: null, metallicFactor: 0.8, roughnessFactor: 0.3, anisotropy: 0.6 }),
    toPrimitive(poly, { name: "polymer", baseColorFactor: [0.2, 0.21, 0.23, 1], baseColorImage: null, metallicFactor: 0.15, roughnessFactor: 0.5 }),
    toPrimitive(accent, { name: "accent", baseColorFactor: [0.42, 0.46, 0.38, 1], baseColorImage: null, metallicFactor: 0.5, roughnessFactor: 0.42 }),
    toPrimitive(glove, gloveMat),
    toPrimitive(sleeve, sleeveMat),
    toPrimitive(gloveL, gloveMat),
    toPrimitive(sleeveL, sleeveMat),
    toPrimitive(dark, { name: "recess", baseColorFactor: [0.05, 0.05, 0.06, 1], baseColorImage: null, metallicFactor: 0.3, roughnessFactor: 0.7 }),
  ];
  if (glow.indices.length > 0) {
    primitives.push(
      // The sword's blade is plasma (I10): a white-hot heart cooling to blue at its edges.
      toPrimitive(
        glow,
        id === "sword"
          ? plasmaMaterial("plasma")
          : { name: "glow", baseColorFactor: glowColor, baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.4, emissiveFactor: [0.5, 1.6, 1.9] },
      ),
    );
  }
  if (haze.indices.length > 0) {
    // The blade's heat (I5): a faint cyan added over the view round the blade,
    // which it bends and sets shimmering.
    primitives.push(
      toPrimitive(haze, {
        name: "blade-haze",
        baseColorFactor: [0.05, 0.12, 0.16, 1],
        baseColorImage: null,
        metallicFactor: 0,
        roughnessFactor: 1,
        alphaMode: "additive",
        refraction: 0.25,
        distortion: 0.2,
      }),
    );
  }
  const bones = viewmodelBones(leftAt);
  return {
    ...withoutUnusedUvs({ name: `viewmodel-${id}`, primitives: primitives.filter((p) => p.indices.length > 0) }),
    skin: rigSkin(bones),
    clips: viewmodelClips(id, bones),
    // The swing's arc of light (I10): what the blade sweeps, from the emitter to the tips.
    ...(id === "sword" ? { trails: [SWORD_TRAIL] } : {}),
  };
}

/**
 * A weapon as it lies on its spawn pad (EP14): its first-person model without
 * the hands. Its normals aren't stored — every renderer rebuilds them from the
 * triangles, and the parts' faces don't share corners, so the hard edges stay
 * hard — which near halves what five more guns add to the sidecar.
 */
function pickupMesh(id: WeaponId): MeshAsset {
  const model = viewmodelMesh(id);
  return {
    name: `pickup-${id}`,
    // No skeleton: a pickup only turns and bobs as a whole.
    primitives: model.primitives
      .filter((p) => p.material.name !== "glove" && p.material.name !== "sleeve")
      .map(({ joints: _joints, weights: _weights, ...p }) => ({ ...p, normals: null })),
  };
}

/**
 * Lockout's components (EP14). Pickup sits on the weapon over each spawn pad:
 * it turns and bobs while the weapon is there to take, and is gone while the
 * pad recharges (or the game type leaves that weapon out). It asks the cart
 * (pickup_ready) whether its pad's weapon is up, and moves the weapon with
 * cartbox.place — which, unlike a pose, needs no slot in the frame's short
 * pose list (the bots and the gun in hand fill it).
 */
/**
 * The Pickup visual script (EP16): on start it puts each pad out of step with
 * the others; every tick it asks the cart whether its pad's weapon is up, and
 * either turns and bobs the weapon over the pad or hides it.
 */
const PICKUP_GRAPH: ScriptGraph = (() => {
  const v = (name: string, value: number) => ({ name, type: "number" as const, value });
  const n = (id: string, kind: ScriptNode["kind"], x: number, y: number, extra: Partial<ScriptNode> = {}): ScriptNode => ({ id, kind, x, y, ...extra });
  const w = (from: string, fromPin: string, to: string, toPin: string): ScriptWire => ({ from, fromPin, to, toPin });
  return {
    variables: [v("slot", 1), v("spin", 1.4), v("bob", 0.06), v("t", 0)],
    nodes: [
      n("start", "onStart", 0, 0),
      n("slot1", "getVar", 0, 110, { param: "slot" }),
      n("stagger", "multiply", 260, 110, { values: { b: 1.3 } }),
      n("setStart", "setVar", 520, 0, { param: "t" }),
      n("tick", "onTick", 0, 260),
      n("slot2", "getVar", 0, 370, { param: "slot" }),
      n("ready", "callValue", 260, 370, { param: "pickup_ready" }),
      n("branch", "branch", 520, 260),
      n("t1", "getVar", 520, 380, { param: "t" }),
      n("advance", "add", 780, 380),
      n("setT", "setVar", 780, 260, { param: "t" }),
      n("here", "self", 1040, 500),
      n("t2", "getVar", 260, 560, { param: "t" }),
      n("phase", "multiply", 520, 560, { values: { b: 2.2 } }),
      n("wave", "sin", 780, 560),
      n("bob", "getVar", 780, 660, { param: "bob" }),
      n("height", "multiply", 1040, 660),
      n("lift", "add", 1300, 500),
      n("spin", "getVar", 1040, 780, { param: "spin" }),
      n("turn", "multiply", 1300, 620),
      n("show", "place", 1300, 260),
      n("hide", "place", 520, 700, { values: { scale: 0 } }),
    ],
    wires: [
      w("start", "then", "setStart", "in"),
      w("slot1", "value", "stagger", "a"),
      w("stagger", "out", "setStart", "value"),
      w("tick", "then", "branch", "in"),
      w("slot2", "value", "ready", "argument"),
      w("ready", "result", "branch", "condition"),
      w("branch", "true", "setT", "in"),
      w("t1", "value", "advance", "a"),
      w("tick", "dt", "advance", "b"),
      w("advance", "out", "setT", "value"),
      w("setT", "then", "show", "in"),
      w("here", "x", "show", "x"),
      w("t2", "value", "phase", "a"),
      w("phase", "out", "wave", "x"),
      w("wave", "out", "height", "a"),
      w("bob", "value", "height", "b"),
      w("here", "y", "lift", "a"),
      w("height", "out", "lift", "b"),
      w("lift", "out", "show", "y"),
      w("here", "z", "show", "z"),
      w("t2", "value", "turn", "a"),
      w("spin", "value", "turn", "b"),
      w("turn", "out", "show", "yaw"),
      w("branch", "false", "hide", "in"),
      w("here", "x", "hide", "x"),
      w("here", "y", "hide", "y"),
      w("here", "z", "hide", "z"),
    ],
  };
})();

export const LOCKOUT_COMPONENTS: readonly ComponentDef[] = [{ name: "Pickup", code: compileScriptGraph(PICKUP_GRAPH, "Pickup"), graph: PICKUP_GRAPH }];

/**
 * Lockout's input actions (EP15). Each keeps its console button, so the
 * on-screen pad and a remapped controller still play as before, and adds
 * its own keys and controller buttons: Space jumps, Tab swaps, G or Q (or
 * LT) throws a grenade, and Shift (or a right-stick click) zooms. A key or
 * button an action binds is that action's: LT no longer also holds X (strafe).
 * The double-tapped X grenade and the held-X zoom stay for the 8-button pad.
 */
export const LOCKOUT_INPUT_ACTIONS: readonly InputAction[] = [
  { name: "fire", keys: [], pad: [], buttons: [4] },
  { name: "jump", keys: ["Space"], pad: [], buttons: [5] },
  { name: "swap", keys: ["Tab"], pad: [], buttons: [7] },
  { name: "grenade", keys: ["KeyG", "KeyQ"], pad: ["LT"], buttons: [] },
  { name: "zoom", keys: ["ShiftLeft"], pad: ["RS"], buttons: [] },
];

/** A spent brass casing (H10), about 4 cm long, lying along Z. */
function casingMesh(): MeshAsset {
  const brass = newStreams();
  limb(brass, [0, 0, -0.018], [0, 0, 0.016], 0.0065, 0.0055);
  const rim = newStreams();
  limb(rim, [0, 0, -0.02], [0, 0, -0.017], 0.0072);
  return withoutUnusedUvs({
    name: "casing",
    primitives: [
      toPrimitive(brass, { name: "brass", baseColorFactor: [0.78, 0.6, 0.28, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 0.32 }),
      toPrimitive(rim, { name: "brass-rim", baseColorFactor: [0.62, 0.46, 0.2, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 0.4 }),
    ],
  });
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
  // The light and colour pass (HALO_INFINITE_STYLE_ROADMAP.md I8): bright noon
  // on snow. A warm, strong sun high overhead does the modelling; a bright blue
  // sky fills the shade so it stays open and cool, never murky.
  environment: {
    sky: [0.45, 0.58, 0.82],
    horizon: [0.74, 0.8, 0.88],
    ground: [0.4, 0.4, 0.42],
    // The baked sky dome (below) is the environment map, and it is far brighter
    // than the gradient it replaced, so its intensity sits under 1.
    intensity: 0.6,
  },
  ambient: 0.42,
  exposure: 1.1,
  tonemap: true,
  shadows: true,
  lights: [
    // Key: a warm noon sun, strong enough that shadows read crisply
    // (direction points *towards* the light).
    { kind: "directional", direction: [...LOCKOUT_KEY_DIRECTION], color: [1, 0.88, 0.7], intensity: 3.4 },
    // Fill: blue skylight from the opposite side, so the shade reads cool and open.
    { kind: "directional", direction: [-0.5, 0.45, 0.55], color: [0.6, 0.7, 0.92], intensity: 0.4 },
    // The Sword pit's cyan glow, at the bottom-mid centre.
    { kind: "point", position: [0, 0.9, 0], color: [0.4, 0.95, 1], intensity: 2.4, range: 4.5 }, // kept in the pit, off the walkway above
    // The energy's own light (ENGINE_PARITY_ROADMAP.md EP8): small cyan pools
    // along every strip and vent and at the weapon markers, and two floodlights
    // from the towers down onto the walkway — dozens of lights, each shading
    // only the cells of the view it reaches.
    ...energyLights(),
    // The floodlights cast (EP8c): the walkway rails and anyone crossing throw shadows down the deck.
    { kind: "spot", position: [-6.7, 7.9, -6.6], direction: [0.55, -0.62, 0.55], color: [1, 0.93, 0.8], intensity: 2.2, range: 16, innerAngle: 14, outerAngle: 24, castShadows: true },
    { kind: "spot", position: [9.6, 5.1, 3.9], direction: [-0.7, -0.45, -0.55], color: [1, 0.93, 0.8], intensity: 2.2, range: 16, innerAngle: 14, outerAngle: 24, castShadows: true },
  ],
  // A procedural alpine dome (original art, baked at load): a cold overcast sky
  // over two rings of snow-capped peaks, with a misty glacier valley far below —
  // the arena reads as a facility perched high in the mountains. The same bake
  // is the image-based light, so the metal panels reflect these clouds.
  sky: {
    // A clear noon blue, deep overhead and pale at the horizon (I8).
    zenith: [0.18, 0.38, 0.76],
    horizon: [0.76, 0.86, 0.96],
    below: [0.68, 0.76, 0.86],
    sunDirection: [...LOCKOUT_KEY_DIRECTION], // matches the key light
    sunColor: [1, 0.93, 0.8],
    // Lighter painted cloud: the drifting layers below carry the rest (I6).
    clouds: 0.25,
    cloudColor: [0.9, 0.93, 0.97],
    mountains: [
      { height: 8, peaks: 11, rock: [0.44, 0.49, 0.57], snow: [0.88, 0.92, 0.97], snowLine: 0.25, haze: 0.55, seed: 11 },
      { height: 15, peaks: 7, rock: [0.24, 0.27, 0.32], snow: [0.93, 0.95, 0.98], snowLine: 0.42, haze: 0.18, seed: 29 },
    ],
    seed: 7,
    // The ring (HALO_INFINITE_STYLE_ROADMAP.md I6), arching over the valley from
    // one horizon to the other, lit on the sun's side and hazed where it meets
    // the mountains; and a pale moon low in the east.
    objects: [
      { kind: "ring", axis: [0.82, 0.38, 0.43], width: 4.5, color: [0.5, 0.62, 0.55], edge: [0.86, 0.88, 0.92], haze: 0.5, seed: 5 },
      { kind: "planet", direction: [-0.7, 0.22, 0.68], radius: 5, color: [0.7, 0.72, 0.76], atmosphere: [0.6, 0.72, 0.95], seed: 3 },
    ],
    // Two decks of cloud drifting on the wind: a high thin sheet and lower puffs.
    cloudLayers: [
      { cover: 0.35, scale: 0.22, wind: [0.012, 0.005], color: [0.94, 0.96, 0.99], opacity: 0.55, seed: 41 },
      { cover: 0.3, scale: 0.5, wind: [0.028, 0.011], color: [0.9, 0.92, 0.96], opacity: 0.7, seed: 43 },
    ],
  },
  // Cold haze that thickens across the arena, tinted to the horizon.
  // Kept light: the arena is only ~30 units across, so heavy fog just washes it out.
  fog: {
    // Clear noon air: a thin blue haze (I8).
    color: [0.72, 0.82, 0.95],
    density: 0.012,
    start: 16,
    max: 0.32,
    // Mist pooling in the chasm (HALO2_STYLE_ROADMAP.md H7): a box of fog under
    // the deck, thickest far down and thinning toward the rim, so looking over
    // the edge the gorge walls sink into a cloud sea and the floor never shows.
    volumes: [{ min: [-160, -45, -160], max: [160, -2, 160], density: 0.25, falloff: 0.06 }],
    // The haze brightens looking toward the sun.
    glow: { color: [1, 0.92, 0.78], strength: 0.3 },
  },
  // Beams from the sun between the towers and over the walls (H7).
  shafts: { strength: 0.7, length: 0.7 },
  // Reflection probes (HALO2_STYLE_ROADMAP.md H2): the Forerunner metal
  // reflects the room it stands in — the pit under the walkway, the walkway
  // itself, each tower — rather than open sky; the arena-wide probe catches
  // the deck, which reflects the towers around it. Boxes follow the collider
  // layout above; the smallest box wins where they overlap.
  probes: [
    { name: "bottom mid", position: [2.2, 1.6, 0], min: [-5, -0.2, -6.5], max: [5, 3.15, 6.5] },
    { name: "walkway", position: [0, 5.3, 0], min: [-2, 3.15, -6.5], max: [8, 7.5, 6.5] },
    { name: "sniper tower", position: [-6.7, 8.6, -8.6], min: [-13.2, 0, -11.2], max: [-4.4, 11, -3.6] },
    { name: "BR tower", position: [9.6, 5.5, 6.8], min: [4.2, 0, 3.4], max: [11.4, 7.5, 10.2] },
    { name: "arena", position: [4, 2.5, -8], min: [-16, -1, -13], max: [14, 14, 13] },
  ],
  // Team colours saturated to hold up in the bright light (I8).
  tints: INFINITE_TINTS,
};

/**
 * The arena's post-FX stack — the cold Halo-era grade: bloom so the cyan energy
 * and sun-lit snow glow past their edges, a touch more contrast and a touch less
 * saturation, a split tone that pushes shadows toward steel blue while keeping
 * highlights a pale, slightly warm white, and a faint vignette. The player's
 * `PostFxSettings` shape as plain JSON; every effect not named stays off.
 */
export const LOCKOUT_FX = {
  enabled: { bloom: true, grade: true, splittone: true, lut: true, vignette: true, lensflare: true },
  values: {
    // Calibrated against the player's real bloom pyramid (HDR, multi-scale):
    // just the brightest glow — cyan trim, sun-lit snow — past threshold, and a
    // hair of brightness back, so the frame sits where the grade was designed.
    "bloom.strength": 0.2,
    "bloom.threshold": 0.9,
    "bloom.radius": 0.55,
    "grade.brightness": 1,
    "grade.contrast": 1.05,
    "grade.saturation": 1.05,
    // A whisper of split tone: the Infinite LUT does the grading now (I8).
    "splittone.strength": 0.1,
    "splittone.balance": 0.45,
    // The Infinite look (I8): saturated, clean daylight, warm light over cool shade.
    "lut.strength": 0.7,
    "lut.look": 0,
    "vignette.strength": 0.18,
    // Sun glare and lens flare (HALO2_STYLE_ROADMAP.md H8): a soft starburst on
    // the sun and a string of cold ghosts, fading as a tower covers it.
    "lensflare.glare": 0.55,
    "lensflare.ghosts": 0.5,
    "lensflare.size": 0.09,
  },
  colors: {
    "lensflare.tint": "#fff0d8",
    "splittone.shadows": "#5a6c8e", // ×2 in the shader: mid-grey is neutral, so this cools shadows
    "splittone.highlights": "#86827a", // …and this warms highlights only slightly
  },
} as const;

/**
 * The match intro (a timeline the cart plays when an offline match starts): a
 * sweep down from high over the arena, round past the BR tower and low across
 * the deck toward the sniper tower, before the view drops to the player's eyes.
 * Every eye stays over the deck — the cliffs are close — and clear of the
 * structures; a test checks both.
 */
export const LOCKOUT_INTRO: SceneTimeline = {
  name: "Intro",
  duration: 7.5,
  loop: false,
  autoplay: false,
  hold: false,
  tracks: [
    {
      kind: "camera",
      keys: [
        { time: 0, eye: [-4, 24, 15], target: [-1, 3, -2], fov: 62, ease: "smooth" },
        { time: 2.6, eye: [13, 14, 9], target: [-3, 3, -3], fov: 56, ease: "smooth" },
        { time: 5.2, eye: [11, 6.5, -11], target: [-6, 4, -5], fov: 52, ease: "smooth" },
        { time: 7.5, eye: [4, 5, -9.5], target: [-7, 5, -8], fov: 50, ease: "smooth" },
      ],
    },
    // Value tracks (EP17): the letterbox bars slide in (an eased-out curve) and
    // back out at the end; the wind fades up on the ambience bus.
    {
      kind: "value",
      name: "letterbox",
      keys: [
        { time: 0, value: 0, ease: "curve", curve: [0.16, 1, 0.3, 1] },
        { time: 0.8, value: 1, ease: "step" },
        { time: 6.9, value: 1, ease: "curve", curve: [0.7, 0, 0.84, 0] },
        { time: 7.5, value: 0, ease: "step" },
      ],
    },
    {
      kind: "value",
      name: "bus:ambience",
      keys: [
        { time: 0, value: 0, ease: "smooth" },
        { time: 3, value: 0.5, ease: "step" },
      ],
    },
  ],
};

let meshSidecar: string | null = null;

/** The weapons a killed soldier drops (the sword vanishes with its wielder). */
const LOCKOUT_DROPPED = ["br", "smg", "shotgun", "sniper", "magnum"] as const;

/**
 * Lockout's debris (HALO2_STYLE_ROADMAP.md H10): spent casings that ring off the
 * deck and skitter, and the weapon a soldier drops when killed, which lands on
 * its side and rocks still. Simulated in each browser only.
 */
export const LOCKOUT_DEBRIS = [
  { name: "casing", source: "casing", life: 5, bounce: 0.35, friction: 0.3, max: 40 },
  ...LOCKOUT_DROPPED.map((id) => ({ name: `drop_${id}`, source: `viewmodel ${id}`, without: ["glove", "sleeve"], life: 9, bounce: 0.12, friction: 0.65, max: 6 })),
];

/**
 * The arena's mesh sidecar (map + 7 bots + the lighting rig), built on first
 * call and memoised — it carries the baked textures, see {@link lockoutTextures}.
 */
export function lockoutMeshSidecar(): string {
  if (meshSidecar === null) {
    const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const rest = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [VIEWMODEL_REST_SCALE, VIEWMODEL_REST_SCALE, VIEWMODEL_REST_SCALE] };
    // One skinned soldier mesh (tinted per bot at runtime, animated per bot by
    // its state machine), stored once in the sidecar's shared library however
    // many bots use it.
    const soldierAsset = soldierMesh();
    const soldier = serializeMeshAsset(soldierAsset);
    // LODs (EP9b): lighter levels for soldiers across the arena and for weapons
    // dropped far off, each stored once in the library however many use it.
    const lodsOf = (mesh: MeshAsset): { lods?: StoredLods } => {
      const chain = generateLods(mesh);
      return chain ? { lods: encodeLods(mesh, chain) } : {};
    };
    const soldierLods = lodsOf(soldierAsset);
    const meshes: { id: string; name: string; mesh: string; lods?: StoredLods; animator?: unknown; transform: unknown; components?: unknown }[] = [
      { id: "lockout-map", name: "Lockout arena", mesh: serializeMeshAsset(litMapMesh()), transform: identity },
    ];
    // Instances 1..7: the bots.
    for (let i = 1; i <= BOT_COUNT; i += 1) {
      meshes.push({ id: `bot-${i}`, name: `bot ${i}`, mesh: soldier, ...soldierLods, animator: LOCKOUT_SOLDIER_ANIMATOR, transform: identity });
    }
    // Instances 8..13: one first-person viewmodel per weapon, at rest scale.
    for (const id of LOCKOUT_VIEWMODELS) {
      const model = viewmodelMesh(id);
      meshes.push({ id: `viewmodel-${id}`, name: `viewmodel ${id}`, mesh: serializeMeshAsset(model), ...lodsOf(model), animator: LOCKOUT_VIEWMODEL_ANIMATOR, transform: rest });
    }
    // Instances 14..18 (EP14): the weapon over each spawn pad, which its Pickup
    // component turns, bobs and hides while the pad recharges.
    MARKERS.forEach(([cx, cy, cz, , hy], i) => {
      const id = MARKER_WEAPONS[i]!;
      meshes.push({
        id: `pickup-${i + 1}`,
        name: `pickup ${id}`,
        mesh: serializeMeshAsset(pickupMesh(id)),
        transform: { position: [cx, cy + hy + 0.32, cz], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ name: "Pickup", fields: { slot: i + 1 } }],
      });
    });
    const packed = packMeshLibrary(meshes);
    meshSidecar = JSON.stringify({
      version: 2,
      meshes: packed.entries,
      library: packed.library,
      // The baked light probes (EP9) light the soldiers as they cross shade and bounce.
      lighting: { ...LOCKOUT_LIGHTING, ...(lockoutProbes() ? { lightProbes: lockoutProbes() } : {}) },
      navmesh: serializeNavMesh(lockoutNavMesh()),
      terrains: [serializeTerrain(lockoutTerrain()), serializeTerrain(lockoutVista())],
      timelines: [LOCKOUT_INTRO],
      effects: LOCKOUT_EFFECTS,
      decals: LOCKOUT_DECALS,
      ragdollColliders: LOCKOUT_RAGDOLL_COLLIDERS,
      // Cosmetic debris (H10): the casing's look lives in a prefab, whose mesh
      // never sits in the level (no copies held in reserve: nothing spawns it);
      // dropped weapons wear the first-person models, minus the hands.
      prefabs: [
        { id: "prefab-casing", name: "casing", pool: 0, nodes: [{ key: "root", name: "casing", mesh: serializeMeshAsset(casingMesh()), transform: identity }] },
        // Plasma grenades in flight (I10): four copies held in reserve, spawned on a throw.
        { id: "prefab-plasma", name: "plasma grenade", pool: 4, nodes: [{ key: "root", name: "plasma grenade", mesh: serializeMeshAsset(plasmaGrenadeMesh()), transform: identity }] },
      ],
      debris: LOCKOUT_DEBRIS,
      decalMarks: LOCKOUT_DECAL_MARKS,
      foliage: lockoutFoliage(),
      audio: LOCKOUT_AUDIO,
      ui: LOCKOUT_UI,
      components: LOCKOUT_COMPONENTS,
      actions: LOCKOUT_INPUT_ACTIONS,
      strings: LOCKOUT_STRINGS,
    });
  }
  return meshSidecar;
}

export const LOCKOUT_SCENE_TRIANGLES = (() => {
  const g = MAP_GEOMETRY;
  const map =
    [g.wall, g.floor, g.under, g.snow].reduce((n, st) => n + st.indices.length / 3, 0) + g.trim.indices.length / 3;
  const bot = soldierMesh().primitives.reduce((n, p) => n + p.indices.length / 3, 0);
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
  const roam = NAV_NODES.flat().map((n) => n.toFixed(2)).join(",");
  const power = NAV_POWER.flatMap((i) => NAV_NODES[i]!).map((n) => n.toFixed(2)).join(",");
  return `local ROAM = {${roam}}\nlocal POWER = {${power}}`;
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

-- Text in the player's language (EP19b): the string table's, else the English as written.
local function T(key, english, ...)
  local s = cartbox.text(key, ...)
  if s == key then return english end
  return s
end
-- Game type and weapon names, in the current language: relabelled as the menu
-- and HUD draw, so a language switch mid-game shows at once.
for k, m in pairs(MODES) do m.en = m.name end
for id, w in pairs(W) do w.en = w.name end
local function relabel()
  for k, m in pairs(MODES) do m.name = T("mode."..k, m.en) end
  for id, w in pairs(W) do w.name = T("weapon."..id, w.en) end
end
relabel()

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
intro = nil  -- ticks into the match intro (see play_intro), or nil
local flash = 0
local tick = 0
-- First-person arms (I9): each weapon's viewmodel instance, whose state machine
-- plays the motion -- the cart only says what happened (fire, reload, melee,
-- ready) and how fast the player is moving.
local WIDX = { br=8, smg=9, shotgun=10, sniper=11, magnum=12, sword=13 }
local vm_speed = {}
local function vm(name)
  local idx = WIDX[p.slot==1 and p.g1 or p.g2]
  if idx then cartbox.trigger(idx, name) end
end
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

-- The first wall a segment from A to B strikes: t (0..1 along it) and the face's
-- normal -- where a shot's sparks fly from (nil when it strikes nothing).
function seg_first(x0,y0,z0, x1,y1,z1)
  local d = {x1-x0, y1-y0, z1-z0}
  local o = {x0, y0, z0}
  local best, bn = nil, nil
  for i=0,ncol()-1 do
    local b=i*6
    local tmin,tmax,axis = 0.0, 1.0, 0
    local ok = true
    for a=1,3 do
      local lo, hi = COL[b+a], COL[b+a+3]
      if math.abs(d[a]) < 1e-6 then
        if o[a] < lo or o[a] > hi then ok=false break end
      else
        local t1=(lo-o[a])/d[a]; local t2=(hi-o[a])/d[a]
        if t1>t2 then t1,t2=t2,t1 end
        if t1>tmin then tmin=t1; axis=a end
        if t2<tmax then tmax=t2 end
        if tmin>tmax then ok=false break end
      end
    end
    if ok and tmin>0.02 and axis>0 and (best==nil or tmin<best) then best=tmin; bn=axis end
  end
  if not best then return nil end
  local n = {0,0,0}
  n[bn] = d[bn] > 0 and -1 or 1
  return best, n[1], n[2], n[3]
end

-- Sparks where a shot from (x0,y0,z0) along (fx,fy,fz) strikes a wall within rng.
local function wall_sparks(x0,y0,z0, fx,fy,fz, rng)
  local t,nx,ny,nz = seg_first(x0,y0,z0, x0+fx*rng, y0+fy*rng, z0+fz*rng)
  if t then
    local hx,hy,hz = x0+fx*rng*t, y0+fy*rng*t, z0+fz*rng*t
    cartbox.burst("spark", hx+nx*0.03, hy+ny*0.03, hz+nz*0.03, nx,ny,nz)
    cartbox.decal("pock", hx, hy, hz, nx,ny,nz)
  end
end

-- Now and then the wind lifts snow off a high ledge near the player.
function ledge_snow()
  if not p or tick % 23 ~= 0 then return end
  local j = math.random(0, ncol()-1)
  local b = j*6
  local top = COL[b+5]
  if top < 3 then return end
  local x = COL[b+1] + math.random()*(COL[b+4]-COL[b+1])
  local z = (math.random() < 0.5) and COL[b+3] or COL[b+6]
  if d3(x,top,z, p.x,p.y,p.z) > 26 then return end
  cartbox.burst("drift", x, top+0.05, z, 0.9, 0.15, -0.6)
end

-- A cyan flare off a soldier's shield where a round lands (toward the shooter),
-- and the shield itself lights up around the body (cartbox.shield, see animate_bot).
local function shield_hit(o, hy, sx,sy,sz)
  cartbox.burst("shield", o.x, hy or o.y+1.2, o.z, sx-o.x, (sy or o.y+1.2)-(hy or o.y+1.2), sz-o.z, 0.8)
  if (o.sh or 0) > 0 then o.flare = 1 end
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

-- Shields recharge, Halo-style: after 4 s without a hit they refill over 2 s.
-- Only the machine that owns a soldier runs this; the others see its shield
-- rise in the net state (animate_bot shimmers it either way).
local function recharge(o)
  if o.dead or o.remote or not MODE.shields then return end
  o.calm = (o.calm or 0) + 1
  local cap = o.jugg and 200 or 100
  if o.calm > 240 and (o.sh or 0) < cap then o.sh = math.min(cap, (o.sh or 0) + cap/120) end
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
-- Called when the room goes away mid-match; the title screen resets the rest.
function leave_room_state() MM_RESET = true end

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
  target.calm = 0   -- the shield's recharge waits for a quiet spell (see recharge)
  if (target.sh or 0) > 0 then
    target.flare = 1
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
  if NETMODE ~= 0 and mode == 0 and phase == "play" then
    -- Left the room (or lost it) mid-match: back to the title screen.
    NETMODE, MYSLOT, HUMANS = 0, 0, 1
    phase = "menu"; leave_room_state()
    return
  end
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
    if remote and not o.remote then nav_drop(o) end                  -- another browser drives it now
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
    if holder == p and ball.carrier ~= p then say(T("msg.ball","You have the ball"),9) end
    ball.carrier, ball.live = holder, live
    if not holder then ball.x, ball.z, ball.y = s16(b)/100, s16(b >> 16)/100, s16(value)/100 end
  elseif MODE.obj == "hill" and value ~= hill.idx and HILLS[value] then
    hill.idx = value
    local h = HILLS[value]; hill.x,hill.y,hill.z = h[1],h[2],h[3]
    say(T("msg.hill","Hill moved"),12)
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

local VOX={["Double Kill!"]="v2",["Triple Kill!"]="v3",["Overkill!"]="v4",["Killtacular!"]="v5",["Killing Spree!"]="s5",["Killing Frenzy!"]="s10",["Running Riot!"]="s15",JUGGERNAUT="jug"}
function say(txt, color)
  announce.text=txt; announce.color=color or 12; announce.t=110
  if VOX[txt] then cartbox.sound(VOX[txt]) end
end

-- Register a kill: scoring, sprees, multikills, feed, and juggernaut handover.
function register_kill(killer, victim, hs)
  victim.dead=true; victim.respawn = MODE.obj=="jugg" and 70 or 100
  if killer == p and victim ~= p then p.kills = (p.kills or 0) + 1 end
  -- Which way the body is thrown when it goes limp (a cosmetic ragdoll, local
  -- to each browser): away from the killer, harder for a headshot's snap back.
  if killer and killer~=victim then
    local dx, dz = victim.x-killer.x, victim.z-killer.z
    local d = math.sqrt(dx*dx+dz*dz)+0.001
    local f = hs and 4.5 or 3.2
    victim.kick = {dx/d*f, 1.1, dz/d*f}
  else victim.kick = {0, 0.4, 0} end
  victim.kick_joint = hs and "head" or "chest"
  -- The player's own weapon drops where they fell (the bots drop theirs as they go limp).
  if victim == p then
    local k = victim.kick
    cartbox.debris("drop_"..((p.slot==1 and p.g1 or p.g2) or "br"), p.x, p.y + 1.15, p.z, k[1]*0.45, 1.2, k[3]*0.45)
  end
  victim.deaths=(victim.deaths or 0)+1
  victim.streak=0
  if killer and killer~=victim then
    if MODE.obj=="ball" or MODE.obj=="hill" then
      -- objective modes: kills don't score, holding does
    elseif MODE.obj=="jugg" then
      if victim.jugg then killer.jugg=true; victim.jugg=false; killer.score=(killer.score or 0)+1; if killer==p then say(T("msg.jugg","JUGGERNAUT"),9) elseif victim==p then say(T("msg.hunted","YOU ARE THE HUNTED"),6) end
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
      local m = {"","",T("msg.double","Double Kill!"),T("msg.triple","Triple Kill!"),T("msg.overkill","Overkill!"),T("msg.killtacular","Killtacular!")}
      if killer.multi>=2 then say(m[math.min(6,killer.multi)],9) end
      local sp = {[5]=T("msg.spree","Killing Spree!"),[10]=T("msg.frenzy","Killing Frenzy!"),[15]=T("msg.riot","Running Riot!")}
      if sp[killer.streak] then say(sp[killer.streak],6) end
    end
    add_feed((killer.tag or "?").." > "..(victim.tag or "?")..(hs and T("feed.headshot","  (headshot)") or ""), killer==p and 6 or 13)
  end
  if MODE.obj=="ball" and ball.carrier==victim then ball.live=true; ball.carrier=nil; ball.x=victim.x; ball.y=victim.y+0.6; ball.z=victim.z end
end

function score_of(who)
  if MODE.teams and MODE.obj=="slayer" then return team[who.team] end
  return who.score or 0
end

-- ---------------------------------------------------------------------------
-- Grenades: a thrown plasma grenade (I10) arcs under gravity, bounces off floor
-- level, sticks to any soldier it touches, and detonates on a fuse, dealing
-- splash to everyone in range. In flight it is a boiling blue charge (a prefab
-- copy, placed each tick) lighting what it passes, trailing light.
function throw_grenade(who, fx,fy,fz)
  if (who.nade or 0) <= 0 then return end
  who.nade = who.nade - 1
  local x, y, z = who.x, who.y+EYE, who.z
  local obj = cartbox.spawn("plasma grenade", x, y, z, 0, 0, 0)
  table.insert(grenades, { x=x, y=y, z=z, vx=fx*0.5, vy=fy*0.5+0.12, vz=fz*0.5, t=90, owner=who, obj=obj, spin=0 })
end

local function explode(g)
  flash = math.max(flash, 3)
  if g.obj then cartbox.despawn(g.obj) end
  cartbox.sound("blast",g.x,g.y+0.2,g.z,1.4)
  cartbox.burst("plasmablast", g.x, g.y+0.2, g.z, 0,1,0)
  cartbox.burst("smoke", g.x, g.y+0.3, g.z, 0,1,0)
  -- A soot burn on whatever it went off over.
  local t,nx,ny,nz = seg_first(g.x, g.y+0.3, g.z, g.x, g.y-3, g.z)
  if t then cartbox.decal("burn", g.x, g.y+0.3-3.3*t, g.z, nx,ny,nz) end
  local function splash(o)
    if not o or o.dead then return end
    local m = d3(g.x,g.y,g.z, o.x,o.y+1,o.z)
    if m < 4.5 then damage(o, (1 - m/4.5) * 90, g.owner, false) end
  end
  splash(p)
  for _,o in ipairs(bots) do splash(o) end
end

-- A plasma grenade sticks to the first soldier (not its thrower) it comes close to.
local function stick(g)
  local function near(o)
    return o and o ~= g.owner and not o.dead and d3(g.x,g.y,g.z, o.x,o.y+1.1,o.z) < 0.65
  end
  if near(p) then return p end
  for _,o in ipairs(bots) do if near(o) then return o end end
  return nil
end

local function update_grenades()
  for i=#grenades,1,-1 do
    local g=grenades[i]
    if g.stuck then
      -- Riding its victim until it goes off.
      g.x, g.y, g.z = g.stuck.x + g.ox, g.stuck.y + g.oy, g.stuck.z + g.oz
    else
      g.vy = g.vy - GRAV*0.7
      g.x=g.x+g.vx; g.y=g.y+g.vy; g.z=g.z+g.vz
      -- crude floor / ledge bounce
      for j=0,ncol()-1 do local b=j*6
        if g.x>COL[b+1] and g.x<COL[b+4] and g.z>COL[b+3] and g.z<COL[b+6] and g.y<COL[b+5] and g.y>COL[b+5]-0.6 and g.vy<0 then
          g.y=COL[b+5]; g.vy=-g.vy*0.4; g.vx=g.vx*0.6; g.vz=g.vz*0.6
        end
      end
      local o = stick(g)
      if o then g.stuck = o; g.ox, g.oy, g.oz = g.x - o.x, g.y - o.y, g.z - o.z end
      g.spin = g.spin + 0.25
    end
    if g.obj then cartbox.place(g.obj, g.x, g.y, g.z, g.spin, g.spin*0.6, 0, 1) end
    g.t=g.t-1
    if g.t<=0 or g.y<-8 then explode(g); table.remove(grenades,i) end
  end
end

-- A spent casing kicked out of a gun's ejection port, up and to the right of
-- where it faces (cosmetic debris, simulated in this browser only). (fx, fz)
-- is the facing on the ground; right of it is (-fz, fx).
local function eject_casing(x, y, z, fx, fz)
  local rx, rz = -fz, fx
  cartbox.debris("casing", x + rx*0.14, y, z + rz*0.14,
    rx*1.7 + fx*0.2 + (math.random()-0.5)*0.5, 1.5 + math.random()*0.7, rz*1.7 + fz*0.2 + (math.random()-0.5)*0.5)
end

local function player_fire()
  if p.cool>0 or p.dead then return end
  local wid = p.slot==1 and p.g1 or p.g2
  local w = W[wid]
  local ammo = p.slot==1 and p.a1 or p.a2
  -- auto-melee when an enemy is right in front
  local aim,ad = auto_target()
  if aim and ad < 2.4 then
    p.cool=18; flash=3; vm("melee")
    cartbox.sound("fire_sword",nil,nil,nil,1,0.9+math.random()*0.2)
    -- The swipe's glowing arc, right to left across the view.
    local fx,fy,fz = forward()
    local rx,rz = fz, -fx
    cartbox.burst("slash", p.x+rx*0.7+fx*0.8, p.y+EYE-0.25, p.z+rz*0.7+fz*0.8, -rx*1.4+fx*0.3, 0.15, -rz*1.4+fz*0.3)
    if not aim.dead then damage(aim, (aim.sh or 0) + 90, p, false) end   -- melee strips shields
    return
  end
  if ammo<=0 then
    -- reload from reserve, else fall back to the magnum
    local res = p.slot==1 and p.r1 or p.r2
    if res>0 then
      local take=math.min(w.mag,res)
      if p.slot==1 then p.a1=take; p.r1=res-take else p.a2=take; p.r2=res-take end
      p.cool=40; vm("reload"); return
    end
    p.slot=(p.slot==1) and 2 or 1; vm("ready"); return
  end
  p.cool = w.cool; flash = 4; vm("fire")
  cartbox.sound("fire_"..wid,nil,nil,nil,0.7,0.96+math.random()*0.08)
  if p.slot==1 then p.a1=p.a1-1 else p.a2=p.a2-1 end
  local ex,ey,ez = p.x, p.y+EYE, p.z
  do local fx,_,fz = forward(); eject_casing(ex + fx*0.35, ey - 0.16, ez + fz*0.35, fx, fz) end
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
      shield_hit(best, best._hy, ex,ey,ez)
    else
      wall_sparks(ex,ey,ez, fx,fy,fz, w.rng)
    end
  end
end

-- Whether spawn pad i's weapon is there to take: the Pickup component (EP14)
-- shows the weapon floating over the pad only then.
function pickup_ready(i)
  return phase == "play" and MODE.weapons[MW[i]] and (mtimer[i] or 0) == 0
end

local function try_pickups()
  for i=0,(#MRK//3)-1 do
    local id=MW[i+1]; local legal=MODE.weapons[id]
    mtimer[i+1]=math.max(0,(mtimer[i+1] or 0)-1)
    if legal and mtimer[i+1]==0 then
      local mx,my,mz=MRK[i*3+1],MRK[i*3+2],MRK[i*3+3]
      if math.abs(p.x-mx)<1.4 and math.abs(p.z-mz)<1.6 and math.abs((p.y+1)-my)<2.0 then
        give(p,1,id); p.slot=1; vm("ready"); mtimer[i+1]=540; say(T("msg.pickup","Picked up "..W[id].name,W[id].name),12)
      end
    end
  end
  -- ammo/grenade top-up when standing on a marker (light resupply)
end

-- ---------------------------------------------------------------------------
-- Bot navigation. The arena's walkable surface is baked from its colliders
-- (the scene's navmesh), and the host walks every bot over it as an agent: each
-- finds its own route (up the ramps, off the ledges), keeps clear of the other
-- bots and of the players, and reports where it got to each tick. The cart only
-- says where each bot should go.
local BOT_R, BOT_RUN, BOT_FIGHT = 0.45, 4.5, 2.6
local NROAM, NPOWER = #ROAM // 3, #POWER // 3
local function roam_pos(i) return ROAM[i*3-2], ROAM[i*3-1], ROAM[i*3] end
local function power_pos(i) return POWER[i*3-2], POWER[i*3-1], POWER[i*3] end

-- (Re)place a bot's agent where it stands (at a spawn, after a respawn).
function nav_place(o)
  o.gx, o.gy, o.gz, o.arrived, o.goal_t = nil, nil, nil, true, 0
  cartbox.agent(o.id, o.x, o.y, o.z, BOT_RUN, BOT_R)
  o.agent = true
end

-- Take a bot's agent away (dead, or another browser drives it now).
function nav_drop(o)
  if o.agent then cartbox.removeagent(o.id); o.agent = false end
end

-- Send a bot somewhere (repeats of the same goal aren't sent again).
local function nav_goto(o, x, y, z, speed)
  if not x then return end
  speed = speed or BOT_RUN
  if o.gx and math.abs(o.gx-x) + math.abs(o.gz-z) + math.abs(o.gy-y) < 0.6 and o.gspeed == speed then return end
  o.gx, o.gy, o.gz, o.gspeed, o.arrived = x, y, z, speed, false
  cartbox.moveto(o.id, x, y, z, speed)
end

-- Read back where the host walked a bot; true while it is moving.
local function nav_follow(o)
  local x, y, z, face, moving, air, arrived, nopath = cartbox.agentpos(o.id)
  if not x then return false end
  o.x, o.y, o.z, o.air = x, y, z, air
  if moving then o.mface = face end
  o.arrived = arrived or nopath
  return moving
end

-- The players the bots (and each other) must keep out of: this browser's
-- player and, online, the other humans' stand-ins. Obstacles the host's agents
-- steer around and push away from.
local function nav_obstacles()
  if NETMODE == 1 then return end
  if p.dead then cartbox.removeagent(100) else cartbox.obstacle(100, p.x, p.y, p.z, PR*0.8) end
  for i,o in ipairs(bots) do
    if o.remote and not o.dead then cartbox.obstacle(200+i, o.x, o.y, o.z, BOT_R)
    else cartbox.removeagent(200+i) end
  end
end

-- Where a bot wants to be, by game type (a point; the agent finds the way).
local function bot_goal(o)
  if MODE.obj=="ball" then
    if ball.carrier==o then return power_pos(math.random(1,NPOWER)) end    -- run it somewhere high
    if ball.live then return ball.x, ball.y-0.4, ball.z end
    local c = ball.carrier; if c then return c.x, c.y, c.z end
  elseif MODE.obj=="hill" then return hill.x + math.random()*2-1, hill.y, hill.z + math.random()*2-1
  elseif MODE.obj=="jugg" then
    if o.jugg then return power_pos(1) end                                  -- the juggernaut holds the deck
    local j = p.jugg and p or nil
    for _,b in ipairs(bots) do if b.jugg then j=b end end
    if j then return j.x, j.y, j.z end
  end
  local r = math.random()
  if r < 0.45 then                                                                      -- hunt someone
    local prey = (math.random() < 0.5) and p or bots[math.random(1, #bots)]
    if prey and prey ~= o and not prey.dead and enemy_of(o, prey) then return prey.x, prey.y, prey.z end
  end
  if r < 0.75 then return power_pos(math.random(1,NPOWER)) end                          -- take a power position
  return roam_pos(math.random(1, NROAM))                                                -- roam
end

-- Every player a bot could be fighting: the local player and all the others.
function all_players()
  local list = { p }
  for _,o in ipairs(bots) do list[#list+1] = o end
  return list
end

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
  if o.dead then
    nav_drop(o)                      -- a corpse doesn't block the way
    o.respawn=o.respawn-1
    if o.respawn<=0 then respawn(o); nav_place(o) end
    return
  end
  if not o.agent then nav_place(o) end
  o.moving = nav_follow(o)
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
      cartbox.sound("fire_"..(w.melee and "sword" or (o.g1 or "br")),o.x,o.y+1.3,o.z,1,0.92+math.random()*0.16)
      if not w.melee and m > 0.01 and d3(o.x,o.y,o.z, p.x,p.y,p.z) < 25 then eject_casing(o.x + dx/m*0.3, o.y + 1.3, o.z + dz/m*0.3, dx/m, dz/m) end
      local acc = MODE.shields and 0.30 or 0.5    -- SWAT bots hit harder
      if w.melee then acc = (m < 3) and 0.9 or 0 end
      if math.random() < acc then
        local dmg = (w.dmg or 12) * (w.pel or 1) * 0.6
        local head = math.random() < 0.12
        if head then dmg = dmg*(w.hs or 1.5) end
        damage(tg, dmg, o, head)
        if not w.melee then shield_hit(tg, tg.y + (head and 1.6 or 1.1), o.x,o.y+1.4,o.z) end
      elseif not w.melee then
        -- A miss: the round goes past its target and sparks off whatever is behind.
        local ox,oy,oz = o.x, o.y+1.4, o.z
        local fx,fy,fz = tg.x-ox+(math.random()-0.5)*1.2, tg.y+1.2-oy+(math.random()-0.5)*0.8, tg.z-oz+(math.random()-0.5)*1.2
        local fm = math.sqrt(fx*fx+fy*fy+fz*fz)
        if fm > 0.01 and d3(ox,oy,oz, p.x,p.y,p.z) < 30 then wall_sparks(ox,oy,oz, fx/fm,fy/fm,fz/fm, w.rng or 40) end
      end
    end
    -- Close the distance when out of range; in range, strafe -- a step to one
    -- side of the line to the target every second or so -- so a fight isn't two
    -- statues trading shots.
    if m > (w.rng or 40)*0.7 or w.melee then
      if (tick + o.id*5) % 15 == 0 then nav_goto(o, tg.x, tg.y, tg.z, BOT_FIGHT) end
    elseif (tick + o.id*11) % 60 == 0 or o.arrived then
      local side = (math.random() < 0.5) and -1 or 1
      local ux, uz = dz/math.max(0.01,m), -dx/math.max(0.01,m)
      local step = 1.5 + math.random()*1.5
      nav_goto(o, o.x + ux*side*step, o.y, o.z + uz*side*step, BOT_FIGHT)
    end
  else
    -- Pick a new destination when there, and re-think every couple of seconds;
    -- now and then go and grab a weapon from a marker.
    if o.arrived or (tick + (o.id or 0)*23) % 150 == 0 then
      local k = math.random(1, #MRK // 3)
      if math.random() < 0.2 and MODE.weapons[MW[k]] then
        nav_goto(o, MRK[k*3-2], MRK[k*3-1]-0.4, MRK[k*3])
      else
        nav_goto(o, bot_goal(o))
      end
    end
    -- A loose ball close by: straight for it.
    if MODE.obj=="ball" and ball.live and d3(o.x,o.y,o.z, ball.x,ball.y,ball.z) < 6 then
      nav_goto(o, ball.x, ball.y-0.4, ball.z)
    end
    o.face = o.mface or o.face
  end
  bot_pickups(o)
end

-- Players can't walk through the bots (or the other humans' stand-ins): push
-- the local player back out of any body it overlaps, respecting the walls.
local function push_from_bots()
  if p.dead then return end
  for _,o in ipairs(bots) do
    if not o.dead and math.abs(o.y - p.y) < 1.5 then
      local dx, dz = p.x - o.x, p.z - o.z
      local d = math.sqrt(dx*dx + dz*dz)
      local min = PR*0.8 + BOT_R
      if d < min then
        if d < 0.001 then dx, dz, d = 1, 0, 1 end
        local k = (min - d) / d
        move_axis("x", dx*k); move_axis("z", dz*k)
      end
    end
  end
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
          if o==p then say(T("msg.ball","You have the ball"),9) end
          break
        end
      end
    end
  elseif MODE.obj=="hill" then
    if tick>=hill.next then
      hill.idx = hill.idx % #HILLS + 1
      local h=HILLS[hill.idx]; hill.x,hill.y,hill.z=h[1],h[2],h[3]; hill.next=tick+HILL_MOVE
      if tick>1 then say(T("msg.hill","Hill moved"),12) end
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

-- Your career (EP15b): matches, wins, kills and deaths, kept with cartbox.save
-- between visits (and, signed in, between browsers). Shown on the title menu.
career = cartbox.load() or {}
function record_match(w)
  local mine = p.team=="blue" and "BLUE TEAM WINS" or "RED TEAM WINS"
  career.matches = (career.matches or 0) + 1
  if w == "YOU WIN" or (MODE.teams and w == mine) then career.wins = (career.wins or 0) + 1 end
  career.kills = (career.kills or 0) + (p.kills or 0)
  career.deaths = (career.deaths or 0) + (p.deaths or 0)
  cartbox.save(career)
end
function career_line()
  if not career.matches then return "" end
  return "Career: "..career.matches.." match"..(career.matches==1 and "" or "es").." . "..(career.wins or 0).." won . "..(career.kills or 0).." kills . "..(career.deaths or 0).." deaths"
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
  for _,g in ipairs(grenades) do if g.obj then cartbox.despawn(g.obj) end end
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
  -- Offline, a match opens on the intro flyover (the "Intro" timeline); online
  -- everyone drops straight in, so nobody's match starts behind the others'.
  intro = NETMODE == 0 and 0 or nil
  if intro then cartbox.playtimeline("Intro"); prev.skip = true end
end

-- The intro: the timeline has the camera while the soldiers stand at their
-- spawns, under letterbox bars naming the map and game type. It ends by itself
-- or on Z. Returns true while it's still showing.
function play_intro()
  if not intro then return false end
  intro = intro + 1
  local name = cartbox.timeline()
  -- (the timeline starts the tick after it's asked for, so give it a moment)
  if (intro > 10 and name == nil) or edge("skip", btn(4)) then
    intro = nil
    cartbox.stoptimeline()
    return false
  end
  cartbox.clearlights()
  cartbox.clearposes()
  for i=1,NBOT do animate_bot(i, bots[i]) end
  drive_camera()  -- the timeline's camera takes over; this keeps HUD compositing on
  cartbox.hud(1)
  -- The letterbox slides in and out with the timeline's "letterbox" value (EP17).
  local bar = math.floor(64 * (cartbox.timelinevalue("letterbox") or 1))
  rect(0, 0, 1280, bar, 5)
  rect(0, 720 - bar, 1280, bar, 5)
  print("LOCKOUT", 40, 18, 12, false, 3, true)
  print(MODE.name or "", 40, 676, 9, false, 2, true)
  print("Z to skip", 1110, 680, 13, false, 1, true)
  return true
end

-- 8-button controls: tank move + turn, hold A to strafe, double-tap A grenade.
local function play_input()
  local aheld = btn(6)
  if edge("a", aheld) then
    if tick-(p.lastA or -99) < 14 and not p.dead then local fx,fy,fz=forward(); throw_grenade(p,fx,fy,fz) end
    p.lastA=tick
  end
  -- Input actions (EP15): fire, jump, swap, grenade and zoom, each on its console
  -- button plus its own keys and controller buttons (see the Input tab).
  if cartbox.actionp("grenade") and not p.dead then local fx,fy,fz=forward(); throw_grenade(p,fx,fy,fz) end
  -- Facing yaw ay looks along (sin ay, cos ay); the screen's right is then
  -- (-cos ay, sin ay) — the same right the held weapon is placed with — so
  -- turning right *decreases* ay.
  local sy,cy = math.sin(p.ay), math.cos(p.ay)
  local rtx, rtz = -cy, sy
  local mvx,mvz = 0,0
  local moving=false
  -- Dual sticks (the touch pad): the left one walks and strafes at its lean,
  -- the right one aims (x turns, y pitches). Without sticks (a keyboard), the
  -- 8-button scheme.
  local lx, ly = cartbox.stick(0)
  local rx, ry = cartbox.stick(1)
  local lstick = math.abs(lx) + math.abs(ly) > 0.05
  if not p.dead then
    if lstick then
      mvx = -ly*sy + lx*rtx; mvz = -ly*cy + lx*rtz; moving=true
    else
      if btn(0) then mvx=mvx+sy; mvz=mvz+cy; moving=true end
      if btn(1) then mvx=mvx-sy; mvz=mvz-cy; moving=true end
      if aheld then
        if btn(2) then mvx=mvx-rtx; mvz=mvz-rtz; moving=true end
        if btn(3) then mvx=mvx+rtx; mvz=mvz+rtz; moving=true end
      else
        if btn(2) then p.ay=p.ay+TURN end
        if btn(3) then p.ay=p.ay-TURN end
      end
    end
    if rx ~= 0 then p.ay = p.ay - rx*math.abs(rx)*TURN*2.2 end   -- eased: fine aim near centre, fast at full lean
    local mm=math.sqrt(mvx*mvx+mvz*mvz)
    if mm>0 then local sp=MOVE*math.min(1,mm); move_axis("x",mvx/mm*sp); move_axis("z",mvz/mm*sp) end
  end
  do
    local idx = WIDX[p.slot==1 and p.g1 or p.g2]
    local sp = moving and 1 or 0
    if idx and vm_speed[idx] ~= sp then vm_speed[idx] = sp; cartbox.set(idx, "speed", sp) end
  end
  -- Pitch: the right stick aims up and down (up is up). Without it, auto-aim
  -- eases the pitch toward the locked enemy (the 8-button scheme has no pitch);
  -- once you have aimed by hand, the view stays where you leave it and auto-aim
  -- only nudges toward a locked enemy.
  local aim=auto_target()
  local want=0
  if aim then
    local hd=math.sqrt((aim.x-p.x)^2+(aim.z-p.z)^2)
    want=math.asin(clamp(((aim.y+1.2)-(p.y+EYE))/math.max(1,hd),-0.9,0.9))
  end
  if ry ~= 0 then
    p.ap = clamp(p.ap - ry*math.abs(ry)*0.045, -1.1, 1.1); p.manualpitch = true
  elseif p.manualpitch then
    if aim then p.ap = p.ap + (want-p.ap)*0.06 end
  else
    p.ap=p.ap+(want-p.ap)*0.2
  end
  if cartbox.action("jump") and p.grounded and not p.dead then p.vy=JUMP; p.grounded=false end
  if cartbox.actionp("swap") then p.slot=(p.slot==1) and 2 or 1; vm("ready") end
  local cur=W[p.slot==1 and p.g1 or p.g2]
  p.zoom = cur.zoom and (cartbox.action("zoom") or (aheld and not lstick and not (btn(0) or btn(1) or btn(2) or btn(3))))
  if p.cool>0 then p.cool=p.cool-1 end
  local firing = cur.auto and cartbox.action("fire") or cartbox.actionp("fire")
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
-- back up by WS); its arms animate themselves (see WIDX and vm above).
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
  -- Where the gun is held; its sway, bob, kick, reload and swing are the arms'
  -- own animation (I9), played by the viewmodel's state machine.
  local fwd, rgt, up = 0.4, 0.19, -0.235
  if wid=="sword" then fwd, rgt, up = 0.3, 0.13, -0.24 end
  if wid=="magnum" then rgt = rgt - 0.03; fwd = fwd - 0.03 end
  local ex, ey, ez = p.x, p.y+EYE, p.z
  local px = ex + fx*fwd + rx*rgt + ux*up
  local py = ey + fy*fwd + uy*up
  local pz = ez + fz*fwd + rz*rgt + uz*up
  -- Front layer: drawn over the finished scene, so it never clips into a wall.
  cartbox.meshpose(idx, px*WS, py*WS, pz*WS, p.ay, -p.ap, 0, WS, 0, armor_tint(p), true)
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
    local px=rx-math.sin(ang)*(m/28)*rr   -- screen-right is -sin of the relative bearing
    local py=ry-math.cos(ang)*(m/28)*rr
    circ(px,py,3,col)
  end
  for _,o in ipairs(bots) do
    if not o.dead and enemy_of(p,o) then if o.moving or MODE.obj=="jugg" and o.jugg then blip(o,6) end
    elseif not o.dead then blip(o,9) end
  end
  tri(rx,ry-7, rx-5,ry+5, rx+5,ry+5, 12)  -- player
  print(T("hud.motion","MOTION"),rx-34,ry+rr+6,13,false,1,true)
end

local function draw_hud()
  -- The HUD is a UI document (cartbox.ui): this sets what it shows.
  relabel()
  local U=cartbox.ui
  U.hide("menu")
  U.set("hp1",(MODE.shields and p.sh or p.hp)/100); U.set("hpc",p.sh>0 and 9 or 6)
  U.set("shields",MODE.shields); U.set("hp2",p.hp/100)
  local cur=W[p.slot==1 and p.g1 or p.g2]
  local ammo=p.slot==1 and p.a1 or p.a2
  local res=p.slot==1 and p.r1 or p.r2
  U.set("weapon",cur.name); U.set("ammo",ammo.." / "..res); U.set("ammoc",cur.melee and 13 or 12)
  for i=1,(p.nade or 0) do circ(1150+i*22,120,8,6); circb(1150+i*22,120,8,12) end
  local st
  local sc, tg = p.score or 0, MODE.target
  if MODE.obj=="slayer" and MODE.teams then st=T("status.teams","BLUE "..team.blue.."   RED "..team.red.."   /"..tg,team.blue,team.red,tg)
  elseif MODE.obj=="ball" then st=(ball.carrier==p and T("status.holdball","YOU HOLD THE BALL  ") or "")..T("status.ball","Ball "..sc.." /"..tg,sc,tg)
  elseif MODE.obj=="hill" then st=T("status.hill","Hill "..sc.." /"..tg,sc,tg)
  elseif MODE.obj=="jugg" then st=(p.jugg and T("status.youjugg","YOU ARE THE JUGGERNAUT  ") or T("status.huntjugg","Hunt the Juggernaut  "))..sc.." /"..tg
  else st=T("status.score","Score "..sc.."   Deaths "..p.deaths.."   /"..tg,sc,p.deaths,tg) end
  U.set("mode",MODE.name); U.set("status",st)
  local fd={}
  for i,f in ipairs(feed) do fd[i]={text=f.text,color=f.color}; f.t=f.t-1 end
  for i=#feed,1,-1 do if feed[i].t<=0 then table.remove(feed,i) end end
  U.set("feed",fd)
  if announce.t>0 then announce.t=announce.t-1; U.set("announce",announce.text); U.set("announcec",announce.color) else U.set("announce",nil) end
  U.set("dead",p.dead)
  U.show("hud"); U.draw()
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

-- Soldiers are skinned: each one's state machine (idle/run blended by speed,
-- a jump pose in the air) plays on its skeleton, a killed one goes limp as a
-- ragdoll, and the cart only feeds it parameters and places it. The speed eases
-- toward moving/standing so the stride blends in and out rather than snapping.
function animate_bot(i, o)
  local target = (o.moving and not o.dead) and 1 or 0
  -- Which way it's going relative to where it faces (EP17b's 2D move blend):
  -- ahead runs, behind back-pedals, sideways strafes -- a bot keeps facing
  -- whoever it's fighting while it moves.
  local fx, fz = math.sin(o.face or 0), math.cos(o.face or 0)
  local vx, vz = o.x - (o.px or o.x), o.z - (o.pz or o.z)
  o.px, o.pz = o.x, o.z
  local vm = math.sqrt(vx*vx + vz*vz)
  local ahead, across = 1, 0
  if vm > 1e-4 then ahead, across = (vx*fx + vz*fz) / vm, (vz*fx - vx*fz) / vm end
  o.spd = (o.spd or 0) + (target*ahead - (o.spd or 0)) * 0.25
  o.side = (o.side or 0) + (target*across - (o.side or 0)) * 0.25
  -- Only changes go out: the runtime takes a limited number of commands a tick.
  local spd = math.floor(o.spd * 50 + 0.5) / 50
  if spd ~= o.sent_spd then o.sent_spd = spd; cartbox.set(i, "speed", spd) end
  local side = math.floor(o.side * 10 + 0.5) / 10
  if side ~= o.sent_side then o.sent_side = side; cartbox.set(i, "side", side) end
  local air, dead = o.air and true or false, o.dead and true or false
  if air ~= o.sent_air then o.sent_air = air; cartbox.set(i, "grounded", not air) end
  if dead ~= o.sent_dead then
    o.sent_dead = dead; cartbox.set(i, "dead", dead)
    -- Killed: the body goes limp and tumbles (a ragdoll, simulated in this
    -- browser only); respawned: it stands back up on its animation.
    if dead then
      local k = o.kick or {0, 0.4, 0}
      cartbox.ragdoll(i, k[1], k[2], k[3], o.kick_joint or "chest")
      -- Its weapon falls from its hands and clatters to the deck (debris; the sword goes with it).
      cartbox.debris("drop_"..(o.g1 or "br"), o.x, o.y + 1.15, o.z, k[1]*0.45, 1.2, k[3]*0.45)
    else cartbox.unragdoll(i) end
  end
  -- The shield (H11): it flares gold where it's hit, fading over a few ticks, and
  -- shimmers while it recharges -- seen as the shield value climbing, so a soldier
  -- another browser owns shimmers too (a jump, a respawn, doesn't count).
  local sh = o.sh or 0
  local rise = sh - (o.prev_sh or sh)
  o.prev_sh = sh
  if rise > 0 and rise < 40 then o.shim_t = 20 end
  o.shim_t = math.max(0, (o.shim_t or 0) - 1)
  if o.dead then o.flare, o.shim_t = 0, 0 end
  cartbox.shield(i, o.flare or 0, math.min(1, o.shim_t / 10), 0)
  o.flare = math.max(0, (o.flare or 0) - 0.1)
  -- The body lies where it fell, and is taken away just before it respawns.
  if o.dead and (o.respawn or 0) < 10 then cartbox.meshpose(i,0,-50,0,0,0,0,0); return end
  cartbox.meshpose(i, o.x, o.y, o.z, o.face or 0, 0, 0, o.jugg and 1.25 or 1, 0, armor_tint(o))
  -- Aim with the body (look-at on the skeleton): the chest, and with it the arms
  -- and rifle, and the head turn toward whoever it's fighting, on top of the
  -- run or idle. With nobody to fight they let go. Staggered across bots, since
  -- a request stands until it's repeated.
  local tg = (not o.dead) and o.target or nil
  if tg then
    if tick % 4 == i % 4 then
      cartbox.lookat(i, "chest", tg.x, tg.y + 1.2, tg.z, 0.8, 40)
      cartbox.lookat(i, "head", tg.x, tg.y + 1.5, tg.z, 1, 60)
      o.aiming = true
    end
  elseif o.aiming then
    o.aiming = false
    cartbox.lookat(i, "chest", 0, 0, 0, 0)
    cartbox.lookat(i, "head", 0, 0, 0, 0)
  end
end

-- The mesh overlay always composites the 3D scene ON TOP of the cart's 2D frame,
-- so on the 2D-only screens (menu, results) every instance must be pushed off
-- screen -- otherwise the engine's default auto-orbit spins the arena over the
-- menu text (index 0 is the map, which carries the mountains; 1..NBOT are the
-- bots; scale 0 hides).
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
    winner = reached_target() or "MATCH OVER"; phase = "over"; record_match(winner)
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
-- The title screen: Matchmaking (online, through the page) above the game types
-- you can play against bots; a playlist pick; the search; and, in a matchmade
-- room, a lobby that starts the next match on its own.
local REQ_MATCHMAKE, REQ_CANCEL = 1, 2           -- cartbox.request kinds the page answers
local MM_FAILED = 3                             -- net() status: the page couldn't matchmake
local mm_mode, mm_page, mm_pick, mm_start_at = nil, nil, 1, nil
local MM_LOBBY_TICKS = 900                      -- a matchmade lobby waits 15s for players

local function humans_in_room()
  local n = 0
  for ns=0,7 do if (HUMANS >> ns) & 1 == 1 then n = n + 1 end end
  return n
end

local function menu_list(items, y0, selected)
  for i,label in ipairs(items) do
    local y = y0+(i-1)*40
    if i==selected then rect(470,y-6,360,34,1) end
    print(label,492,y,(i==selected) and 12 or 13,false,2,true)
  end
end

local function leave_matchmaking()
  cartbox.request(REQ_CANCEL, 0)
  mm_mode, mm_page, mm_start_at = nil, nil, nil
end

local function player_list(y)
  for ns=0,7 do if (HUMANS >> ns) & 1 == 1 then
    print("Player "..(ns+1)..(ns==0 and "  (host)" or "")..(ns==MYSLOT and "  <- you" or ""),470,y,13,false,2,true); y=y+34
  end end
end

function title_screen()
  local _, _, _, _, status = cartbox.net()
  cartbox.ui.hide("hud"); cartbox.ui.hide("menu")
  if MM_RESET then MM_RESET = false; mm_mode, mm_page, mm_start_at = nil, nil, nil end
  if NETMODE == 1 then
    -- An online guest: the host picks the game type (or its lobby timer does).
    print("ONLINE  --  you are Player "..(MYSLOT+1),470,170,9,false,2,true)
    print(mm_mode and "Matchmaking lobby -- the match starts soon..." or "Waiting for the host to start a match...",430,240,12,false,2,true)
    player_list(300)
    if mm_mode then
      print("X (or B) leave",470,600,13,false,1,true)
      if edge("back", btn(5)) then leave_matchmaking() end
    end
    return
  end
  if NETMODE == 2 and mm_mode then
    -- Hosting a matchmade room: count down, then start the playlist's game type.
    local key = (mm_mode == "any") and "ffa" or mm_mode
    mm_start_at = mm_start_at or (tick + MM_LOBBY_TICKS)
    local n = humans_in_room()
    local left = math.max(0, (mm_start_at - tick) // 60)
    print("MATCHMAKING  --  "..MODES[key].name,470,170,9,false,2,true)
    print(n.." player"..(n==1 and "" or "s").." + "..(8-n).." bots  --  starting in "..left.."s",430,220,12,false,2,true)
    player_list(290)
    print("Z (or A) start now . X (or B) leave",470,600,13,false,1,true)
    if edge("back", btn(5)) then leave_matchmaking() return end
    if n >= 8 or tick >= mm_start_at or edge("go", btn(4)) then
      mm_start_at = nil
      start_match(key)
    end
    return
  end
  if NETMODE == 0 and mm_mode then
    -- Searching: the page looks for a room (or opens one) and joins it.
    local name = (mm_mode == "any") and "any game type" or MODES[mm_mode].name
    if status == MM_FAILED then
      print("Matchmaking isn't available right now.",430,240,6,false,2,true)
      print("X (or B) back",470,320,13,false,1,true)
    else
      local dots = string.rep(".", (tick // 20) % 4)
      print("MATCHMAKING",530,170,9,false,2,true)
      print("Searching for players -- "..name..dots,430,240,12,false,2,true)
      print("X (or B) cancel",470,320,13,false,1,true)
    end
    if edge("back", btn(5)) then leave_matchmaking() end
    return
  end
  if NETMODE == 0 and mm_page == "playlist" then
    -- Pick a playlist to matchmake into.
    print("MATCHMAKING  --  choose a playlist",430,150,9,false,2,true)
    local items = {"Any game type"}
    for _,k in ipairs(ONLINE_KEYS) do items[#items+1] = MODES[k].name end
    local n = #items
    if edge("up", btn(0)) then mm_pick=(mm_pick-2)%n+1 end
    if edge("down", btn(1)) then mm_pick=mm_pick%n+1 end
    menu_list(items, 210, mm_pick)
    print("Up/Down choose . Z (or A) search . X (or B) back",430,540,13,false,1,true)
    if edge("back", btn(5)) then mm_page = nil return end
    if edge("go", btn(4)) then
      mm_mode = (mm_pick == 1) and "any" or ONLINE_KEYS[mm_pick-1]
      mm_page = nil
      cartbox.request(REQ_MATCHMAKE, mm_pick-1)   -- 0 any, else the game type (1-based)
    end
    return
  end
  -- The game types (and, offline, Matchmaking after them).
  relabel()
  local keys = (NETMODE == 2) and ONLINE_KEYS or MODE_KEYS
  local items = {}
  for _,k in ipairs(keys) do items[#items+1] = MODES[k].name end
  if NETMODE == 0 then items[#items+1] = T("menu.matchmaking", "Matchmaking (online)") end
  local n=#items
  if sel > n then sel = 1 end
  -- The menu is a UI document (cartbox.ui): its list moves with the d-pad.
  local U=cartbox.ui
  U.set("modes",items); U.select("modes",sel)
  if NETMODE == 2 then
    local humans = humans_in_room()
    U.set("menutop",T("menu.host","ONLINE  --  you are the host  --  "..humans.." player"..(humans==1 and "" or "s").." + "..(8-humans).." bots",humans,8-humans)); U.set("menutopc",9)
  else U.set("menutop",T("menu.top","Matchmaking finds players online . or play the game types below vs 7 bots")); U.set("menutopc",13) end
  U.set("career", career_line())
  U.show("menu")
  local id
  if U.shown("menu") then
    id=U.update(); sel=U.selected("modes"); U.draw()
    if NETMODE == 0 then rect(470, 190+(n-1)*40-4, 360, 2, 5) end   -- a rule above Matchmaking
  else
    -- Run without its UI documents: the plain list.
    if edge("up", btn(0)) then sel=(sel-2)%n+1 end
    if edge("down", btn(1)) then sel=sel%n+1 end
    menu_list(items, 196, sel)
  end
  local go, go2 = edge("go", btn(4)), edge("go2", btn(5))
  if id=="modes" or go or go2 then
    if NETMODE == 0 and sel == n then mm_page, mm_pick = "playlist", 1
    else start_match(keys[sel]) end
  end
end

function TIC()
  cls(0)
  tick=tick+1

  if phase=="menu" or phase=="over" then net_menu_sync() end

  if phase=="menu" then
    hide_scene()
    cartbox.hud(0)  -- 2D-only screen: draw the menu normally, not as a HUD over meshes
    sky()
    print("LOCKOUT ARENA",452,96,12,false,3,true)
    title_screen()
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
  if play_intro() then return end
  net_roles()
  net_receive()
  play_input()
  if p.dead then p.respawn=p.respawn-1; if p.respawn<=0 then respawn(p) end
  else move_vertical(); try_pickups() end
  push_from_bots()
  nav_obstacles()
  for _,o in ipairs(bots) do think_bot(o) end
  recharge(p); for _,o in ipairs(bots) do recharge(o) end
  update_grenades()
  ledge_snow()
  update_objective()
  local w=reached_target(); if w then winner=w; phase="over"; record_match(w) end
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
  -- Each plasma grenade lights what it passes (I10).
  for _,g in ipairs(grenades) do cartbox.light3d(g.x, g.y, g.z, 3.5, 90, 170, 255, 2.6) end
  if MODE.obj=="ball" then cartbox.light3d(ball.x, ball.y+0.6, ball.z, 5, 90,220,255, 3.2) end
  if MODE.obj=="hill" then cartbox.light3d(hill.x, hill.y+1.2, hill.z, 5.5, 120,255,150, 3.4) end

  cartbox.clearposes()
  for i=1,NBOT do animate_bot(i, bots[i]) end
  local cur_id = p.slot==1 and p.g1 or p.g2
  pose_viewmodel(cur_id)
  drive_camera()
  cartbox.hud(1)  -- composite this 2D frame as a HUD over the 3D arena

  draw_reticle()
  draw_muzzle_flash(W[cur_id])
  draw_hud()
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
