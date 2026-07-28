/**
 * In-world block-editing tests — the pure geometry that turns a click on the
 * explorable world into a placed or removed cube. They drive the real
 * {@link unprojectScreen}, {@link BuildLayer} and {@link screenToBuffer}, and the
 * final case runs the actual scene rasterizer to prove the whole chain
 * (render → pick buffers → depth → unproject) lands back on the surface that was
 * drawn. No canvas, DOM or React involved — pure inputs and outputs throughout.
 */

import { describe, expect, it } from "vitest";

import { renderScene, VoxelGrid, voxelGridToModel, CUBE_GEOMETRY } from "@cartbox/editor";
import {
  BuildLayer,
  cubeEdgesScreen,
  pickSurface,
  projectWorld,
  screenToBuffer,
  unprojectScreen,
  type PickBuffers,
  type WorldCamera,
  type WorldPoint,
} from "../apps/web/src/lib/worldEdit";

/**
 * The exact forward projection the scene renderer uses (yaw about vertical, then a
 * pitch tip toward the viewer, then a uniform scale about the screen centre),
 * expressed here so the tests can assert that {@link unprojectScreen} is its true
 * inverse rather than re-deriving the same algebra from the implementation.
 */
function forwardProject(world: WorldPoint, camera: WorldCamera): { sx: number; sy: number; camZ: number } {
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const x = world[0] - camera.origin[0];
  const y = world[1] - camera.origin[1];
  const z = world[2] - camera.origin[2];
  const yawX = x * cosYaw + z * sinYaw;
  const yawZ = -x * sinYaw + z * cosYaw;
  const camY = y * cosPitch - yawZ * sinPitch;
  const camZ = y * sinPitch + yawZ * cosPitch;
  return { sx: camera.centre + yawX * camera.cell, sy: camera.centre - camY * camera.cell, camZ };
}

const CAMERAS: readonly WorldCamera[] = [
  { yaw: 0, pitch: 0.42, cell: 6, centre: 190, origin: [0, 0, 0] },
  { yaw: 0.7, pitch: 0.5, cell: 8, centre: 190, origin: [3, -2, 5] },
  { yaw: -1.2, pitch: 0.2, cell: 4, centre: 128, origin: [-10, 4, -6] },
];

const SAMPLE_POINTS: readonly WorldPoint[] = [
  [0, 0, 0],
  [2.5, 1.5, -3.5],
  [-4, 6, 2],
  [7.25, -1.75, 8.5],
];

describe("unprojectScreen", () => {
  it("is the exact inverse of the renderer's forward projection", () => {
    for (const camera of CAMERAS) {
      for (const world of SAMPLE_POINTS) {
        const projected = forwardProject(world, camera);
        const recovered = unprojectScreen(projected.sx, projected.sy, projected.camZ, camera);
        expect(recovered[0]).toBeCloseTo(world[0], 6);
        expect(recovered[1]).toBeCloseTo(world[1], 6);
        expect(recovered[2]).toBeCloseTo(world[2], 6);
      }
    }
  });
});

describe("projectWorld", () => {
  it("matches the renderer's forward projection", () => {
    for (const camera of CAMERAS) {
      for (const world of SAMPLE_POINTS) {
        const expected = forwardProject(world, camera);
        const actual = projectWorld(world, camera);
        expect(actual.sx).toBeCloseTo(expected.sx, 6);
        expect(actual.sy).toBeCloseTo(expected.sy, 6);
        expect(actual.camZ).toBeCloseTo(expected.camZ, 6);
      }
    }
  });

  it("round-trips through unprojectScreen", () => {
    for (const camera of CAMERAS) {
      for (const world of SAMPLE_POINTS) {
        const screen = projectWorld(world, camera);
        const back = unprojectScreen(screen.sx, screen.sy, screen.camZ, camera);
        expect(back[0]).toBeCloseTo(world[0], 6);
        expect(back[1]).toBeCloseTo(world[1], 6);
        expect(back[2]).toBeCloseTo(world[2], 6);
      }
    }
  });
});

