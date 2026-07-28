/**
 * Pointing at the map in 3D: what a click resolves to, and what a plane looks
 * like once drawn.
 *
 * The editor never ray-marches. It renders the window once with picking on and
 * reads the answer out of the buffers, so these are the guarantees the tools are
 * built on:
 *
 * - a pixel that drew something names the cell it came from, and the face it hit
 *   is one facing the camera — which is what makes "click a face to build against
 *   it" grow outward rather than into the block;
 * - the face-local coordinates name the exact texel that was drawn there, so the
 *   pixel tools paint the pixel the author is looking at;
 * - a plane cell really is flat, and is visible from both sides.
 *
 * Driven through the real renderer against real output pixels, with the light
 * flattened so a drawn texel and its source are directly comparable.
 */

import { describe, expect, it } from "vitest";

import {
  CUBE_FACES,
  MapVoxelSpace,
  geometryFor,
  mapSpaceToModel,
  renderVoxelModel,
  type FaceTexture,
  type MapCellKind,
  type ModelLight,
  type TextureAtlas,
} from "@cartbox/editor";

const SIZE = 220;
const CELL = 44;

/** Fully ambient: shade is exactly 1, so a drawn texel equals its source texel. */
const FLAT_LIGHT: ModelLight = { direction: [0, 1, 0], color: [1, 1, 1], intensity: 0, ambient: 1 };

const palette = (index: number): readonly [number, number, number] => [index * 12, 60, 120];

/** A tile whose every texel is a different, identifiable colour. */
function identifiableTile(size: number): FaceTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let ty = 0; ty < size; ty += 1) {
    for (let tx = 0; tx < size; tx += 1) {
      const base = (ty * size + tx) * 4;
      data[base] = tx * 40 + 10;
      data[base + 1] = ty * 40 + 10;
      data[base + 2] = 200;
      data[base + 3] = 255;
    }
  }
  return { size, data };
}

/** An atlas with that one tile as material 0, on every face. */
function tileAtlas(tile: FaceTexture): TextureAtlas {
  return { tiles: [tile], materials: [{ top: 0, side: 0, bottom: 0 }] };
}

/** Render buffers sized for the fixed test viewport. */
function makeBuffers() {
  return {
    out: new Uint8ClampedArray(SIZE * SIZE * 4),
    depth: new Float32Array(SIZE * SIZE),
    pickVoxel: new Int32Array(SIZE * SIZE),
    pickFace: new Int8Array(SIZE * SIZE),
    pickU: new Float32Array(SIZE * SIZE),
    pickV: new Float32Array(SIZE * SIZE),
  };
}

/** A one-cell map, and the model + buffers for looking straight at it. */
function renderOneCell(
  cell: { kind: MapCellKind; material: number },
  camera: { yaw: number; pitch: number },
  atlas?: TextureAtlas,
) {
  const space = new MapVoxelSpace(9, 9);
  const site: [number, number, number] = [4, 0, 4];
  space.set(site[0], site[1], site[2], { colorIndex: 5, material: cell.material, kind: cell.kind });

  const model = mapSpaceToModel(space, { palette, focus: { x: site[0], y: site[1], z: site[2] }, radius: 2 });
  const buffers = makeBuffers();
  renderVoxelModel(model, {
    yaw: camera.yaw,
    pitch: camera.pitch,
    cell: CELL,
    size: SIZE,
    light: FLAT_LIGHT,
    atlas,
    out: buffers.out,
    depthBuffer: buffers.depth,
    pickVoxel: buffers.pickVoxel,
    pickFace: buffers.pickFace,
    pickU: buffers.pickU,
    pickV: buffers.pickV,
  });
  return { space, site, model, buffers };
}

/** Indices of every output pixel that drew part of the model. */
function drawnPixels(buffers: ReturnType<typeof makeBuffers>): number[] {
  const found: number[] = [];
  for (let i = 0; i < buffers.pickVoxel.length; i += 1) if (buffers.pickVoxel[i]! >= 0) found.push(i);
  return found;
}

