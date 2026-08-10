/**
 * Tests for the HD-2D world runtime — the feature that lets a shipped cart put 2D
 * character sprites into a 3D tile world with correct depth occlusion.
 *
 * These validate real component behaviour against real inputs/outputs: geometry
 * is built from actual WorldScene data, and occlusion is asserted by rasterising
 * through the same shared-depth-buffer renderer the runtime uses and reading the
 * resulting pixels — no mocks, no hard-coded expectations pulled from thin air.
 */

import { describe, expect, it } from "vitest";

import {
  parseWorldScene,
  buildTerrainInstances,
  buildBillboardInstance,
  buildShadowInstance,
  makeShadowTexture,
  buildWorldCamera,
  cellAt,
  worldCenter,
  CELL_WORLD,
  HEIGHT_WORLD,
  type WorldScene,
} from "@cartbox/player";
import { renderMeshScene, type DecodedTexture, type MeshSceneInstance } from "@cartbox/editor";

/** A flat solid-colour texture, used so rasterised pixels are easy to assert on. */
function solidTexture(r: number, g: number, b: number, a = 255): DecodedTexture {
  const data = new Uint8ClampedArray([r, g, b, a]);
  return { width: 1, height: 1, data };
}

function makeScene(overrides: Partial<WorldScene> = {}): WorldScene {
  const cols = 3;
  const rows = 3;
  const cells = Array.from({ length: cols * rows }, () => ({ h: 0, sprite: 7 }));
  return { cols, rows, tilesPerSide: 4, cells, props: [], billboards: [], ...overrides };
}

describe("parseWorldScene", () => {
  it("round-trips a valid sidecar and rejects malformed ones", () => {
    const scene = makeScene({ billboards: [{ sprite: 4, width: 1, height: 2 }] });
    const parsed = parseWorldScene(JSON.stringify(scene));
    expect(parsed).not.toBeNull();
    expect(parsed!.cols).toBe(3);
    expect(parsed!.cells).toHaveLength(9);
    expect(parsed!.billboards[0]).toEqual({ sprite: 4, width: 1, height: 2 });

    expect(parseWorldScene(null)).toBeNull();
    expect(parseWorldScene("{not json")).toBeNull();
    // cells length must match cols*rows.
    expect(parseWorldScene(JSON.stringify({ cols: 2, rows: 2, tilesPerSide: 4, cells: [{ h: 0, sprite: 0 }] }))).toBeNull();
  });

  it("parses static scenery props with positions and sizes", () => {
    const scene = makeScene({ props: [{ sprite: 64, x: 2.5, y: 1, z: 3.5, width: 2.4, height: 3 }] });
    const parsed = parseWorldScene(JSON.stringify(scene))!;
    expect(parsed.props).toHaveLength(1);
    expect(parsed.props[0]).toEqual({ sprite: 64, x: 2.5, y: 1, z: 3.5, width: 2.4, height: 3 });
    // Absent props default to an empty list (back-compat with pre-props worlds).
    const noProps = parseWorldScene(JSON.stringify({ cols: 1, rows: 1, tilesPerSide: 4, cells: [{ h: 0, sprite: 0 }] }))!;
    expect(noProps.props).toEqual([]);
  });

  it("clamps negative heights and defaults missing billboard sizes", () => {
    const raw = JSON.stringify({
      cols: 1,
      rows: 1,
      tilesPerSide: 4,
      cells: [{ h: -5, sprite: 2 }],
      billboards: [{ sprite: 4 }],
    });
    const parsed = parseWorldScene(raw)!;
    expect(parsed.cells[0]!.h).toBe(0);
    expect(parsed.billboards[0]!.width).toBe(1);
  });
});

describe("cellAt", () => {
  it("returns a below-floor sentinel out of bounds so edge walls close", () => {
    const scene = makeScene();
    expect(cellAt(scene, -1, 0).h).toBe(-1);
    expect(cellAt(scene, 0, 0).h).toBe(0);
  });
});

