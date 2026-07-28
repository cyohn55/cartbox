/**
 * Standing inside the map: the first-person renderer.
 *
 * This is the view you build from in walk mode, so what it draws and what it
 * reports have to agree exactly — a crosshair that names a different cell from
 * the one you can see would make the tools unusable. These drive the real
 * renderer and assert on real output pixels:
 *
 * - a surface is where the geometry says it is, at the distance it should be;
 * - the face reported is the one turned toward the viewer, so building against
 *   it grows outward;
 * - the face-local coordinates name the texel actually drawn there, which is
 *   what lets the pixel tools paint what you are looking at;
 * - a transparent texel is not a surface, which is the whole reason a grass
 *   plane reads as grass rather than as a rectangle.
 */

import { describe, expect, it } from "vitest";

import {
  CUBE_FACES,
  HEXEL_GEOMETRY,
  MapVoxelSpace,
  castMapRay,
  cellContaining,
  firstPersonBasis,
  geometryFor,
  renderMapFirstPerson,
  walkAxes,
  type FaceTexture,
  type MapCellKind,
  type ModelLight,
  type TextureAtlas,
} from "@cartbox/editor";

const RES = 41; // odd, so there is an exact centre pixel to read the crosshair from
const CENTRE = (RES >> 1) * RES + (RES >> 1);

/** Fully ambient: shade is exactly 1, so a drawn texel equals its source texel. */
const FLAT_LIGHT: ModelLight = { direction: [0, 1, 0], color: [1, 1, 1], intensity: 0, ambient: 1 };

const palette = (index: number): readonly [number, number, number] => [index * 20, 30, 60];

const solid = (colorIndex: number, material = -1) => ({ colorIndex, material, kind: "solid" as MapCellKind });

/** A tile whose every texel is a different, identifiable colour. */
function identifiableTile(size: number): FaceTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let ty = 0; ty < size; ty += 1) {
    for (let tx = 0; tx < size; tx += 1) {
      const base = (ty * size + tx) * 4;
      data[base] = tx * 50 + 20;
      data[base + 1] = ty * 50 + 20;
      data[base + 2] = 180;
      data[base + 3] = 255;
    }
  }
  return { size, data };
}

/** A tile that is solid on its left half and fully transparent on its right. */
function halfTransparentTile(size: number): FaceTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let ty = 0; ty < size; ty += 1) {
    for (let tx = 0; tx < size * 0.5; tx += 1) {
      const base = (ty * size + tx) * 4;
      data[base] = 220;
      data[base + 1] = 60;
      data[base + 2] = 60;
      data[base + 3] = 255;
    }
  }
  return { size, data };
}

/** A tile that is opaque everywhere, for standing behind a see-through one. */
function opaqueTile(size: number): FaceTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = 40;
    data[i * 4 + 1] = 210;
    data[i * 4 + 2] = 90;
    data[i * 4 + 3] = 255;
  }
  return { size, data };
}

/**
 * Material 0 is the tile given; material 1 is always opaque. Two materials
 * because "the ray carried on through a hole" can only be shown by something
 * behind the hole that is itself solid.
 */
const tileAtlas = (tile: FaceTexture): TextureAtlas => ({
  tiles: [tile, opaqueTile(4)],
  materials: [
    { top: 0, side: 0, bottom: 0 },
    { top: 1, side: 1, bottom: 1 },
  ],
});

function makeBuffers() {
  return {
    out: new Uint8ClampedArray(RES * RES * 4),
    pickSite: new Int32Array(RES * RES),
    pickFace: new Int8Array(RES * RES),
    pickU: new Float32Array(RES * RES),
    pickV: new Float32Array(RES * RES),
    pickDistance: new Float32Array(RES * RES),
  };
}

