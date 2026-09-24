/**
 * The mesh overlay's per-frame economies for a big first-person scene (Lockout
 * at 720p, on a tablet):
 *
 * - the shadow map is kept up to date incrementally — only the movers' old and
 *   new footprints are redrawn, and only that region is reported for upload —
 *   and a character hiding (dying) no longer re-renders the whole static map;
 * - on the software rasteriser a slow first-person view drops its 3D render
 *   scale (the HUD stays full size) instead of running at a few frames a second.
 */

import { describe, expect, it, vi } from "vitest";

import {
  buildSceneShadow,
  composeModelMatrix,
  defaultSceneLighting,
  patchSceneLighting,
  type MeshAsset,
  type ShadowInput,
} from "@cartbox/editor";
import { MeshOverlaySurface, type SceneDraw, type SceneRenderer } from "@cartbox/player";

function box(name: string): MeshAsset {
  // A unit cube, so it casts a shadow from any sun angle.
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, 1]],
    [[0, -1, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0]], [[0, 0, -1], [1, 0, 0]],
  ];
  for (const [normal, u] of faces) {
    const v = [normal[1]! * u[2]! - normal[2]! * u[1]!, normal[2]! * u[0]! - normal[0]! * u[2]!, normal[0]! * u[1]! - normal[1]! * u[0]!];
    const base = p.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      p.push(0.5 * (normal[0]! + a! * u[0]! + b! * v[0]!), 0.5 * (normal[1]! + a! * u[1]! + b! * v[1]!), 0.5 * (normal[2]! + a! * u[2]! + b! * v[2]!));
      n.push(...normal);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: Float32Array.from(n),
        uvs: null,
        indices: Uint32Array.from(idx),
        material: { name, baseColorFactor: [0.6, 0.6, 0.6, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 },
      },
    ],
  };
}

const lighting = patchSceneLighting(defaultSceneLighting(), { shadows: true });
const bounds = { min: [-6, 0, -6] as [number, number, number], max: [6, 3, 6] as [number, number, number], center: [0, 1.5, 0] as [number, number, number], radius: 8 };

/** A floor, a pillar, and two movable characters (instances 2 and 3). */
function scene() {
  return {
    instances: [
      { mesh: box("floor"), model: composeModelMatrix([0, -0.5, 0], [0, 0, 0], [12, 1, 12]) },
      { mesh: box("pillar"), model: composeModelMatrix([-2, 1, -1], [0, 0, 0], [1, 2, 1]) },
      { mesh: box("a"), model: composeModelMatrix([0, 0.5, 0], [0, 0, 0], [1, 1, 1]) },
      { mesh: box("b"), model: composeModelMatrix([0, 0.5, 0], [0, 0, 0], [1, 1, 1]) },
    ],
    bounds,
    lighting,
  };
}

/** Captures each frame's shadow map (copied: the overlay reuses the array). */
function shadowSpy(): SceneRenderer & { shadows: { depth: Float32Array; dirty: ShadowInput["dirty"] }[]; draws: SceneDraw[] } {
  const shadows: { depth: Float32Array; dirty: ShadowInput["dirty"] }[] = [];
  const draws: SceneDraw[] = [];
  return {
    backend: "webgpu",
    shadows,
    draws,
    render: (_instances, draw) => {
      draws.push(draw);
      if (draw.shadow) shadows.push({ depth: Float32Array.from(draw.shadow.depth), dirty: draw.shadow.dirty });
    },
    dispose: () => {},
  };
}

const pose = (index: number, x: number, z: number, hidden = false) => ({
  index,
  hidden,
  position: [x, 0, z] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: 1,
});