describe("picking a cell out of the rendered map", () => {
  it("names the cell that drew each pixel", () => {
    const { space, site, model, buffers } = renderOneCell({ kind: "solid", material: -1 }, { yaw: 0.6, pitch: 0.5 });
    const drawn = drawnPixels(buffers);

    expect(drawn.length).toBeGreaterThan(0);
    for (const index of drawn) {
      const voxel = buffers.pickVoxel[index]!;
      expect(space.coordsOf(model.gridIndex[voxel]!)).toEqual(site);
    }
  });

  it("leaves the buffers empty where nothing was drawn", () => {
    const { buffers } = renderOneCell({ kind: "solid", material: -1 }, { yaw: 0.6, pitch: 0.5 });

    // The corner of a viewport far wider than one cell can never be covered.
    expect(buffers.pickVoxel[0]).toBe(-1);
    expect(buffers.pickFace[0]).toBe(-1);
    expect(buffers.pickU[0]).toBe(-1);
    expect(buffers.pickV[0]).toBe(-1);
  });

  it("only ever reports a face turned toward the camera", () => {
    // This is what makes building outward work: the neighbour across a picked
    // face is always the empty side, never the inside of the block.
    const yaw = 0.6;
    const pitch = 0.5;
    const { buffers } = renderOneCell({ kind: "solid", material: -1 }, { yaw, pitch });
    const faces = new Set(drawnPixels(buffers).map((index) => buffers.pickFace[index]!));

    expect(faces.size).toBeGreaterThan(0);
    for (const index of faces) {
      const [nx, ny, nz] = CUBE_FACES[index]!.normal;
      const yawZ = -nx * Math.sin(yaw) + nz * Math.cos(yaw);
      const towardViewer = ny * Math.sin(pitch) + yawZ * Math.cos(pitch);
      expect(towardViewer).toBeGreaterThan(0);
    }
  });

  it("steps to a neighbouring site across the picked face", () => {
    const { space, site, buffers } = renderOneCell({ kind: "solid", material: -1 }, { yaw: 0.6, pitch: 0.5 });
    const geometry = geometryFor(space.shape);

    for (const index of drawnPixels(buffers)) {
      const [dx, dy, dz] = geometry.faces[buffers.pickFace[index]!]!.offset;
      const neighbour: [number, number, number] = [site[0] + dx, site[1] + dy, site[2] + dz];
      // Growing against an exposed face always lands somewhere empty, which is
      // exactly what "place a cell here" needs to be true.
      expect(space.isFilled(neighbour[0], neighbour[1], neighbour[2])).toBe(false);
      expect(neighbour).not.toEqual(site);
    }
  });
});

describe("picking a texel out of the face under the cursor", () => {
  it("names the exact texel that was drawn at each pixel", () => {
    const tile = identifiableTile(4);
    const { buffers } = renderOneCell({ kind: "solid", material: 0 }, { yaw: 0.6, pitch: 0.5 }, tileAtlas(tile));
    const drawn = drawnPixels(buffers);

    expect(drawn.length).toBeGreaterThan(0);
    for (const index of drawn) {
      // The same clamp the textured fill applies, so the edge of a face resolves
      // to the last texel rather than off the end of the tile.
      const tx = Math.min(tile.size - 1, Math.floor(buffers.pickU[index]! * tile.size));
      const ty = Math.min(tile.size - 1, Math.floor(buffers.pickV[index]! * tile.size));
      const source = (ty * tile.size + tx) * 4;
      expect([buffers.out[index * 4], buffers.out[index * 4 + 1], buffers.out[index * 4 + 2]]).toEqual([
        tile.data[source],
        tile.data[source + 1],
        tile.data[source + 2],
      ]);
    }
  });

  it("reaches every texel of a face drawn large enough to show them all", () => {
    const tile = identifiableTile(4);
    const { buffers } = renderOneCell({ kind: "solid", material: 0 }, { yaw: 0, pitch: 0 }, tileAtlas(tile));

    const texels = new Set(
      drawnPixels(buffers).map((index) => {
        const tx = Math.min(tile.size - 1, Math.floor(buffers.pickU[index]! * tile.size));
        const ty = Math.min(tile.size - 1, Math.floor(buffers.pickV[index]! * tile.size));
        return ty * tile.size + tx;
      }),
    );

    // A cell drawn at CELL pixels across shows every one of its texels, so any of
    // them can be aimed at and painted.
    expect(texels.size).toBe(tile.size * tile.size);
  });

  it("keeps face-local coordinates inside the face", () => {
    const { buffers } = renderOneCell({ kind: "solid", material: 0 }, { yaw: 0.9, pitch: 0.3 }, tileAtlas(identifiableTile(4)));

    for (const index of drawnPixels(buffers)) {
      expect(buffers.pickU[index]!).toBeGreaterThanOrEqual(0);
      expect(buffers.pickU[index]!).toBeLessThanOrEqual(1);
      expect(buffers.pickV[index]!).toBeGreaterThanOrEqual(0);
      expect(buffers.pickV[index]!).toBeLessThanOrEqual(1);
    }
  });
});