describe("cubeEdgesScreen", () => {
  const camera = CAMERAS[1]!;

  it("projects the twelve edges of the unit cube around a cell centre", () => {
    const edges = cubeEdgesScreen([2, 1, -3], camera);
    expect(edges).toHaveLength(12);
    // Every endpoint is a corner of that cube, projected — so each lies within
    // half a cube's projected extent of the centre.
    const centre = projectWorld([2, 1, -3], camera);
    const reach = Math.hypot(camera.cell, camera.cell); // a corner offset is ≤ √3/2 cells
    for (const [from, to] of edges) {
      for (const point of [from, to]) {
        expect(Math.hypot(point[0] - centre.sx, point[1] - centre.sy)).toBeLessThanOrEqual(reach);
      }
    }
  });

  it("traces a closed wireframe: every corner meets exactly three edges", () => {
    const edges = cubeEdgesScreen([0, 0, 0], camera);
    const uses = new Map<string, number>();
    for (const [from, to] of edges) {
      for (const point of [from, to]) {
        const id = `${point[0].toFixed(4)},${point[1].toFixed(4)}`;
        uses.set(id, (uses.get(id) ?? 0) + 1);
      }
    }
    expect(uses.size).toBe(8); // eight distinct corners
    expect([...uses.values()].every((count) => count === 3)).toBe(true);
  });

  it("follows the camera: the wireframe moves when the view turns", () => {
    const straight = cubeEdgesScreen([3, 0, 0], camera);
    const turned = cubeEdgesScreen([3, 0, 0], { ...camera, yaw: camera.yaw + 0.4 });
    expect(turned[0]![0][0]).not.toBeCloseTo(straight[0]![0][0], 3);
  });
});

describe("screenToBuffer", () => {
  it("maps a CSS offset in a scaled canvas to the render-buffer pixel", () => {
    // A 380px buffer shown at 760 CSS px: the centre offset maps to the centre pixel.
    const centre = screenToBuffer(380, 380, 760, 760, 380);
    expect(centre).toEqual({ px: 190, py: 190 });
    const topLeft = screenToBuffer(0, 0, 760, 760, 380);
    expect(topLeft).toEqual({ px: 0, py: 0 });
  });

  it("rejects offsets outside the canvas and degenerate rects", () => {
    expect(screenToBuffer(-1, 10, 760, 760, 380)).toBeNull();
    expect(screenToBuffer(800, 10, 760, 760, 380)).toBeNull();
    expect(screenToBuffer(10, 10, 0, 760, 380)).toBeNull();
  });
});