/** Look from `eye` along `yaw`/`pitch` at a space, and hand back the buffers. */
function look(
  space: MapVoxelSpace,
  eye: readonly [number, number, number],
  yaw = 0,
  pitch = 0,
  atlas?: TextureAtlas,
) {
  const buffers = makeBuffers();
  renderMapFirstPerson(space, {
    camera: { eye, yaw, pitch, fov: 1.2 },
    palette,
    atlas,
    light: FLAT_LIGHT,
    width: RES,
    height: RES,
    maxDistance: 48,
    out: buffers.out,
    ...buffers,
  });
  return buffers;
}

/** Every pixel that struck something. */
function struckPixels(buffers: ReturnType<typeof makeBuffers>): number[] {
  const found: number[] = [];
  for (let i = 0; i < buffers.pickSite.length; i += 1) if (buffers.pickSite[i]! >= 0) found.push(i);
  return found;
}

describe("cellContaining — which cell a point is in", () => {
  it("rounds to the nearest site on a cube lattice", () => {
    const cube = geometryFor("cube");

    expect(cellContaining(cube, 0.2, -0.4, 3.6)).toEqual([0, 0, 4]);
    expect(cellContaining(cube, 2.5, 2.5, 2.5)).toEqual([3, 3, 3]);
  });

  it("only ever names a valid site on a hexel lattice", () => {
    // Every point in space belongs to exactly one hexel, so this must never
    // return an off-lattice site however the point is placed.
    for (let i = 0; i < 200; i += 1) {
      const x = (i * 0.37) % 9;
      const y = (i * 0.71) % 9;
      const z = (i * 1.13) % 9;
      const [sx, sy, sz] = cellContaining(HEXEL_GEOMETRY, x, y, z);
      expect((((sx + sy + sz) % 2) + 2) % 2).toBe(0);
    }
  });

  it("picks the nearest valid hexel site, not merely a valid one", () => {
    // (1.4, 0.1, 0.1) rounds to the off-lattice (1,0,0); the nearest even-sum
    // site is (2,0,0), reached by moving the axis that was rounded furthest.
    expect(cellContaining(HEXEL_GEOMETRY, 1.4, 0.1, 0.1)).toEqual([2, 0, 0]);
  });
});