describe("planes as they are drawn", () => {
  it("has no thickness on the axis it stands across", () => {
    // Seen exactly edge-on, a quad with zero extent covers nothing at all —
    // whereas a solid block in the same site fills its whole silhouette.
    const edgeOn = renderOneCell({ kind: "planeX", material: 0 }, { yaw: 0, pitch: 0 }, tileAtlas(identifiableTile(4)));
    const block = renderOneCell({ kind: "solid", material: 0 }, { yaw: 0, pitch: 0 }, tileAtlas(identifiableTile(4)));

    expect(drawnPixels(edgeOn.buffers)).toHaveLength(0);
    expect(drawnPixels(block.buffers).length).toBeGreaterThan(0);
  });

  it("covers the cell's full square on the axes it does span", () => {
    const plane = renderOneCell({ kind: "planeZ", material: 0 }, { yaw: 0, pitch: 0 }, tileAtlas(identifiableTile(4)));
    const block = renderOneCell({ kind: "solid", material: 0 }, { yaw: 0, pitch: 0 }, tileAtlas(identifiableTile(4)));

    expect(drawnPixels(plane.buffers).length).toBe(drawnPixels(block.buffers).length);
  });

  it("is visible from both sides", () => {
    const front = renderOneCell({ kind: "planeZ", material: 0 }, { yaw: 0, pitch: 0 }, tileAtlas(identifiableTile(4)));
    const behind = renderOneCell({ kind: "planeZ", material: 0 }, { yaw: Math.PI, pitch: 0 }, tileAtlas(identifiableTile(4)));

    expect(drawnPixels(front.buffers).length).toBeGreaterThan(0);
    expect(drawnPixels(behind.buffers).length).toBeGreaterThan(0);
    // The two sides are opposite faces of the same cell, so only one is ever drawn.
    const frontFaces = new Set(drawnPixels(front.buffers).map((i) => front.buffers.pickFace[i]!));
    const behindFaces = new Set(drawnPixels(behind.buffers).map((i) => behind.buffers.pickFace[i]!));
    expect(frontFaces.size).toBe(1);
    expect(behindFaces.size).toBe(1);
    expect([...frontFaces][0]).not.toBe([...behindFaces][0]);
  });

  it("resolves a click on either half of a cross to the one cell", () => {
    const { space, site, model, buffers } = renderOneCell(
      { kind: "cross", material: 0 },
      { yaw: 0.6, pitch: 0.4 },
      tileAtlas(identifiableTile(4)),
    );
    const voxels = new Set(drawnPixels(buffers).map((index) => buffers.pickVoxel[index]!));

    expect(voxels.size).toBe(2); // both quads are on screen
    for (const voxel of voxels) {
      expect(space.coordsOf(model.gridIndex[voxel]!)).toEqual(site);
    }
  });
});
