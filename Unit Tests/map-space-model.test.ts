/**
 * Building the renderable window of the map's 3D view.
 *
 * Three things have to hold for the view to be both correct and affordable:
 * hidden faces are never drawn, a pick resolves back to the cell that produced
 * it, and the cost of a rebuild is bounded by the window rather than by how much
 * of the map has ever been built. The last one is why the map can be 640x360
 * cells and still redraw while you walk through it.
 *
 * Everything is asserted against the model's own derived structure — face masks
 * read through the real cube face table, sites read back through the real space —
 * rather than against literal indices, so the geometry tables can change without
 * these needing to.
 */

import { describe, expect, it } from "vitest";

import {
  CUBE_FACES,
  COLUMN_MATERIAL_NONE,
  HEXEL_GEOMETRY,
  MapVoxelSpace,
  isPlaneVoxel,
  mapSpaceToModel,
  planeFaceIndices,
  type MapVoxelCell,
} from "@cartbox/editor";

/** A palette that makes each index legible in the output as a distinct red level. */
const palette = (index: number): readonly [number, number, number] => [index * 10, 40, 90];

const solid = (colorIndex: number, material = COLUMN_MATERIAL_NONE): MapVoxelCell => ({
  colorIndex,
  material,
  kind: "solid",
});

/** The face bit of the cube face pointing along `normal`. */
function cubeFaceBit(normal: readonly [number, number, number]): number {
  const face = CUBE_FACES.find(
    (entry) => entry.normal[0] === normal[0] && entry.normal[1] === normal[1] && entry.normal[2] === normal[2],
  );
  if (!face) throw new Error(`no cube face with normal ${normal.join(",")}`);
  return face.bit;
}

/** Every rendered voxel that came from a given site, by its index in the model. */
function voxelsAt(
  model: ReturnType<typeof mapSpaceToModel>,
  space: MapVoxelSpace,
  x: number,
  y: number,
  z: number,
): number[] {
  const site = space.index(x, y, z);
  const found: number[] = [];
  for (let v = 0; v < model.count; v += 1) if (model.gridIndex[v] === site) found.push(v);
  return found;
}

const centred = (space: MapVoxelSpace, radius = 8) =>
  mapSpaceToModel(space, {
    palette,
    focus: { x: Math.floor(space.width / 2), y: 0, z: Math.floor(space.depth / 2) },
    radius,
  });

describe("mapSpaceToModel — what is drawn", () => {
  it("keeps a lone cell and gives it every face", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 0, 4, solid(3));

    const model = centred(space);

    expect(model.count).toBe(1);
    expect(model.faces[0]).toBe(CUBE_FACES.reduce((mask, face) => mask | face.bit, 0));
  });

  it("hides the face two touching cells share", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 0, 4, solid(3));
    space.set(5, 0, 4, solid(3));

    const model = centred(space);
    const [left] = voxelsAt(model, space, 4, 0, 4);
    const [right] = voxelsAt(model, space, 5, 0, 4);

    expect(model.faces[left!]! & cubeFaceBit([1, 0, 0])).toBe(0); // faces its neighbour
    expect(model.faces[right!]! & cubeFaceBit([-1, 0, 0])).toBe(0);
    expect(model.faces[left!]! & cubeFaceBit([-1, 0, 0])).not.toBe(0); // still open outward
  });

  it("drops a cell buried on every side — it can never be seen", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 1, 4, solid(3));
    for (const face of CUBE_FACES) {
      space.set(4 + face.normal[0], 1 + face.normal[1], 4 + face.normal[2], solid(1));
    }

    const model = centred(space);

    expect(voxelsAt(model, space, 4, 1, 4)).toHaveLength(0);
    expect(model.count).toBe(CUBE_FACES.length);
  });

  it("does not let a plane cover a solid's face — it does not fill its site", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 0, 4, solid(3));
    space.set(5, 0, 4, { colorIndex: 2, material: 4, kind: "planeX" });

    const model = centred(space);
    const [block] = voxelsAt(model, space, 4, 0, 4);

    expect(model.faces[block!]! & cubeFaceBit([1, 0, 0])).not.toBe(0);
  });

  it("skins a textured cell in white so its tile art shows as it was drawn", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 0, 4, solid(3, 6));
    space.set(4, 0, 5, solid(3));

    const model = centred(space);
    const [textured] = voxelsAt(model, space, 4, 0, 4);
    const [flat] = voxelsAt(model, space, 4, 0, 5);

    expect([model.r[textured!], model.g[textured!], model.b[textured!]]).toEqual([255, 255, 255]);
    expect(model.tile![textured!]).toBe(6);
    // A flat cell keeps its palette colour and asks for no tile at all.
    expect(model.r[flat!]).toBe(palette(3)[0]);
    expect(model.tile![flat!]).toBe(COLUMN_MATERIAL_NONE);
  });

  it("builds hexel cells from the rhombic face table, not the cube's", () => {
    const space = new MapVoxelSpace(9, 9, "hexel");
    space.set(4, 0, 4, solid(3)); // 4 + 0 + 4 is even, so a valid site

    const model = centred(space);

    expect(model.geometry).toBe(HEXEL_GEOMETRY);
    expect(model.faces[0]).toBe(HEXEL_GEOMETRY.faces.reduce((mask, face) => mask | face.bit, 0));
  });
});

