// The layered-parallax character — the second half of the HD-2D spec. The figure
// is a 2D pixel-art sprite SPLIT INTO DEPTH LAYERS (back arm → back leg → body →
// front leg → front arm/coat). Each layer is placed at a slightly different world
// Z and projected through the SAME camera as the 3D world, then composited into the
// world's shared z-buffer. Because the layers sit at different depths, camera yaw
// slides them relative to one another (parallax "swing") — a flat sprite reads as
// having real volume — while the shared z-buffer makes world geometry occlude the
// character correctly.
//
// The projection here is byte-for-byte the one voxelModelRenderer/renderScene use
// (yaw about the vertical axis, then a fixed pitch, orthographic * cell), so the
// character lands exactly where the world thinks that world point is.

import { makeCanvas, fillRect, fillEllipse, isOpaque, setPixel, type PixelCanvas, type Rgb } from "./pixelArt";

/** The orthographic camera renderScene is driven with (see RenderSceneOptions). */
export interface Camera {
  readonly yaw: number;
  readonly pitch: number;
  /** Output pixels per world unit. */
  readonly cell: number;
  /** Square framebuffer edge, pixels. */
  readonly size: number;
  /** World point drawn at the screen centre. */
  readonly origin: readonly [number, number, number];
}

export interface Projected {
  /** Screen position of the world point, pixels. */
  readonly sx: number;
  readonly sy: number;
  /** Camera-space depth; larger = nearer the viewer (matches the world z-buffer). */
  readonly camZ: number;
}

/**
 * Project a world point to screen + depth exactly as renderScene does: translate
 * by the camera origin, yaw about the vertical axis, tip by the fixed pitch, then
 * orthographic scale by `cell` about the screen centre.
 */
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

// ---- character layers (pixel art, split by depth) --------------------------
/** Which body part a layer is, so the walk cycle can animate it. */
export type BodyPart = "backArm" | "backLeg" | "body" | "frontLeg" | "frontArm";

export interface CharacterLayer {
  readonly sprite: PixelCanvas;
  /** World-Z offset from the character's foot (>0 = toward the camera / nearer). */
  readonly dz: number;
  /** World-X offset from the foot centre. */
  readonly dx: number;
  readonly part: BodyPart;
}

/** Per-frame character animation state. */
export interface CharacterPose {
  /** +1 faces right (art's authored facing), -1 faces left (mirrored). */
  readonly facing: 1 | -1;
  /** Walk-cycle phase in radians; 0 = idle stance. */
  readonly walkPhase: number;
}

export const CHAR_W = 28;
export const CHAR_H = 48;
const BODY: Rgb = [12, 14, 22];
const COAT: Rgb = [26, 32, 50];
const RIM_COOL: Rgb = [130, 200, 240];
const RIM_WARM: Rgb = [255, 150, 80];

function newSprite(): PixelCanvas { return makeCanvas(CHAR_W, CHAR_H); }

/** A tapering vertical limb (arm/leg) from (x0,y0) to (x1,y1), half-width hw. */
function limb(c: PixelCanvas, x0: number, y0: number, x1: number, y1: number, hw: number, rgb: Rgb): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    fillEllipse(c, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, hw, hw, rgb);
  }
}

/** Recolour the 1px silhouette edge: left/top cool (moon rim), right warm (lamp). */
function rim(c: PixelCanvas): void {
  const snapshot = c.data.slice();
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < CHAR_W && y < CHAR_H && snapshot[(y * CHAR_W + x) * 4 + 3]! > 0;
  for (let y = 0; y < CHAR_H; y += 1) for (let x = 0; x < CHAR_W; x += 1) {
    if (!op(x, y)) continue;
    if (!op(x, y - 1) || !op(x - 1, y)) setPixel(c, x, y, RIM_COOL);
    else if (!op(x + 1, y)) setPixel(c, x, y, RIM_WARM);
  }
}

