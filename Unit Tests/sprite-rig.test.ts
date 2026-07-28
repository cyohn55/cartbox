/**
 * Sprite-rig tests. They drive the real SpriteSheet over a real StubCartEngine,
 * painting tiles through the sheet and asserting on the RGBA blocks and planes
 * the rig produces — colour-key transparency, depth placement, and painter
 * occlusion through the real compositor. Expectations derive from the painted
 * inputs and the rig's depths, never from baked pixel constants.
 */

import { describe, expect, it } from "vitest";
import {
  StubCartEngine,
  SpriteSheet,
  readBlockRgba,
  spriteRigToPlanes,
  emptySpriteRig,
  upsertRigPart,
  removeRigPart,
  renderLayeredScene,
  RIG_PART_TEMPLATES,
  DEFAULT_RIG_UNITS_PER_PIXEL,
  type SpriteRigPart,
  type Camera,
} from "@cartbox/editor";

const OPAQUE_COLOR = 5;
const COLOR_KEY = 0;

/** A fresh sheet with tile `tile` painted: colour-key border, opaque centre. */
function paintedSheet(tile: number): SpriteSheet {
  const sheet = new SpriteSheet(new StubCartEngine());
  const edge = sheet.tileSize;
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const isBorder = x === 0 || y === 0 || x === edge - 1 || y === edge - 1;
      sheet.setPixel(0, tile, x, y, isBorder ? COLOR_KEY : OPAQUE_COLOR);
    }
  }
  return sheet;
}

function part(overrides: Partial<SpriteRigPart>): SpriteRigPart {
  return {
    name: "torso",
    page: 0,
    baseTile: 1,
    blockTiles: 1,
    depthOffset: 0,
    offsetX: 0,
    offsetY: 0,
    unitsPerPixel: DEFAULT_RIG_UNITS_PER_PIXEL,
    ...overrides,
  };
}

describe("readBlockRgba", () => {
  it("maps the colour key to transparent and keeps painted pixels opaque", () => {
    const sheet = paintedSheet(1);
    const edge = sheet.tileSize;
    const block = readBlockRgba(sheet, 0, 1, 1, COLOR_KEY);

    expect(block.dim).toBe(edge);
    // A border pixel (colour key) is transparent; a centre pixel is opaque.
    const cornerAlpha = block.data[3];
    const centre = (Math.floor(edge / 2) * edge + Math.floor(edge / 2)) * 4;
    expect(cornerAlpha).toBe(0);
    expect(block.data[centre + 3]).toBe(255);
  });

  it("sizes the block by tiles-per-side", () => {
    const sheet = paintedSheet(1);
    expect(readBlockRgba(sheet, 0, 1, 2, COLOR_KEY).dim).toBe(sheet.tileSize * 2);
  });
});

describe("spriteRigToPlanes", () => {
  it("places each part at pivotDepth + its depth offset with the block image", () => {
    const sheet = paintedSheet(1);
    const rig = {
      pivotDepth: 12,
      colorKey: COLOR_KEY,
      parts: [part({ name: "head", depthOffset: -1 }), part({ name: "cape", depthOffset: 6 })],
    };
    const planes = spriteRigToPlanes(sheet, rig, 2, -3);

    expect(planes).toHaveLength(2);
    rig.parts.forEach((rigPart, index) => {
      const plane = planes[index]!;
      expect(plane.depth).toBe(12 + rigPart.depthOffset);
      expect(plane.imageWidth).toBe(sheet.tileSize * rigPart.blockTiles);
      expect(plane.x).toBe(2 + rigPart.offsetX);
      expect(plane.y).toBe(-3 + rigPart.offsetY);
    });
  });

  it("feeds the compositor so a nearer part occludes a farther one", () => {
    // Two solid parts on different tiles: red far, blue near, both centred.
    const sheet = new SpriteSheet(new StubCartEngine());
    const redIndex = sheet.nearestColorIndex(255, 0, 0);
    const blueIndex = sheet.nearestColorIndex(0, 0, 255);
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) {
        sheet.setPixel(0, 1, x, y, redIndex);
        sheet.setPixel(0, 2, x, y, blueIndex);
      }
    }
    const rig = {
      pivotDepth: 10,
      colorKey: COLOR_KEY,
      parts: [
        part({ name: "cape", baseTile: 1, depthOffset: 6 }), // far, red
        part({ name: "foreArm", baseTile: 2, depthOffset: -4 }), // near, blue
      ],
    };
    const camera: Camera = {
      panX: 0,
      panY: 0,
      yaw: 0,
      pivotX: 0,
      pivotDepth: 10,
      focalLength: 200,
      viewportWidth: 64,
      viewportHeight: 64,
    };
    const frame = renderLayeredScene(spriteRigToPlanes(sheet, rig), camera);
    const centre = (32 * frame.width + 32) * 4;
    const [pr, pg, pb] = [frame.data[centre], frame.data[centre + 1], frame.data[centre + 2]];
    // The near (blue) part must win at the centre: blue dominates red.
    expect(pb!).toBeGreaterThan(pr!);
    expect(pb!).toBeGreaterThan(pg!);
  });
});

describe("rig editing helpers", () => {
  it("adds, replaces (by name), and orders parts by the template", () => {
    let rig = emptySpriteRig();
    rig = upsertRigPart(rig, part({ name: "foreArm", depthOffset: -4 }));
    rig = upsertRigPart(rig, part({ name: "cape", depthOffset: 6 }));
    // Template order is cape before foreArm regardless of insertion order.
    expect(rig.parts.map((p) => p.name)).toEqual(["cape", "foreArm"]);

    // Reassigning "foreArm" replaces it rather than duplicating.
    rig = upsertRigPart(rig, part({ name: "foreArm", baseTile: 9, depthOffset: -2 }));
    expect(rig.parts.filter((p) => p.name === "foreArm")).toHaveLength(1);
    expect(rig.parts.find((p) => p.name === "foreArm")!.baseTile).toBe(9);
  });

  it("removes a part by name", () => {
    let rig = emptySpriteRig();
    rig = upsertRigPart(rig, part({ name: "torso" }));
    rig = removeRigPart(rig, "torso");
    expect(rig.parts).toHaveLength(0);
  });

  it("ships a non-empty standard template set", () => {
    expect(RIG_PART_TEMPLATES.length).toBeGreaterThan(0);
    expect(RIG_PART_TEMPLATES.map((t) => t.name)).toContain("torso");
  });
});