describe("which way the frame faces", () => {
  /**
   * A mirrored frame is the failure this whole block exists to catch. It draws
   * plausible pictures, strikes exactly the cells an unmirrored one strikes, and
   * only shows itself as a view that swings left when the mouse goes right — so
   * every assertion here is about *where on screen* something lands, never about
   * what was hit.
   */
  it("builds a right-handed frame, not a mirror of one", () => {
    for (const yaw of [0, 0.7, Math.PI / 2, Math.PI, -1.3]) {
      for (const pitch of [0, 0.4, -0.6]) {
        const { forward, right, up } = firstPersonBasis(yaw, pitch);
        // right x up must point back out of the screen, i.e. against forward.
        const cross: [number, number, number] = [
          right[1] * up[2] - right[2] * up[1],
          right[2] * up[0] - right[0] * up[2],
          right[0] * up[1] - right[1] * up[0],
        ];
        const alongForward = cross[0] * forward[0] + cross[1] * forward[1] + cross[2] * forward[2];
        expect(alongForward).toBeCloseTo(-1, 6);
        expect(up[1]).toBeGreaterThan(0); // and upright, not flipped
      }
    }
  });

  it("draws what is east of you on the right when you face north", () => {
    // The map's world is x east, z south, y up. Facing north (-z) is yaw = pi,
    // and a landmark to the east must therefore be drawn to the right.
    const space = new MapVoxelSpace(30, 30);
    for (let y = 0; y <= 4; y += 1) space.set(13, y, 2, solid(3));

    const buffers = look(space, [10, 2, 10], Math.PI, 0);
    const struck = struckPixels(buffers);
    expect(struck.length).toBeGreaterThan(0);

    for (const pixel of struck) expect(pixel % RES).toBeGreaterThan(RES >> 1);
  });

  it("draws what is above you above, not below", () => {
    const space = new MapVoxelSpace(30, 30);
    space.set(10, 8, 14, solid(3));

    const buffers = look(space, [10, 2, 10], 0, 0.5);
    const struck = struckPixels(buffers);
    expect(struck.length).toBeGreaterThan(0);

    for (const pixel of struck) expect(Math.floor(pixel / RES)).toBeLessThan(RES >> 1);
  });

  it("agrees with the orbit camera about which way right is", () => {
    // The orbit renderer projects screen x as `wx*cos(theta) + wz*sin(theta)`, so
    // the world direction it draws to the right is (cos theta, 0, sin theta). The
    // two headings are related by walk = pi - theta; if the walking basis did not
    // land on the same vector, stepping between the cameras would mirror the view.
    for (const orbitYaw of [0, 0.7, 1.9, -2.2]) {
      const { right } = walkAxes(Math.PI - orbitYaw);
      expect(right[0]).toBeCloseTo(Math.cos(orbitYaw), 10);
      expect(right[1]).toBeCloseTo(Math.sin(orbitYaw), 10);
    }
  });

  it("turns the way the mouse does: less yaw looks further right", () => {
    // Mouse-look subtracts from yaw as the pointer moves right, so a landmark
    // that sits on the right of the frame must move *toward* the centre when yaw
    // is reduced — the view swinging to meet it.
    const space = new MapVoxelSpace(30, 30);
    for (let y = 0; y <= 4; y += 1) space.set(13, y, 2, solid(3));

    const columnOf = (yaw: number) => {
      const struck = struckPixels(look(space, [10, 2, 10], yaw, 0));
      return struck.reduce((sum, pixel) => sum + (pixel % RES), 0) / struck.length;
    };

    expect(columnOf(Math.PI - 0.25)).toBeLessThan(columnOf(Math.PI));
  });

  it("strafes toward the side of the frame it draws", () => {
    // Pressing D must carry you toward what is drawn on the right; the two used
    // to be derived separately and disagreed by a sign.
    for (const yaw of [0, 0.9, Math.PI, -1.4]) {
      const { right } = firstPersonBasis(yaw, 0);
      const axes = walkAxes(yaw);
      expect(axes.right[0]).toBeCloseTo(right[0], 10);
      expect(axes.right[1]).toBeCloseTo(right[2], 10);
      expect(axes.forward[0]).toBeCloseTo(Math.sin(yaw), 10);
      expect(axes.forward[1]).toBeCloseTo(Math.cos(yaw), 10);
    }
  });
});