describe("BuildLayer", () => {
  it("places a block in the empty cell just outside the picked face", () => {
    const layer = new BuildLayer(9, 9, 9);
    // A hit on the top (+Y) face of the centre cell: its world surface is half a
    // cell above the centre. Placing should fill the cell one unit higher.
    const centreWorld = layer.cellToWorld(4, 4, 4);
    const topFaceHit: WorldPoint = [centreWorld[0], centreWorld[1] + 0.5, centreWorld[2]];
    const placed = layer.place(topFaceHit, [0, 1, 0], { r: 200, g: 150, b: 100 });
    expect(placed).toEqual([4, 5, 4]);
    expect(layer.isFilled(4, 5, 4)).toBe(true);
    expect(layer.count).toBe(1);
  });

  it("round-trips: a placed block is removed by picking its own face", () => {
    const layer = new BuildLayer(9, 9, 9);
    const surface = layer.cellToWorld(4, 4, 4);
    const hit: WorldPoint = [surface[0], surface[1] + 0.5, surface[2]];
    const cell = layer.place(hit, [0, 1, 0], { r: 10, g: 20, b: 30 });
    expect(cell).toEqual([4, 5, 4]);

    // The placed block's own top face is half a cell above its centre.
    const placedCentre = layer.cellToWorld(4, 5, 4);
    const placedTop: WorldPoint = [placedCentre[0], placedCentre[1] + 0.5, placedCentre[2]];
    expect(layer.remove(placedTop, [0, 1, 0])).toEqual([4, 5, 4]);
    expect(layer.count).toBe(0);
  });

  it("refuses to place outside the lattice or into an occupied cell", () => {
    const layer = new BuildLayer(3, 3, 3);
    const edge = layer.cellToWorld(2, 1, 1);
    // Stepping +X off the far edge lands off-grid.
    expect(layer.place([edge[0] + 0.5, edge[1], edge[2]], [1, 0, 0], { r: 1, g: 2, b: 3 })).toBeNull();

    const centre = layer.cellToWorld(1, 1, 1);
    layer.place([centre[0] - 0.5, centre[1], centre[2]], [-1, 0, 0], { r: 1, g: 2, b: 3 }); // fills (0,1,1)
    // A second place resolving to the same cell is rejected.
    expect(layer.place([centre[0] - 0.5, centre[1], centre[2]], [-1, 0, 0], { r: 4, g: 5, b: 6 })).toBeNull();
  });

  it("removing an empty cell (e.g. a terrain pick) is a no-op", () => {
    const layer = new BuildLayer(5, 5, 5);
    const world = layer.cellToWorld(2, 2, 2);
    expect(layer.remove([world[0], world[1] + 0.5, world[2]], [0, 1, 0])).toBeNull();
    expect(layer.count).toBe(0);
  });

  it("exposes a placed model only once it holds blocks", () => {
    const layer = new BuildLayer(5, 5, 5);
    expect(layer.toPlacedModel()).toBeNull();
    const world = layer.cellToWorld(2, 2, 2);
    layer.place([world[0], world[1] + 0.5, world[2]], [0, 1, 0], { r: 9, g: 9, b: 9 });
    const model = layer.toPlacedModel();
    expect(model).not.toBeNull();
    expect(model!.model.count).toBe(1);
    expect(model!.model.geometry).toBe(CUBE_GEOMETRY);
  });

  it("places a textured block as a white voxel carrying the chosen material", () => {
    const atlas = { tiles: [{ size: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) }] };
    const layer = new BuildLayer(5, 5, 5, atlas);
    const world = layer.cellToWorld(2, 2, 2);
    layer.place([world[0], world[1] + 0.5, world[2]], [0, 1, 0], { r: 9, g: 9, b: 9 }, 0);
    const placed = layer.toPlacedModel()!;
    // The atlas is threaded through so the material can be sampled.
    expect(placed.atlas).toBe(atlas);
    // The block is white (so the tile shows as authored) and tagged material 0.
    expect(placed.model.tile![0]).toBe(0);
    expect([placed.model.r[0], placed.model.g[0], placed.model.b[0]]).toEqual([255, 255, 255]);
  });

  it("places a flat block (no material) with its given colour", () => {
    const layer = new BuildLayer(5, 5, 5);
    const world = layer.cellToWorld(2, 2, 2);
    layer.place([world[0], world[1] + 0.5, world[2]], [0, 1, 0], { r: 40, g: 50, b: 60 }); // material defaults to none
    const placed = layer.toPlacedModel()!;
    expect(placed.model.tile).toBeUndefined();
    expect([placed.model.r[0], placed.model.g[0], placed.model.b[0]]).toEqual([40, 50, 60]);
  });
});

describe("BuildLayer.placementCell", () => {
  it("previews exactly the cell a place would fill", () => {
    const layer = new BuildLayer(9, 9, 9);
    const centre = layer.cellToWorld(4, 4, 4);
    const topHit: WorldPoint = [centre[0], centre[1] + 0.5, centre[2]];

    const previewed = layer.placementCell(topHit, [0, 1, 0]);
    expect(previewed).toEqual([4, 5, 4]);
    expect(layer.count).toBe(0); // previewing places nothing
    expect(layer.place(topHit, [0, 1, 0], { r: 1, g: 2, b: 3 })).toEqual(previewed);
  });

  it("shows nothing where a place would be refused", () => {
    const layer = new BuildLayer(3, 3, 3);
    const edge = layer.cellToWorld(2, 1, 1);
    const offGrid: WorldPoint = [edge[0] + 0.5, edge[1], edge[2]];
    expect(layer.placementCell(offGrid, [1, 0, 0])).toBeNull();
    expect(layer.place(offGrid, [1, 0, 0], { r: 1, g: 2, b: 3 })).toBeNull();

    const centre = layer.cellToWorld(1, 1, 1);
    const hit: WorldPoint = [centre[0] - 0.5, centre[1], centre[2]];
    layer.place(hit, [-1, 0, 0], { r: 1, g: 2, b: 3 }); // now occupied
    expect(layer.placementCell(hit, [-1, 0, 0])).toBeNull();
  });
});

