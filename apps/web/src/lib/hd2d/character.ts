// The layered-parallax character compositor — the second half of the HD-2D spec.
// The hero is a CharacterRig (see heroRig.ts): a 2D pixel-art sprite SPLIT INTO
// DEPTH LAYERS. `rigToLayers` turns the rig's parts into depth-placed layers, then
// `compositeCharacter` projects each through the SAME camera as the 3D world and
// blits it into the world's shared z-buffer. Because the layers sit at different
// world-Z, camera yaw slides them relative to one another (parallax "swing") — a
// flat sprite reads as volume — while the shared z-buffer occludes it correctly.
//
// The projection here is byte-for-byte the one voxelModelRenderer/renderScene use.

import type { CharacterRig } from "@cartbox/editor";
import type { PixelCanvas } from "./pixelArt";

/** The orthographic camera renderScene is driven with (see RenderSceneOptions). */
export interface Camera {
  readonly yaw: number;
  readonly pitch: number;
  readonly cell: number;   // output px per world unit
  readonly size: number;   // square framebuffer edge, px
  readonly origin: readonly [number, number, number]; // world point at screen centre
}

export interface Projected {
  readonly sx: number;
  readonly sy: number;
  /** Camera-space depth; larger = nearer the viewer (matches the world z-buffer). */
  readonly camZ: number;
}

/** Project a world point to screen + depth exactly as renderScene does. */
export function projectWorld(worldX: number, worldY: number, worldZ: number, camera: Camera): Projected {
  const centre = camera.size / 2;
  const wx = worldX - camera.origin[0];
  const wy = worldY - camera.origin[1];
  const wz = worldZ - camera.origin[2];
  const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
  const yawX = wx * cosYaw + wz * sinYaw;
  const yawZ = -wx * sinYaw + wz * cosYaw;
  const camY = wy * cosPitch - yawZ * sinPitch;
  const camZ = wy * sinPitch + yawZ * cosPitch;
  return { sx: centre + yawX * camera.cell, sy: centre - camY * camera.cell, camZ };
}

/** Which body part a layer is, so the walk cycle can animate it. */
export type BodyPart = "cape" | "backArm" | "backLeg" | "torso" | "head" | "frontLeg" | "foreArm";

export interface CharacterLayer {
  readonly sprite: PixelCanvas;
  /** World-Z offset from the foot (>0 = toward the camera / nearer). */
  readonly dz: number;
  /** World-X offset from the foot centre. */
  readonly dx: number;
  readonly part: BodyPart;
}

/** Per-frame character animation state. */
export interface CharacterPose {
  readonly facing: 1 | -1;      // +1 art's authored facing (right), -1 mirrored (left)
  readonly walkPhase: number;   // radians; 0 = idle
}

/** Rig depthOffset (neg = toward camera) → world-Z (pos = toward camera). */
const DZ_SCALE = 0.12;
const PART_NAME: Record<string, BodyPart> = {
  cape: "cape", backArm: "backArm", backLeg: "backLeg", torso: "torso", body: "torso",
  head: "head", frontLeg: "frontLeg", foreArm: "foreArm", frontArm: "foreArm",
};

/**
 * Adapt a CharacterRig into depth-sorted layers for compositeCharacter. Each rig
 * part becomes a layer whose world-Z comes from its depthOffset; sorted back
 * (farthest) to front so painter order is correct within the character.
 */
export function rigToLayers(rig: CharacterRig): CharacterLayer[] {
  return rig.parts
    .map((p): CharacterLayer => ({
      sprite: { width: p.imageWidth, height: p.imageHeight, data: p.image },
      dz: -p.depthOffset * DZ_SCALE,
      dx: p.offsetX,
      part: PART_NAME[p.name] ?? "torso",
    }))
    .sort((a, b) => a.dz - b.dz);
}

/**
 * Screen-space offset (output px) a part gets at a walk phase: legs step (swing and
 * lift on the forward swing), arms and cape counter-swing, and the torso/head give a
 * small two-per-stride bob. `flip` mirrors the swing for a left-facing walk.
 */
function partOffset(part: BodyPart, walkPhase: number, spriteScale: number, flip: boolean): [number, number] {
  const swing = Math.sin(walkPhase) * (flip ? -1 : 1);
  const bob = -Math.abs(Math.sin(walkPhase * 2)) * spriteScale;
  const s = spriteScale;
  switch (part) {
    case "frontLeg": return [swing * 2 * s, -Math.max(0, swing) * 3 * s];
    case "backLeg": return [-swing * 2 * s, -Math.max(0, -swing) * 3 * s];
    case "foreArm": return [-swing * 2 * s, 0];
    case "backArm": return [swing * 2 * s, 0];
    case "cape": return [-swing * 1.4 * s, 0];
    case "torso": return [0, bob];
    case "head": return [0, bob];
    default: return [0, 0];
  }
}

/**
 * Composite the character's depth layers into an already-rendered world frame
 * (`data` RGBA + `depth` z-buffer, size×size). Each layer projects its foot through
 * the camera and is blitted upright (bottom-centre at the projected foot), scaled by
 * `spriteScale` output px per texel, depth-tested per pixel so solid geometry in
 * front occludes it. Layers arrive depth-sorted (back-to-front).
 */
export function compositeCharacter(
  data: Uint8ClampedArray,
  depth: Float32Array,
  camera: Camera,
  layers: readonly CharacterLayer[],
  foot: readonly [number, number, number],
  spriteScale: number,
  pose: CharacterPose = { facing: 1, walkPhase: 0 },
): void {
  const size = camera.size;
  const flip = pose.facing < 0;
  for (const layer of layers) {
    const worldDx = layer.dx * pose.facing;
    const p = projectWorld(foot[0] + worldDx, foot[1], foot[2] + layer.dz, camera);
    const [offX, offY] = partOffset(layer.part, pose.walkPhase, spriteScale, flip);
    const w = layer.sprite.width, h = layer.sprite.height;
    const drawW = w * spriteScale, drawH = h * spriteScale;
    const x0 = Math.round(p.sx - drawW / 2 + offX);
    const y0 = Math.round(p.sy - drawH + offY); // feet at the projected foot
    const src = layer.sprite.data;
    for (let oy = 0; oy < drawH; oy += 1) {
      const ty = Math.floor(oy / spriteScale);
      const py = y0 + oy;
      if (py < 0 || py >= size) continue;
      for (let ox = 0; ox < drawW; ox += 1) {
        const txRaw = Math.floor(ox / spriteScale);
        const tx = flip ? w - 1 - txRaw : txRaw; // mirror horizontally when facing left
        const si = (ty * w + tx) * 4;
        const a = src[si + 3]!;
        if (a === 0) continue;
        const px = x0 + ox;
        if (px < 0 || px >= size) continue;
        const di = py * size + px;
        if (p.camZ + 1e-3 < depth[di]!) continue; // world geometry in front — occluded
        const inv = 255 - a;
        const o = di * 4;
        data[o] = (src[si]! * a + data[o]! * inv) / 255;
        data[o + 1] = (src[si + 1]! * a + data[o + 1]! * inv) / 255;
        data[o + 2] = (src[si + 2]! * a + data[o + 2]! * inv) / 255;
        data[o + 3] = Math.max(data[o + 3]!, a);
      }
    }
  }
}