describe("buildTerrainInstances", () => {
  it("groups cells by tile sprite into one textured instance each", () => {
    const scene = makeScene({
      cells: [
        { h: 0, sprite: 7 }, { h: 0, sprite: 7 }, { h: 0, sprite: 7 },
        { h: 0, sprite: 7 }, { h: 1, sprite: 9 }, { h: 0, sprite: 7 },
        { h: 0, sprite: 7 }, { h: 0, sprite: 7 }, { h: 0, sprite: 7 },
      ],
    });
    const texels: Record<number, DecodedTexture> = { 7: solidTexture(10, 200, 10), 9: solidTexture(200, 10, 10) };
    const instances = buildTerrainInstances(scene, (sprite) => texels[sprite] ?? null);
    // Two distinct sprites → two instances.
    expect(instances).toHaveLength(2);
    const sprite9 = instances.find((i) => i.textures?.[0] === texels[9])!;
    expect(sprite9).toBeDefined();
    // The raised centre cell contributes a top quad AND four wall quads (it is a
    // full height unit above every neighbour): 5 quads → 10 triangles → 30 indices.
    expect(sprite9.mesh.primitives[0]!.indices.length).toBe(30);
  });

  it("positions a cell's top face at its height", () => {
    const scene = makeScene({ cols: 1, rows: 1, cells: [{ h: 2, sprite: 7 }] });
    const [instance] = buildTerrainInstances(scene, () => solidTexture(0, 0, 0));
    const ys = instance!.mesh.primitives[0]!.positions.filter((_v, idx) => idx % 3 === 1);
    // A single isolated cell: top face at h*HEIGHT_WORLD, walls drop to floor 0.
    expect(Math.max(...ys)).toBeCloseTo(2 * HEIGHT_WORLD, 5);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
  });
});

describe("buildBillboardInstance", () => {
  it("builds a quad centred on its feet, spanning width/height along the camera basis", () => {
    const foot: [number, number, number] = [5, 0, 5];
    const right: [number, number, number] = [1, 0, 0];
    const up: [number, number, number] = [0, 1, 0];
    const instance = buildBillboardInstance(foot, 2, 3, right, up, solidTexture(0, 0, 255));
    const pos = instance.mesh.primitives[0]!.positions;
    const xs = [pos[0], pos[3], pos[6], pos[9]] as number[];
    const ys = [pos[1], pos[4], pos[7], pos[10]] as number[];
    // Width 2 → x spans foot.x ± 1; height 3 → y from foot.y to foot.y+3.
    expect(Math.min(...xs)).toBeCloseTo(4, 5);
    expect(Math.max(...xs)).toBeCloseTo(6, 5);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(3, 5);
  });

  it("maps the sprite upright: top vertices sample the top of the texture (v=1)", () => {
    // The rasteriser samples ty = (1 - v) * h, so the top of the billboard (higher
    // y) must carry v = 1 to show the sprite's head, not its feet (upside-down bug).
    const instance = buildBillboardInstance([0, 0, 0], 2, 4, [1, 0, 0], [0, 1, 0], solidTexture(0, 0, 0));
    const prim = instance.mesh.primitives[0]!;
    const ys = prim.positions;
    const vs = prim.uvs!;
    for (let i = 0; i < 4; i += 1) {
      const y = ys[i * 3 + 1]!;
      const v = vs[i * 2 + 1]!;
      // Bottom vertices (y≈0) → v=0; top vertices (y≈4) → v=1.
      expect(v).toBeCloseTo(y > 2 ? 1 : 0, 5);
    }
  });
});

describe("buildShadowInstance + makeShadowTexture", () => {
  it("lays a flat ground quad centred under the feet", () => {
    const inst = buildShadowInstance([3, 1, 4], 0.5, makeShadowTexture());
    const p = inst.mesh.primitives[0]!.positions;
    const ys = [p[1], p[4], p[7], p[10]] as number[];
    // Horizontal quad, lifted a hair above the foot height (1) to avoid z-fighting.
    for (const y of ys) expect(y).toBeCloseTo(1.02, 5);
    const xs = [p[0], p[3], p[6], p[9]] as number[];
    expect(Math.min(...xs)).toBeCloseTo(2.5, 5);
    expect(Math.max(...xs)).toBeCloseTo(3.5, 5);
  });

  it("makes an opaque dark centre fading to transparent edges", () => {
    const t = makeShadowTexture(24);
    const at = (x: number, y: number, ch: number) => t.data[(y * 24 + x) * 4 + ch]!;
    expect(at(12, 12, 3)).toBe(255); // centre opaque
    expect(at(12, 12, 0)).toBeLessThan(40); // and dark
    expect(at(0, 0, 3)).toBe(0); // corners transparent
  });
});

