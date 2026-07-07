/**
 * Segmented-character rig — the data model for multi-plane sprite layering. A
 * character is broken into named parts (back arm, cape, torso, head, fore arm),
 * each given its own depth relative to a shared pivot. Feeding those parts to
 * the layered-scene compositor makes the parts shift by their depth when the
 * camera pans or the character yaws: the fore arm swings faster than the torso,
 * the cape drifts slower, and a flat sprite reads as having volume.
 *
 * The rig is pure data plus a builder; it owns depth and layout, while the
 * compositor owns projection. That split keeps rigs testable without a camera
 * and lets the same parts feed the CPU preview or a future GPU path.
 */

import type { ScenePlane } from "../render/layeredScene";

/** One layer of a character: an image placed at a depth offset from the pivot. */
export interface RigPart {
  /** Human-readable id (e.g. "foreArm"); also used to look a part up. */
  readonly name: string;
  /** RGBA pixels, row-major, length imageWidth * imageHeight * 4. */
  readonly image: Uint8ClampedArray;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Depth relative to the rig pivot: negative = toward camera (foreground). */
  readonly depthOffset: number;
  /** Anchor offset from the rig origin, world units. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** World units per source pixel — the part's on-screen size. */
  readonly unitsPerPixel: number;
}

/** A character as a set of depth-layered parts around a pivot depth. */
export interface CharacterRig {
  readonly parts: readonly RigPart[];
  /** Depth of the pivot from the camera; parts sit at pivotDepth + depthOffset. */
  readonly pivotDepth: number;
}

/** Place a rig at a scene origin, yielding one compositor plane per part. */
export function buildRigPlanes(rig: CharacterRig, originX = 0, originY = 0): ScenePlane[] {
  return rig.parts.map((part) => ({
    image: part.image,
    imageWidth: part.imageWidth,
    imageHeight: part.imageHeight,
    x: originX + part.offsetX,
    y: originY + part.offsetY,
    depth: rig.pivotDepth + part.depthOffset,
    unitsPerPixel: part.unitsPerPixel,
  }));
}

/** Find a part by name, or undefined when the rig has no such part. */
export function findRigPart(rig: CharacterRig, name: string): RigPart | undefined {
  return rig.parts.find((part) => part.name === name);
}

/** Paint a solid RGBA rectangle centred in a transparent image of imageSize². */
function paintPartImage(size: number, box: PartBox, color: PartColor): Uint8ClampedArray {
  const image = new Uint8ClampedArray(size * size * 4);
  const left = Math.round((size - box.width) / 2 + box.shiftX);
  const top = Math.round((size - box.height) / 2 + box.shiftY);
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const px = left + x;
      const py = top + y;
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      const index = (py * size + px) * 4;
      image[index] = color.red;
      image[index + 1] = color.green;
      image[index + 2] = color.blue;
      image[index + 3] = 255;
    }
  }
  return image;
}

interface PartBox {
  readonly width: number;
  readonly height: number;
  readonly shiftX: number;
  readonly shiftY: number;
}

interface PartColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** Config for one demo part: its shape, colour, and depth relative to the pivot. */
interface DemoPartSpec {
  readonly name: string;
  readonly box: PartBox;
  readonly color: PartColor;
  readonly depthOffset: number;
}

const DEMO_PART_SIZE = 32;
const DEMO_UNITS_PER_PIXEL = 0.06;

/**
 * Parts ordered back-to-front by depth: the cape sits farthest behind the pivot
 * and the fore arm nearest the camera, so a yaw swings them in opposite
 * directions. Shapes are offset boxes so each layer is visually distinct.
 */
const DEMO_PART_SPECS: readonly DemoPartSpec[] = [
  {
    name: "cape",
    box: { width: 22, height: 26, shiftX: 0, shiftY: 2 },
    color: { red: 122, green: 49, blue: 122 },
    depthOffset: 6,
  },
  {
    name: "backArm",
    box: { width: 7, height: 18, shiftX: 9, shiftY: 1 },
    color: { red: 60, green: 92, blue: 160 },
    depthOffset: 3,
  },
  {
    name: "torso",
    box: { width: 16, height: 20, shiftX: 0, shiftY: 3 },
    color: { red: 56, green: 183, blue: 100 },
    depthOffset: 0,
  },
  {
    name: "head",
    box: { width: 12, height: 12, shiftX: 0, shiftY: -8 },
    color: { red: 255, green: 205, blue: 117 },
    depthOffset: -1,
  },
  {
    name: "foreArm",
    box: { width: 7, height: 18, shiftX: -9, shiftY: 1 },
    color: { red: 239, green: 125, blue: 87 },
    depthOffset: -4,
  },
];

/**
 * A self-contained demo character with five depth-layered parts, painted
 * procedurally so it needs no external assets. Handy as a preview default and
 * as fixed input for tests.
 */
export function demoCharacterRig(pivotDepth = 10): CharacterRig {
  const parts = DEMO_PART_SPECS.map((spec) => ({
    name: spec.name,
    image: paintPartImage(DEMO_PART_SIZE, spec.box, spec.color),
    imageWidth: DEMO_PART_SIZE,
    imageHeight: DEMO_PART_SIZE,
    depthOffset: spec.depthOffset,
    offsetX: 0,
    offsetY: 0,
    unitsPerPixel: DEMO_UNITS_PER_PIXEL,
  }));
  return { parts, pivotDepth };
}

export { type PartBox, type PartColor };
