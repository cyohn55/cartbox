// Ties the HD-2D route together: render the 3D voxel street with renderScene, then
// composite the layered-parallax character into its shared z-buffer, over a
// REPLACED-style night sky. A FIXED ¾ camera follows the character (its look-at
// tracks the foot) so walking scrolls the world while the hero stays framed.

import { renderScene, DEFAULT_MODEL_LIGHT, type ModelLight, type Particle } from "@cartbox/editor";
import { buildWorld, buildAtlas, type Hd2dWorld } from "./world";
import { rigToLayers, compositeCharacter, type Camera, type CharacterLayer } from "./character";
import { buildHeroRig } from "./heroRig";
import type { CharState } from "./walk";

// Tunables (kept together so the look is easy to iterate).
export const CELL = 13;          // output px per world unit (zoom)
export const PITCH = 0.5;        // Octopath-style downward tilt
export const YAW = 0.32;         // fixed ¾ camera angle
export const SPRITE_SCALE = 2;   // output px per character texel
export const LOOK_HEIGHT = 2.2;  // camera looks at this height above the foot

// A cool moonlight key + a lifted ambient so the pixel-art materials stay readable.
const LIGHT: ModelLight = {
  direction: DEFAULT_MODEL_LIGHT.direction,
  color: [0.72, 0.82, 1.0],
  intensity: 0.85,
  ambient: 0.34,
};

// Built once — the street geometry/atlas and the character layers don't change.
let world: Hd2dWorld | null = null;
let layers: CharacterLayer[] | null = null;
let outBuf: Uint8ClampedArray | null = null;
let depthBuf: Float32Array | null = null;
let sky: Uint8ClampedArray | null = null;
let skySize = 0;

export function getWorld(): Hd2dWorld {
  if (!world) world = buildWorld(buildAtlas());
  return world;
}

// ---- rain (renderScene particles, sorted into the world's depth buffer) ------
const RAIN_COUNT = 230;
const RAIN_HEIGHT = 24;   // world units the drops fall through before wrapping
const RAIN_SPEED = 26;    // world units/second — fast enough to read as rain, not snow
let rainSeeds: { x: number; z: number; phase: number }[] | null = null;
function hash(n: number): number { const s = Math.sin(n * 12.9898 + 1.7) * 43758.5453; return s - Math.floor(s); }

/** Rain drops falling in a box around the character, so they occlude / are occluded
 *  by the 3D geometry (drops behind a tower are hidden) — depth-true rain. */
function rainParticles(char: CharState, seconds: number): Particle[] {
  if (!rainSeeds) {
    rainSeeds = Array.from({ length: RAIN_COUNT }, (_, i) => ({
      x: (hash(i) * 2 - 1) * 20, z: (hash(i + 9) * 2 - 1) * 9, phase: hash(i + 3),
    }));
  }
  return rainSeeds.map((s): Particle => {
    const fall = ((s.phase * RAIN_HEIGHT - seconds * RAIN_SPEED) % RAIN_HEIGHT + RAIN_HEIGHT) % RAIN_HEIGHT;
    return {
      position: [char.pos[0] + s.x, fall, char.pos[2] + s.z + 2],
      r: 120, g: 150, b: 190, emissive: 0.28, radius: 1, // dim + cool so it recedes like rain
    };
  });
}

function skyFor(size: number): Uint8ClampedArray {
  const s = new Uint8ClampedArray(size * size * 4);
  const moonX = size * 0.72, moonY = size * 0.2, moonR = size * 0.05;
  for (let y = 0; y < size; y += 1) {
    const t = y / size; // 0 top → 1 bottom
    const r = 12 + t * 26, g = 16 + t * 40, b = 34 + t * 44; // indigo zenith → teal horizon
    for (let x = 0; x < size; x += 1) {
      let cr = r, cg = g, cb = b;
      const dm = Math.hypot(x - moonX, y - moonY);
      if (dm < moonR) { cr = 224; cg = 234; cb = 248; }
      else if (dm < moonR * 3) { const k = 1 - (dm - moonR) / (moonR * 2); cr += k * 70; cg += k * 80; cb += k * 96; }
      const o = (y * size + x) * 4;
      s[o] = cr; s[o + 1] = cg; s[o + 2] = cb; s[o + 3] = 255;
    }
  }
  return s;
}

/** Render one frame following `char` (at time `seconds`) into an RGBA buffer. */
export function renderFrame(size: number, char: CharState, seconds: number): Uint8ClampedArray {
  if (!world) world = buildWorld(buildAtlas());
  if (!layers) layers = rigToLayers(buildHeroRig());
  if (!outBuf || outBuf.length !== size * size * 4) {
    outBuf = new Uint8ClampedArray(size * size * 4);
    depthBuf = new Float32Array(size * size);
  }
  if (!sky || skySize !== size) { sky = skyFor(size); skySize = size; }

  // The camera looks at the character (foot + a head-height offset), so walking
  // scrolls the world while the hero holds centre.
  const origin: [number, number, number] = [char.pos[0], char.pos[1] + LOOK_HEIGHT, char.pos[2]];
  const camera: Camera = { yaw: YAW, pitch: PITCH, cell: CELL, size, origin };

  const rendered = renderScene(world.models, {
    size, cell: CELL, yaw: YAW, pitch: PITCH, origin, light: LIGHT,
    particles: rainParticles(char, seconds),
    out: outBuf, depthBuffer: depthBuf!,
  });

  compositeCharacter(rendered.data, rendered.depth, camera, layers, char.pos, SPRITE_SCALE, {
    facing: char.facing, walkPhase: char.walkPhase,
  });

  // Compose the world+character (straight alpha) over the night sky.
  const final = new Uint8ClampedArray(sky); // copy the sky each frame
  const src = rendered.data;
  for (let i = 0; i < size * size; i += 1) {
    const a = src[i * 4 + 3]!;
    if (a === 0) continue;
    const inv = 255 - a, o = i * 4;
    final[o] = (src[o]! * a + final[o]! * inv) / 255;
    final[o + 1] = (src[o + 1]! * a + final[o + 1]! * inv) / 255;
    final[o + 2] = (src[o + 2]! * a + final[o + 2]! * inv) / 255;
    final[o + 3] = 255;
  }
  return final;
}