describe("buildWorldCamera follow target", () => {
  it("frames the terrain centre with no target, and the target when given", () => {
    const scene = makeScene({ cols: 8, rows: 8 });
    const { center } = worldCenter(scene);
    const noTarget = buildWorldCamera(scene, { yaw: 0, pitch: 0.5, distance: 10, fov: 0 }, 1);
    // With a follow target the look-at centre moves; the view matrix's translation
    // differs from the no-target framing. Assert the camera actually recentres.
    const withTarget = buildWorldCamera(
      scene,
      { yaw: 0, pitch: 0.5, distance: 10, fov: 0, target: [1, 2, 1] },
      1,
    );
    // Different target → different view matrix.
    expect(Array.from(withTarget.view)).not.toEqual(Array.from(noTarget.view));
    // The target is in grid/height units; its world centre is target * cell/height.
    // Sanity: the framed no-target centre is the terrain middle (> the small target).
    expect(center[0]).toBeGreaterThan(1 * CELL_WORLD);
  });
});

/** Render a scene + billboards through the shared-depth renderer and return pixels. */
function rasterise(instances: MeshSceneInstance[], scene: WorldScene, size = 64) {
  const out = new Uint8ClampedArray(size * size * 4);
  const depth = new Float32Array(size * size);
  const camera = buildWorldCamera(scene, { yaw: 0, pitch: 0.2, distance: 0, fov: 0 }, 1);
  renderMeshScene(instances, {
    width: size,
    height: size,
    out,
    depth,
    view: camera.view,
    projection: camera.projection,
    background: [0, 0, 0, 0],
    ambient: 1,
  });
  return { out, size, camera };
}

describe("depth-composited billboards (the HD-2D occlusion)", () => {
  it("a billboard behind a tall wall is occluded by it; the same billboard in front is not", () => {
    // A single tall wall cell in the middle of an otherwise low grid.
    const cols = 5;
    const rows = 5;
    const cells = Array.from({ length: cols * rows }, () => ({ h: 0, sprite: 1 }));
    cells[2 * cols + 2] = { h: 6, sprite: 2 }; // a tall pillar at (2,2)
    const scene: WorldScene = {
      cols,
      rows,
      tilesPerSide: 4,
      cells,
      billboards: [{ sprite: 4, width: CELL_WORLD, height: HEIGHT_WORLD * 4 }],
    };
    const wallTex = solidTexture(20, 20, 20);
    const groundTex = solidTexture(40, 90, 40);
    const heroTex = solidTexture(255, 40, 255); // a colour nothing else uses
    const terrain = buildTerrainInstances(scene, (s) => (s === 2 ? wallTex : groundTex));

    // Camera looks along -z (yaw 0): higher z is nearer. Place the hero BEHIND the
    // pillar (smaller z) and then IN FRONT (larger z), same x, and count its pixels.
    const countHero = (heroZ: number): number => {
      const cam = buildWorldCamera(scene, { yaw: 0, pitch: 0.2, distance: 0, fov: 0 }, 1);
      const hero = buildBillboardInstance(
        [2.5 * CELL_WORLD, 0, heroZ * CELL_WORLD],
        CELL_WORLD,
        HEIGHT_WORLD * 4,
        cam.right,
        cam.up,
        heroTex,
      );
      const { out, size } = rasterise([...terrain, hero], scene);
      let n = 0;
      for (let p = 0; p < size * size; p += 1) {
        if (out[p * 4] === 255 && out[p * 4 + 1] === 40 && out[p * 4 + 2] === 255) n += 1;
      }
      return n;
    };

    const behind = countHero(0.5); // far side of the pillar (small z)
    const inFront = countHero(4.5); // near side of the pillar (large z)
    // In front the whole billboard shows; behind the pillar hides most/all of it.
    expect(inFront).toBeGreaterThan(0);
    expect(behind).toBeLessThan(inFront);
  });
});