describe("BuildLayer serialize / restore", () => {
  it("round-trips blocks with their colour, glow and material", () => {
    const atlas = { tiles: [{ size: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) }] };
    const source = new BuildLayer(7, 7, 7, atlas);
    const flat = source.cellToWorld(3, 3, 3);
    source.place([flat[0], flat[1] + 0.5, flat[2]], [0, 1, 0], { r: 40, g: 50, b: 60, emissive: 200 });
    const textured = source.cellToWorld(3, 4, 3);
    source.place([textured[0], textured[1] + 0.5, textured[2]], [0, 1, 0], { r: 9, g: 9, b: 9 }, 0);
    expect(source.count).toBe(2);

    const restored = new BuildLayer(7, 7, 7, atlas);
    expect(restored.restore(source.serialize())).toBe(true);
    expect(restored.count).toBe(2);
    expect(restored.isFilled(3, 4, 3)).toBe(true);
    expect(restored.isFilled(3, 5, 3)).toBe(true);

    // The rebuilt model carries the same voxels: one flat + glowing, one white
    // and tagged with the material.
    const model = restored.toPlacedModel()!;
    expect(model.model.count).toBe(2);
    const colours = new Set<string>();
    for (let i = 0; i < model.model.count; i += 1) {
      colours.add(`${model.model.r[i]},${model.model.g[i]},${model.model.b[i]}`);
    }
    expect(colours).toEqual(new Set(["40,50,60", "255,255,255"]));
    expect([...model.model.tile!]).toContain(0); // the textured block kept its material
  });

  it("replaces what was already built rather than merging into it", () => {
    const first = new BuildLayer(5, 5, 5);
    const a = first.cellToWorld(2, 2, 2);
    first.place([a[0], a[1] + 0.5, a[2]], [0, 1, 0], { r: 1, g: 1, b: 1 });
    const payload = first.serialize();

    const second = new BuildLayer(5, 5, 5);
    const b = second.cellToWorld(0, 0, 0);
    second.place([b[0], b[1] + 0.5, b[2]], [0, 1, 0], { r: 2, g: 2, b: 2 }); // a different block
    expect(second.restore(payload)).toBe(true);
    expect(second.count).toBe(1);
    expect(second.isFilled(2, 3, 2)).toBe(true);
    expect(second.isFilled(0, 1, 0)).toBe(false); // the old block is gone
  });

  it("rejects an unreadable payload or one from a differently sized world", () => {
    const layer = new BuildLayer(5, 5, 5);
    const world = layer.cellToWorld(2, 2, 2);
    layer.place([world[0], world[1] + 0.5, world[2]], [0, 1, 0], { r: 7, g: 7, b: 7 });

    expect(layer.restore("not json at all")).toBe(false);
    const otherWorld = new BuildLayer(9, 9, 9);
    const far = otherWorld.cellToWorld(4, 4, 4);
    otherWorld.place([far[0], far[1] + 0.5, far[2]], [0, 1, 0], { r: 8, g: 8, b: 8 });
    expect(layer.restore(otherWorld.serialize())).toBe(false);
    // A refused restore leaves the existing build untouched.
    expect(layer.count).toBe(1);
    expect(layer.isFilled(2, 3, 2)).toBe(true);
  });
});