describe("casting a single ray", () => {
  it("reports the same cell the centre pixel of a frame does", () => {
    // The GPU path draws the image and asks this for the crosshair, so the two
    // answers have to be one answer.
    const space = new MapVoxelSpace(20, 20);
    for (let x = 8; x <= 12; x += 1) {
      for (let z = 12; z <= 16; z += 1) space.set(x, 2, z, solid(4));
    }
    const eye: [number, number, number] = [10, 4, 10];
    const yaw = 0.3;
    const pitch = -0.35;

    const buffers = look(space, eye, yaw, pitch);
    const hit = castMapRay(space, eye, firstPersonBasis(yaw, pitch).forward, { maxDistance: 48 });

    expect(hit).not.toBeNull();
    expect(space.index(hit!.x, hit!.y, hit!.z)).toBe(buffers.pickSite[CENTRE]);
    expect(hit!.face).toBe(buffers.pickFace[CENTRE]);
    expect(hit!.u).toBeCloseTo(buffers.pickU[CENTRE]!, 5);
    expect(hit!.v).toBeCloseTo(buffers.pickV[CENTRE]!, 5);
  });

  it("looks out of the terrain when the eye is buried in it", () => {
    // Free flight lets you fly into the ground. What is drawn there is the world
    // outside — only exposed faces are ever meshed — so a pick must agree and
    // report the surface you can see rather than an interior face nobody drew.
    const space = new MapVoxelSpace(24, 24);
    for (let x = 4; x <= 20; x += 1) {
      for (let z = 4; z <= 20; z += 1) {
        for (let y = 0; y <= 6; y += 1) space.set(x, y, z, solid(2));
      }
    }
    space.set(12, 3, 12, solid(2)); // the eye sits inside this one

    // Looking up: the surface struck is the underside of the crust, not the
    // interior face of the cell immediately overhead.
    const up = castMapRay(space, [12, 3, 12], [0, 1, 0]);
    expect(up).not.toBeNull();
    expect(up!.y).toBe(6);
    expect(space.isFilled(up!.x, up!.y + 1, up!.z)).toBe(false);

    // Looking sideways: the same rule carries the ray out to the far wall.
    const across = castMapRay(space, [12, 3, 12], [1, 0, 0]);
    expect(across).not.toBeNull();
    expect(across!.x).toBe(20);
    expect(space.isFilled(across!.x + 1, across!.y, across!.z)).toBe(false);
  });

  it("finds the map from a start well outside it", () => {
    // How an orthographic pick works: every ray of that camera begins on a plane
    // behind the entire scene, which is nowhere near the map. Marching from there
    // used to stop on the first step for being out of bounds, so orbiting could
    // never pick anything at all.
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 3, 10, solid(5));

    const hit = castMapRay(space, [10, 90, 10], [0, -1, 0], { maxDistance: 200 });

    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z]).toEqual([10, 3, 10]);
    // Distance is measured from where the caller said the ray started.
    expect(hit!.distance).toBeCloseTo(90 - 3.5, 5);
  });

  it("reports nothing for a ray aimed past the map entirely", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 3, 10, solid(5));

    expect(castMapRay(space, [10, 90, 10], [0, 1, 0], { maxDistance: 200 })).toBeNull();
    expect(castMapRay(space, [-40, 3, 10], [0, 0, 1], { maxDistance: 200 })).toBeNull();
  });

  it("gives up before reaching a map further away than the limit allows", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 3, 10, solid(5));

    expect(castMapRay(space, [10, 90, 10], [0, -1, 0], { maxDistance: 20 })).toBeNull();
  });

  it("reports nothing for a ray that leaves the map", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, solid(3));

    expect(castMapRay(space, [10, 2, 10], [0, 1, 0])).toBeNull();
    expect(castMapRay(space, [10, 2, 10], [0, 0, 0])).toBeNull(); // degenerate
  });

  it("sees through a transparent texel exactly as the frame does", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 13, solid(1, 0)); // half see-through
    space.set(10, 2, 16, solid(5, 1)); // opaque, behind the hole
    const atlas = tileAtlas(halfTransparentTile(8));

    // Fan across the near tile: half of it is a hole, so some of these rays must
    // stop at it and some must carry through to what stands behind it — the same
    // two outcomes the drawn frame shows side by side.
    const struck = [-0.08, -0.03, 0.03, 0.08].map((offset) =>
      castMapRay(space, [10, 2, 10], [offset, 0, 1], { atlas }),
    );
    const reached = new Set(struck.map((hit) => (hit ? `${hit.x},${hit.y},${hit.z}` : "sky")));

    expect(reached.has("10,2,13")).toBe(true);
    expect(reached.has("10,2,16")).toBe(true);
  });
});