describe("incremental shadow map", () => {
  it("matches a from-scratch shadow map every frame as characters move, hide and return", async () => {
    const spy = shadowSpy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), spy);
    const frames = [
      [pose(2, 1, 1), pose(3, -3, 2)],
      [pose(2, 1.5, 1), pose(3, -3, 2.5)],
      [pose(2, 2, 1.2), pose(3, 0, 0, true)], // b dies
      [pose(2, 3, 2), pose(3, 0, 0, true)],
      [pose(2, 3, 2), pose(3, 4, -4)], // b respawns elsewhere
    ];
    const s = scene();
    for (const [i, poses] of frames.entries()) {
      surface.setPoseOverrides(poses);
      surface.blit(new Uint8Array(32 * 24 * 4));
      // The reference: every instance, posed, rendered into a clean map.
      const drawn = [s.instances[0]!, s.instances[1]!];
      for (const p of poses) {
        if (p.hidden) continue;
        // Authored at y 0.5; the pose moves it in x/z.
        drawn.push({ mesh: s.instances[p.index]!.mesh, model: composeModelMatrix([p.position[0], 0.5, p.position[2]], [0, 0, 0], [1, 1, 1]) });
      }
      const reference = buildSceneShadow(drawn, lighting, bounds.center, bounds.radius, { size: 1024, depth: new Float32Array(1024 * 1024) })!;
      const got = spy.shadows[i]!.depth;
      let mismatched = 0;
      for (let k = 0; k < got.length; k += 1) if (got[k] !== reference.depth[k]) mismatched += 1;
      expect(mismatched, `frame ${i}`).toBe(0);
    }
    // The first frame uploads everything; after that only a small region changes.
    expect(spy.shadows[0]!.dirty).toBeNull();
    for (const { dirty } of spy.shadows.slice(1)) {
      expect(dirty).not.toBeNull();
      expect(dirty!.width * dirty!.height).toBeLessThan(1024 * 1024 * 0.25);
    }
  });

  it("does not rebuild the static map when a character hides", async () => {
    const spy = shadowSpy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), spy);
    surface.setPoseOverrides([pose(2, 1, 1), pose(3, -3, 2)]);
    surface.blit(new Uint8Array(32 * 24 * 4));
    surface.setPoseOverrides([pose(2, 1, 1), pose(3, 0, 0, true)]);
    surface.blit(new Uint8Array(32 * 24 * 4));
    // A rebuild would report the whole map (dirty null); an update reports a region.
    expect(spy.shadows[1]!.dirty).not.toBeNull();
  });
});

describe("software resolution governor", () => {
  function slowSoftware(ms: number): SceneRenderer & { sizes: [number, number][] } {
    const sizes: [number, number][] = [];
    return {
      backend: "software",
      sizes,
      render: (_instances, draw) => {
        sizes.push([draw.width, draw.height]);
        const until = performance.now() + ms;
        while (performance.now() < until) {
          /* a CPU rasteriser taking its time */
        }
      },
      dispose: () => {},
    };
  }

  function firstPerson(surface: MeshOverlaySurface) {
    surface.setHudMode(true);
    surface.setCameraOverride({ yaw: 0, pitch: 0, distance: 1, fov: 1.1, target: [0, 0, 0], hud: true });
  }

  it("renders a slow first-person 720p view smaller, but hands on a full-size frame", async () => {
    const renderer = slowSoftware(45);
    const blit = vi.fn();
    const surface = await MeshOverlaySurface.create({ blit, destroy() {} }, 1280, 720, { ...scene(), lighting: null }, renderer);
    firstPerson(surface);
    for (let i = 0; i < 12; i += 1) surface.blit(new Uint8Array(1280 * 720 * 4));
    expect(renderer.sizes[0]).toEqual([640, 360]); // software starts at half size
    expect(renderer.sizes.at(-1)![0]).toBeLessThan(640); // and steps down while slow
    expect((blit.mock.calls.at(-1)![0] as Uint8Array).length).toBe(1280 * 720 * 4);
  });

  it("leaves GPU rendering, small views and opted-out surfaces at full size", async () => {
    const gpu = { ...slowSoftware(0), backend: "webgpu" as const };
    const a = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 1280, 720, { ...scene(), lighting: null }, gpu);
    firstPerson(a);
    a.blit(new Uint8Array(1280 * 720 * 4));
    expect(gpu.sizes[0]).toEqual([1280, 720]);

    const small = slowSoftware(0);
    const b = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 320, 240, { ...scene(), lighting: null }, small);
    firstPerson(b);
    b.blit(new Uint8Array(320 * 240 * 4));
    expect(small.sizes[0]).toEqual([320, 240]);

    const off = slowSoftware(0);
    const c = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 1280, 720, { ...scene(), lighting: null }, off, { adaptiveResolution: false });
    firstPerson(c);
    c.blit(new Uint8Array(1280 * 720 * 4));
    expect(off.sizes[0]).toEqual([1280, 720]);
  });
});
