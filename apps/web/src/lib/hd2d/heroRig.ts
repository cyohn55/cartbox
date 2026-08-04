// The HD-2D hero as a real CharacterRig (the rig model the editor's rig panel
// authors), replacing the earlier ad-hoc procedural layers. Each part is a
// depth-layered, richly-SHADED pixel-art image: a per-row cylindrical light gives
// the limbs and coat real form, a cool moon rim and warm lamp rim edge the
// silhouette, and the head carries a cyan augmented-eye glint — the REPLACED read.
//
// The parts + depths ARE a CharacterRig, so the same hero can later be opened and
// re-posed in the rig panel (or rebound to drawn cart sprites via SpriteRig); the
// scene consumes it through rigToLayers (character.ts) so it composites into the
// 3D world's shared z-buffer.

import type { CharacterRig, RigPart } from "@cartbox/editor";
import { makeCanvas, fillRect, fillEllipse, setPixel, isOpaque, shadeSilhouette, type PixelCanvas, type Rgb } from "./pixelArt";

const W = 32;
const H = 56;                       // feet at the bottom row, head near the top
const CX = 16;
const OPAQUE: Rgb = [1, 1, 1];      // placeholder; shadeSilhouette repaints interiors
const UNITS_PER_PIXEL = 0.06;

// REPLACED night palette for the figure.
const COAT_LIT: Rgb = [44, 56, 84], COAT_SHADOW: Rgb = [12, 16, 26];
const PANTS_LIT: Rgb = [30, 38, 58], PANTS_SHADOW: Rgb = [8, 10, 18];
const CAPE_LIT: Rgb = [26, 32, 52], CAPE_SHADOW: Rgb = [7, 9, 16];
const HOOD_LIT: Rgb = [40, 46, 66], HOOD_SHADOW: Rgb = [10, 12, 20];
const RIM_COOL: Rgb = [130, 200, 240], RIM_WARM: Rgb = [255, 150, 80];
const EYE: Rgb = [150, 240, 255];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function newImg(): PixelCanvas { return makeCanvas(W, H); }

/** A tapering opaque limb (arm/leg) — colour is filled later by shadeSilhouette. */
function limbSil(c: PixelCanvas, x0: number, y0: number, x1: number, y1: number, hw: number): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    fillEllipse(c, lerp(x0, x1, t), lerp(y0, y1, t), hw, hw, OPAQUE);
  }
}

/** An opaque vertical trapezoid (torso / coat / cape). */
function trapSil(c: PixelCanvas, cx: number, yTop: number, yBot: number, halfTop: number, halfBot: number): void {
  for (let y = yTop; y <= yBot; y += 1) {
    const t = (y - yTop) / Math.max(1, yBot - yTop);
    const half = lerp(halfTop, halfBot, t);
    fillRect(c, Math.round(cx - half), y, Math.round(half * 2), 1, OPAQUE);
  }
}

// ---- parts (authored facing right; feet at the bottom) ---------------------
function makeCape(): PixelCanvas {
  const c = newImg();
  trapSil(c, CX - 1, 18, 53, 8, 11); // a long coat-tail behind the torso, flaring wide
  shadeSilhouette(c, { lit: CAPE_LIT, shadow: CAPE_SHADOW, rimCool: RIM_COOL, rimWarm: RIM_WARM });
  return c;
}

function makeBackArm(): PixelCanvas {
  const c = newImg();
  limbSil(c, CX - 5, 18, CX - 7, 32, 3);
  shadeSilhouette(c, { lit: COAT_LIT, shadow: COAT_SHADOW, rimCool: RIM_COOL, rimWarm: RIM_WARM });
  return c;
}

function makeBackLeg(): PixelCanvas {
  const c = newImg();
  limbSil(c, CX - 3, 38, CX - 4, 55, 3);
  shadeSilhouette(c, { lit: PANTS_LIT, shadow: PANTS_SHADOW, rimCool: RIM_COOL, rimWarm: RIM_WARM });
  return c;
}

function makeTorso(): PixelCanvas {
  const c = newImg();
  trapSil(c, CX, 16, 46, 7, 10);        // coat body flaring to the hem
  fillRect(c, CX - 3, 13, 6, 4, OPAQUE); // shoulders/neck
  shadeSilhouette(c, { lit: COAT_LIT, shadow: COAT_SHADOW, rimCool: RIM_COOL, rimWarm: RIM_WARM });
  // A couple of darker vertical seams so the coat reads as folded cloth, not a slab.
  for (let y = 18; y < 46; y += 1) {
    for (const sx of [CX - 3, CX + 2]) if (isOpaque(c, sx, y)) {
      const i = (y * W + sx) * 4;
      c.data[i] = COAT_SHADOW[0]; c.data[i + 1] = COAT_SHADOW[1]; c.data[i + 2] = COAT_SHADOW[2];
    }
  }
  return c;
}

function makeHead(): PixelCanvas {
  const c = newImg();
  fillEllipse(c, CX, 9, 5, 5.5, OPAQUE);       // head
  fillEllipse(c, CX - 1, 5.5, 5.4, 3.6, OPAQUE); // hood/hair sweep on top
  shadeSilhouette(c, { lit: HOOD_LIT, shadow: HOOD_SHADOW, rimCool: RIM_COOL, rimWarm: RIM_WARM });
  // A cyan augmented eye on the leading (right) side of the face.
  setPixel(c, CX + 2, 9, EYE);
  setPixel(c, CX + 3, 9, EYE);
  setPixel(c, CX + 2, 10, [90, 170, 200]);
  return c;
}

function makeFrontLeg(): PixelCanvas {
  const c = newImg();
  limbSil(c, CX + 3, 38, CX + 4, 55, 3.2);
  shadeSilhouette(c, { lit: PANTS_LIT, shadow: PANTS_SHADOW, rimCool: RIM_COOL, rimWarm: RIM_WARM });
  return c;
}

function makeForeArm(): PixelCanvas {
  const c = newImg();
  limbSil(c, CX + 5, 18, CX + 7, 33, 3.2);
  fillRect(c, CX + 5, 30, 4, 12, OPAQUE); // a coat flap catching the front light
  shadeSilhouette(c, { lit: COAT_LIT, shadow: COAT_SHADOW, rimCool: RIM_COOL, rimWarm: RIM_WARM });
  return c;
}

function part(name: string, image: PixelCanvas, depthOffset: number): RigPart {
  return { name, image: image.data, imageWidth: W, imageHeight: H, depthOffset, offsetX: 0, offsetY: 0, unitsPerPixel: UNITS_PER_PIXEL };
}

/** The hero as a depth-layered rig (back-to-front by depthOffset; neg = nearer). */
export function buildHeroRig(): CharacterRig {
  return {
    pivotDepth: 10,
    parts: [
      part("cape", makeCape(), 6),
      part("backArm", makeBackArm(), 3),
      part("backLeg", makeBackLeg(), 2),
      part("torso", makeTorso(), 0),
      part("head", makeHead(), -1),
      part("frontLeg", makeFrontLeg(), -2),
      part("foreArm", makeForeArm(), -4),
    ],
  };
}