describe("what a ray strikes", () => {
  it("reports the cell straight ahead, and nothing where the map is empty", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, solid(3));

    const buffers = look(space, [10, 2, 10]);

    expect(buffers.pickSite[CENTRE]).toBe(space.index(10, 2, 14));
    expect(buffers.pickSite[0]).toBe(-1); // a corner ray escapes into the sky
  });

  it("measures the distance to what it struck", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, solid(3));

    const buffers = look(space, [10, 2, 10]);

    // The near face of a cell centred at z = 14 stands half a cell in front of it.
    expect(buffers.pickDistance[CENTRE]).toBeCloseTo(3.5, 5);
  });

  it("strikes the nearer of two cells in line", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 13, solid(1));
    space.set(10, 2, 16, solid(2));

    const buffers = look(space, [10, 2, 10]);

    expect(buffers.pickSite[CENTRE]).toBe(space.index(10, 2, 13));
  });

  it("stops at the edge of the map rather than marching forever", () => {
    const space = new MapVoxelSpace(20, 20);

    const buffers = look(space, [10, 2, 10]);

    expect(struckPixels(buffers)).toHaveLength(0);
  });

  it("always reports a face turned toward the viewer", () => {
    // This is what makes building against a face grow outward: the neighbour
    // across the struck face is the open side.
    const space = new MapVoxelSpace(20, 20);
    for (let x = 8; x <= 12; x += 1) {
      for (let z = 12; z <= 16; z += 1) space.set(x, 2, z, solid(4));
    }

    const buffers = look(space, [10, 4, 10], 0, -0.3);
    const struck = struckPixels(buffers);
    expect(struck.length).toBeGreaterThan(0);

    for (const pixel of struck) {
      const [x, y, z] = space.coordsOf(buffers.pickSite[pixel]!);
      const [dx, dy, dz] = CUBE_FACES[buffers.pickFace[pixel]!]!.normal;
      // The cell across the struck face is empty, or the face would be hidden.
      expect(space.isFilled(x + dx, y + dy, z + dz)).toBe(false);
    }
  });
});

describe("what a ray draws", () => {
  it("shows a flat cell in its palette colour", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, solid(3));

    const buffers = look(space, [10, 2, 10]);
    const expected = palette(3);

    expect([buffers.out[CENTRE * 4], buffers.out[CENTRE * 4 + 1], buffers.out[CENTRE * 4 + 2]]).toEqual([
      ...expected,
    ]);
  });

  it("names the exact texel it drew at every pixel", () => {
    const tile = identifiableTile(4);
    const space = new MapVoxelSpace(20, 20);
    for (let x = 8; x <= 12; x += 1) {
      for (let y = 0; y <= 4; y += 1) space.set(x, y, 14, solid(3, 0));
    }

    const buffers = look(space, [10, 2, 10], 0, 0, tileAtlas(tile));
    const struck = struckPixels(buffers);
    expect(struck.length).toBeGreaterThan(0);

    for (const pixel of struck) {
      const tx = Math.min(tile.size - 1, Math.floor(buffers.pickU[pixel]! * tile.size));
      const ty = Math.min(tile.size - 1, Math.floor(buffers.pickV[pixel]! * tile.size));
      const source = (ty * tile.size + tx) * 4;
      expect([buffers.out[pixel * 4], buffers.out[pixel * 4 + 1], buffers.out[pixel * 4 + 2]]).toEqual([
        tile.data[source],
        tile.data[source + 1],
        tile.data[source + 2],
      ]);
    }
  });

  it("sees through a transparent texel to whatever is behind it", () => {
    // The property grass depends on: a hole in a sprite is a hole in the world.
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 13, solid(1, 0)); // the half-transparent sprite
    space.set(10, 2, 16, solid(5, 1)); // opaque, so it can be seen through the hole

    const buffers = look(space, [10, 2, 10], 0, 0, tileAtlas(halfTransparentTile(8)));
    const sites = new Set(struckPixels(buffers).map((pixel) => buffers.pickSite[pixel]!));

    // Both cells are visible at once: the near one through its solid half, the
    // far one through the near one's transparent half.
    expect(sites.has(space.index(10, 2, 13))).toBe(true);
    expect(sites.has(space.index(10, 2, 16))).toBe(true);
  });

  it("lights each face by its own normal, so a cell reads as a solid block", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, solid(6));
    const lit: ModelLight = { direction: [0, 1, 0], color: [1, 1, 1], intensity: 1, ambient: 0.2 };

    const buffers = makeBuffers();
    renderMapFirstPerson(space, {
      camera: { eye: [10, 5, 10], yaw: 0, pitch: -0.55, fov: 1.2 },
      palette,
      light: lit,
      width: RES,
      height: RES,
      out: buffers.out,
      ...buffers,
    });

    const brightness = new Map<number, number>();
    for (const pixel of struckPixels(buffers)) {
      brightness.set(buffers.pickFace[pixel]!, buffers.out[pixel * 4 + 2]!);
    }
    const top = CUBE_FACES.findIndex((face) => face.normal[1] === 1);
    const side = CUBE_FACES.findIndex((face) => face.normal[2] === -1);

    // Looking down at a lit cell, the top face must come out brighter than the
    // side turned toward the viewer.
    expect(brightness.get(top)!).toBeGreaterThan(brightness.get(side)!);
  });
});