describe("mapSpaceToModel — planes", () => {
  it("draws a plane as one quad across its own axis and nothing else", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 0, 4, { colorIndex: 2, material: 5, kind: "planeZ" });

    const model = centred(space);

    expect(model.count).toBe(1);
    expect(isPlaneVoxel(model, 0)).toBe(true);
    expect(model.plane![0]).toBe(2); // collapsed along z
    const [near, far] = planeFaceIndices(2);
    expect(model.faces[0]).toBe(CUBE_FACES[near]!.bit | CUBE_FACES[far]!.bit);
  });

  it("draws a cross as two perpendicular quads that both edit the one cell", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 0, 4, { colorIndex: 2, material: 5, kind: "cross" });

    const model = centred(space);
    const quads = voxelsAt(model, space, 4, 0, 4);

    expect(quads).toHaveLength(2);
    expect(quads.map((v) => model.plane![v]).sort()).toEqual([0, 2]);
    // Both carry the same site, so clicking either half resolves to one cell.
    expect(new Set(quads.map((v) => model.gridIndex[v])).size).toBe(1);
  });

  it("marks solid cells as not being planes", () => {
    const space = new MapVoxelSpace(9, 9);
    space.set(4, 0, 4, solid(3));

    const model = centred(space);

    expect(isPlaneVoxel(model, 0)).toBe(false);
  });
});

describe("mapSpaceToModel — the window", () => {
  it("builds only what is within the radius of the focus", () => {
    const space = new MapVoxelSpace(40, 40);
    space.set(20, 0, 20, solid(1)); // at the focus
    space.set(26, 0, 20, solid(2)); // outside a radius of 4

    const model = mapSpaceToModel(space, { palette, focus: { x: 20, y: 0, z: 20 }, radius: 4 });

    expect(voxelsAt(model, space, 20, 0, 20)).toHaveLength(1);
    expect(voxelsAt(model, space, 26, 0, 20)).toHaveLength(0);
  });

  it("still hides faces against neighbours outside the window", () => {
    // Otherwise the window's edge would read as a hollow shell with its inside
    // showing, rather than a clean slice through solid ground.
    const space = new MapVoxelSpace(40, 40);
    space.set(20, 0, 20, solid(1));
    space.set(21, 0, 20, solid(1));

    const model = mapSpaceToModel(space, { palette, focus: { x: 20, y: 0, z: 20 }, radius: 0 });
    const [edge] = voxelsAt(model, space, 20, 0, 20);

    expect(model.count).toBe(1); // the neighbour itself is out of the window
    expect(model.faces[edge!]! & cubeFaceBit([1, 0, 0])).toBe(0); // but still covers this face
  });

  it("centres on the focus, so the camera orbits where you are standing", () => {
    const space = new MapVoxelSpace(40, 40);
    space.set(20, 3, 20, solid(1));

    const model = mapSpaceToModel(space, { palette, focus: { x: 20, y: 3, z: 20 }, radius: 4 });

    expect([model.x[0], model.y[0], model.z[0]]).toEqual([0, 0, 0]);
    expect([model.originX, model.originY, model.originZ]).toEqual([20, 3, 20]);
  });

  it("scales with what is on screen, not with what the map holds", () => {
    const space = new MapVoxelSpace(120, 120);
    for (let z = 0; z < 120; z += 1) {
      for (let x = 0; x < 120; x += 1) space.set(x, 0, z, solid(1));
    }
    const radius = 5;

    const model = mapSpaceToModel(space, { palette, focus: { x: 60, y: 0, z: 60 }, radius });

    expect(space.cellCount).toBe(120 * 120);
    expect(model.count).toBe((radius * 2 + 1) ** 2);
  });
});

describe("mapSpaceToModel — picking back to a cell", () => {
  it("maps every rendered voxel to the site it was built from", () => {
    const space = new MapVoxelSpace(12, 12);
    const placed: [number, number, number][] = [
      [3, 0, 3],
      [4, 2, 7],
      [9, 5, 1],
    ];
    for (const [x, y, z] of placed) space.set(x, y, z, solid(2));

    const model = centred(space, 12);
    const resolved = Array.from({ length: model.count }, (_value, v) => space.coordsOf(model.gridIndex[v]!));

    for (const site of placed) {
      expect(resolved).toContainEqual(site);
    }
    expect(resolved.every((site) => space.isFilled(site[0], site[1], site[2]))).toBe(true);
  });
});