describe("pick → unproject chain against the real rasterizer", () => {
  it("unprojects a picked pixel back onto the drawn cube surface", () => {
    const size = 120;
    // A single cube centred at the world origin.
    const grid = new VoxelGrid(1, 1, 1);
    grid.set(0, 0, 0, 180, 180, 180);
    const model = voxelGridToModel(grid, { center: "grid" });

    const camera: WorldCamera = { yaw: 0.6, pitch: 0.42, cell: 24, centre: size / 2, origin: [0, 0, 0] };
    const out = new Uint8ClampedArray(size * size * 4);
    const depth = new Float32Array(size * size);
    const pickInstance = new Int32Array(size * size);
    const pickFace = new Int8Array(size * size);

    renderScene([{ model, position: [0, 0, 0] }], {
      size,
      cell: camera.cell,
      yaw: camera.yaw,
      pitch: camera.pitch,
      origin: camera.origin,
      out,
      depthBuffer: depth,
      pickInstance,
      pickFace,
    });

    // Find a pixel the cube won, and unproject it through the same camera.
    let checked = 0;
    for (let i = 0; i < pickInstance.length; i += 1) {
      if (pickInstance[i] !== 0) continue;
      const face = pickFace[i]!;
      expect(face).toBeGreaterThanOrEqual(0);
      const px = i % size;
      const py = Math.floor(i / size);
      const hit = unprojectScreen(px + 0.5, py + 0.5, depth[i]!, camera);

      // The hit must lie on the unit cube: on one axis it sits on a face (±0.5),
      // and it never escapes the cube's half-extent on any axis.
      const normal = CUBE_GEOMETRY.faces[face]!.normal;
      for (let axis = 0; axis < 3; axis += 1) {
        expect(Math.abs(hit[axis]!)).toBeLessThanOrEqual(0.5 + 1e-3);
      }
      // Stepping half a cell along the picked normal leaves the cube (all coords
      // still within a cell of the surface), i.e. the placement direction is sane.
      const outside = hit[0]! * normal[0] + hit[1]! * normal[1] + hit[2]! * normal[2];
      expect(outside).toBeCloseTo(0.5, 2);
      checked += 1;
      if (checked >= 20) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("resolves a drawn pixel to the surface under it, and sky to nothing", () => {
    const scene = renderCubeScene();
    const { camera, buffers, models, size } = scene;

    let hits = 0;
    let sky = 0;
    for (let i = 0; i < buffers.instance.length; i += 1) {
      const px = i % size;
      const py = Math.floor(i / size);
      const hit = pickSurface(px, py, buffers, models, camera);
      if (buffers.instance[i]! < 0) {
        expect(hit).toBeNull(); // open sky offers nothing to build against
        sky += 1;
        continue;
      }
      expect(hit).not.toBeNull();
      expect(hit!.instance).toBe(0);
      // The resolved point sits on the drawn cube, and the normal is the picked
      // face's own outward normal.
      const dot =
        hit!.point[0] * hit!.normal[0] + hit!.point[1] * hit!.normal[1] + hit!.point[2] * hit!.normal[2];
      expect(dot).toBeCloseTo(0.5, 2);
      expect(CUBE_GEOMETRY.faces.map((face) => face.normal)).toContainEqual(hit!.normal);
      hits += 1;
    }
    expect(hits).toBeGreaterThan(0);
    expect(sky).toBeGreaterThan(0);
  });

  it("rejects pixels outside the buffer", () => {
    const { camera, buffers, models, size } = renderCubeScene();
    expect(pickSurface(-1, 10, buffers, models, camera)).toBeNull();
    expect(pickSurface(10, size, buffers, models, camera)).toBeNull();
  });

  it("previews the cell a tap would build, one step out along the picked face", () => {
    const { camera, buffers, models, size } = renderCubeScene();
    // The lattice the cube sits on: the world cube occupies its centre cell.
    const layer = new BuildLayer(5, 5, 5);
    expect(layer.cellToWorld(2, 2, 2)).toEqual([0, 0, 0]);

    let previewed = 0;
    for (let i = 0; i < buffers.instance.length; i += 1) {
      if (buffers.instance[i]! < 0) continue;
      const hit = pickSurface(i % size, Math.floor(i / size), buffers, models, camera)!;
      const target = layer.placementCell(hit.point, hit.normal);
      expect(target).not.toBeNull();
      // The previewed cell is the centre cell stepped one along the picked normal.
      expect(target).toEqual([
        2 + Math.round(hit.normal[0]),
        2 + Math.round(hit.normal[1]),
        2 + Math.round(hit.normal[2]),
      ]);
      previewed += 1;
      if (previewed >= 20) break;
    }
    expect(previewed).toBeGreaterThan(0);
  });
});

/**
 * Draw a single unit cube at the world origin through the real scene renderer and
 * hand back everything a pick needs: the camera it was drawn with, the pick/depth
 * buffers it filled, and the model list those indices name.
 */
function renderCubeScene(): {
  camera: WorldCamera;
  buffers: PickBuffers;
  models: ReturnType<typeof cubeModels>;
  size: number;
} {
  const size = 96;
  const camera: WorldCamera = { yaw: 0.6, pitch: 0.42, cell: 20, centre: size / 2, origin: [0, 0, 0] };
  const models = cubeModels();
  const buffers: PickBuffers = {
    instance: new Int32Array(size * size),
    face: new Int8Array(size * size),
    depth: new Float32Array(size * size),
    size,
  };

  renderScene(models, {
    size,
    cell: camera.cell,
    yaw: camera.yaw,
    pitch: camera.pitch,
    origin: camera.origin,
    out: new Uint8ClampedArray(size * size * 4),
    depthBuffer: buffers.depth,
    pickInstance: buffers.instance,
    pickFace: buffers.face,
  });
  return { camera, buffers, models, size };
}

/** A one-voxel cube model placed at the world origin. */
function cubeModels() {
  const grid = new VoxelGrid(1, 1, 1);
  grid.set(0, 0, 0, 180, 180, 180);
  return [{ model: voxelGridToModel(grid, { center: "grid" }), position: [0, 0, 0] as const }];
}