describe("planes seen from inside the map", () => {
  it("draws a plane standing across the axis it names", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, { colorIndex: 4, material: 0, kind: "planeZ" });

    const buffers = look(space, [10, 2, 10], 0, 0, tileAtlas(identifiableTile(4)));

    expect(buffers.pickSite[CENTRE]).toBe(space.index(10, 2, 14));
    expect(buffers.pickDistance[CENTRE]).toBeCloseTo(4, 5); // the quad is at the cell's middle
  });

  it("is invisible edge-on, having no thickness", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, { colorIndex: 4, material: 0, kind: "planeX" });

    const buffers = look(space, [10, 2, 10], 0, 0, tileAtlas(identifiableTile(4)));

    expect(struckPixels(buffers)).toHaveLength(0);
  });

  it("shows both halves of a cross, whichever way you face it", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 14, { colorIndex: 4, material: 0, kind: "cross" });

    // Stand off in each direction and look back at the cell, so every angle is
    // genuinely facing it — a cross has to read from all of them.
    const distance = 4;
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const eye: [number, number, number] = [
        10 - Math.sin(yaw) * distance,
        2,
        14 - Math.cos(yaw) * distance,
      ];
      const buffers = look(space, eye, yaw, 0, tileAtlas(identifiableTile(4)));
      expect(struckPixels(buffers).length).toBeGreaterThan(0);
    }
  });

  it("does not hide what stands behind it", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 2, 13, { colorIndex: 4, material: 0, kind: "planeZ" });
    space.set(10, 2, 16, solid(7));

    const buffers = look(space, [10, 2, 10], 0, 0, tileAtlas(halfTransparentTile(8)));
    const sites = new Set(struckPixels(buffers).map((pixel) => buffers.pickSite[pixel]!));

    expect(sites.has(space.index(10, 2, 16))).toBe(true);
  });
});

describe("hexel maps seen from inside", () => {
  it("draws hexels and reports the sites they came from", () => {
    const space = new MapVoxelSpace(20, 20, "hexel");
    for (let x = 8; x <= 12; x += 1) {
      for (let z = 12; z <= 16; z += 1) {
        for (let y = 0; y <= 3; y += 1) space.set(x, y, z, solid(5));
      }
    }

    const buffers = look(space, [10, 6, 9], 0, -0.4);
    const struck = struckPixels(buffers);

    expect(struck.length).toBeGreaterThan(0);
    for (const pixel of struck) {
      const [x, y, z] = space.coordsOf(buffers.pickSite[pixel]!);
      expect(space.isFilled(x, y, z)).toBe(true);
      expect((((x + y + z) % 2) + 2) % 2).toBe(0); // a real lattice site
    }
  });

  it("reports one of the twelve rhombic faces, not a cube's six", () => {
    const space = new MapVoxelSpace(20, 20, "hexel");
    for (let x = 6; x <= 14; x += 1) {
      for (let z = 10; z <= 18; z += 1) {
        for (let y = 0; y <= 3; y += 1) space.set(x, y, z, solid(5));
      }
    }

    const buffers = look(space, [10, 6, 8], 0, -0.5);
    const faces = new Set(struckPixels(buffers).map((pixel) => buffers.pickFace[pixel]!));

    expect(faces.size).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toBeGreaterThanOrEqual(0);
      expect(face).toBeLessThan(HEXEL_GEOMETRY.faces.length);
    }
  });
});