/** Build the five depth layers of the walking coat figure, back-to-front. */
export function buildCharacterLayers(): CharacterLayer[] {
  // Back arm — furthest from camera, drawn a touch left.
  const backArm = newSprite();
  limb(backArm, 9, 17, 7, 31, 2.2, BODY);
  rim(backArm);

  // Back leg.
  const backLeg = newSprite();
  limb(backLeg, 11, 38, 10, 47, 2.6, BODY);
  rim(backLeg);

  // Body: head + torso + long coat (the bulk of the silhouette).
  const body = newSprite();
  const cx = 14;
  // coat trapezoid: shoulders (y16, ±6) flaring to hem (y42, ±9)
  for (let y = 16; y <= 42; y += 1) {
    const t = (y - 16) / (42 - 16);
    const half = 6 + t * 3;
    fillRect(body, Math.round(cx - half), y, Math.round(half * 2), 1, y > 30 ? COAT : BODY);
  }
  fillRect(body, cx - 3, 12, 6, 5, BODY);           // neck/shoulders
  fillEllipse(body, cx, 8, 4.5, 5, BODY);            // head
  fillEllipse(body, cx - 1, 5, 5, 3.5, BODY);        // hair sweep
  rim(body);

  // Front leg.
  const frontLeg = newSprite();
  limb(frontLeg, 17, 38, 18, 47, 2.8, BODY);
  rim(frontLeg);

  // Front arm + coat flap — nearest the camera, drawn a touch right.
  const frontArm = newSprite();
  limb(frontArm, 19, 17, 21, 33, 2.6, BODY);
  fillRect(frontArm, 18, 30, 4, 12, COAT);           // a coat flap catching the front light
  rim(frontArm);

  return [
    { sprite: backArm, dz: -0.7, dx: -0.15, part: "backArm" },
    { sprite: backLeg, dz: -0.45, dx: -0.1, part: "backLeg" },
    { sprite: body, dz: 0.0, dx: 0.0, part: "body" },
    { sprite: frontLeg, dz: 0.45, dx: 0.1, part: "frontLeg" },
    { sprite: frontArm, dz: 0.7, dx: 0.15, part: "frontArm" },
  ];
}

/**
 * Screen-space offset (output px) a part gets at a walk phase: legs step (swing
 * horizontally and lift on their forward swing), arms counter-swing, and the torso
 * gives a small two-per-stride vertical bob. `flip` mirrors the horizontal swing so
 * a left-facing walk steps the right way.
 */
function partOffset(part: BodyPart, walkPhase: number, spriteScale: number, flip: boolean): [number, number] {
  const swing = Math.sin(walkPhase) * (flip ? -1 : 1);
  const s = spriteScale;
  switch (part) {
    case "frontLeg": return [swing * 2 * s, -Math.max(0, swing) * 3 * s];
    case "backLeg": return [-swing * 2 * s, -Math.max(0, -swing) * 3 * s];
    case "frontArm": return [-swing * 2 * s, 0];
    case "backArm": return [swing * 2 * s, 0];
    case "body": return [0, -Math.abs(Math.sin(walkPhase * 2)) * 1 * s];
    default: return [0, 0];
  }
}

/**
 * Composite the character's depth layers into an already-rendered world frame
 * (`data` RGBA + `depth` z-buffer, both size×size). Each layer projects its foot
 * through the camera and is blitted upright (bottom-centre at the projected foot),
 * scaled by `spriteScale` output px per texel. Layers are drawn back-to-front and
 * depth-tested per pixel against the world so solid geometry in front occludes them.
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
    // Mirror the depth-swing sideways when facing left so parallax reads correctly.
    const worldDx = layer.dx * pose.facing;
    const p = projectWorld(foot[0] + worldDx, foot[1], foot[2] + layer.dz, camera);
    const [offX, offY] = partOffset(layer.part, pose.walkPhase, spriteScale, flip);
    const drawW = CHAR_W * spriteScale;
    const drawH = CHAR_H * spriteScale;
    const x0 = Math.round(p.sx - drawW / 2 + offX);
    const y0 = Math.round(p.sy - drawH + offY); // bottom edge (feet) at the projected foot
    const src = layer.sprite.data;
    for (let oy = 0; oy < drawH; oy += 1) {
      const ty = Math.floor(oy / spriteScale);
      const py = y0 + oy;
      if (py < 0 || py >= size) continue;
      for (let ox = 0; ox < drawW; ox += 1) {
        const txRaw = Math.floor(ox / spriteScale);
        const tx = flip ? CHAR_W - 1 - txRaw : txRaw; // mirror horizontally when facing left
        const si = (ty * CHAR_W + tx) * 4;
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
