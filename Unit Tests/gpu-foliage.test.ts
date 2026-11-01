/**
 * Foliage a copy at a time (AAA_FIDELITY_ROADMAP.md F6b) on a real device
 * (Dawn): a plant drawn from its layer's mesh bends with the wind in the
 * world, by its height above its copy's root, whichever way the copy is
 * turned (its sway is its flexibility, negated: foliageInstanceMesh).
 */

import { describe, expect, it } from "vitest";

import { bakeOctahedralImpostor, composeModelMatrix, foliageInstanceMesh, octahedralDirection, octahedralUv, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 4000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

/** A thin post, 2 m tall from its root: a box 0.2 × 2 × 0.2, its foot at the origin. */
function post(): MeshAsset {
  const positions: number[] = [];
  const indices: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = [0, 1, 2].map((k) => 0.5 * (n[k]! + a * u[k]! + b * v[k]!));
      positions.push(p[0]! * 0.2, (p[1]! + 0.5) * 2, p[2]! * 0.2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name: "post",
    primitives: [
      {
        positions: Float32Array.from(positions),
        normals: null,
        uvs: new Float32Array((positions.length / 3) * 2),
        indices: Uint32Array.from(indices),
        material: { name: "post", baseColorFactor: [0.9, 0.9, 0.9, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6 },
      },
    ],
  } as unknown as MeshAsset;
}

const W = 128;
const H = 64;

/** The covered pixels' mean column in each half of the frame. */
function centroids(frame: Float32Array): [number, number] {
  const sum = [0, 0];
  const n = [0, 0];
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      if (frame[(y * W + x) * 4 + 3]! < 0.5) continue;
      const half = x < W / 2 ? 0 : 1;
      sum[half] += x;
      n[half] += 1;
    }
  return [sum[0]! / n[0]!, sum[1]! / n[1]!];
}

/** Two boxes: a red one on +x, a blue one on −x, so a view says which side it was taken from. */
function twoTone(): MeshAsset {
  const part = (dx: number, colour: [number, number, number, number]) => {
    const p = post().primitives[0]!;
    const positions = Float32Array.from(p.positions, (v, i) => (i % 3 === 0 ? v * 3 + dx : i % 3 === 1 ? v * 0.6 : v * 3));
    return { ...p, positions, material: { ...p.material, name: String(dx), baseColorFactor: colour } };
  };
  return { name: "twoTone", primitives: [part(0.35, [0.9, 0.05, 0.05, 1]), part(-0.35, [0.05, 0.05, 0.9, 1])] } as unknown as MeshAsset;
}

describe("octahedral impostors (F6b)", () => {
  it("maps directions to the octahedral map and back", () => {
    for (let j = 0; j < 8; j += 1)
      for (let i = 0; i < 8; i += 1) {
        const [u, v] = octahedralUv(octahedralDirection((i + 0.5) / 8, (j + 0.5) / 8));
        expect(u).toBeCloseTo((i + 0.5) / 8, 5);
        expect(v).toBeCloseTo((j + 0.5) / 8, 5);
      }
    expect(octahedralDirection(0.5, 0.5)[1]).toBeCloseTo(1, 5); // the centre: straight up
    expect(octahedralDirection(0, 0)[1]).toBeCloseTo(-1, 5); // a corner: straight down
  });

  it("bakes a mesh's views into one square atlas on a quad", () => {
    const baked = bakeOctahedralImpostor(twoTone(), [null, null], 8, 16)!;
    expect(baked.atlas.width).toBe(128);
    expect(baked.atlas.height).toBe(128);
    const p = baked.mesh.primitives[0]!;
    expect(p.indices.length).toBe(6);
    expect(p.material.octahedral?.frames).toBe(8);
    // Some of every view is covered, none wholly.
    let covered = 0;
    for (let i = 3; i < baked.atlas.data.length; i += 4) if (baked.atlas.data[i]! > 128) covered += 1;
    expect(covered).toBeGreaterThan(128 * 128 * 0.1);
    expect(covered).toBeLessThan(128 * 128 * 0.9);
  });
});

describe.skipIf(!device)("foliage a copy at a time on a real device", { timeout: 300_000 }, () => {
  it("shows an octahedral impostor's view from the eye's side, about where the mesh stands", async () => {
    const mesh = twoTone();
    const baked = bakeOctahedralImpostor(mesh, [null, null], 8, 32)!;
    const impostor = [{ mesh: baked.mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [baked.atlas] }] as unknown as MeshSceneInstance[];
    const real = [{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const look = async (instances: MeshSceneInstance[], eye: [number, number, number]) => {
      const draw = { width: W, height: H, view: viewMatrix(eye, [0, 1, 0]), projection: projectionMatrix(Math.PI / 4, W / H, 0.1, 50), environment: null, lights: [], ambient: 1, lightDirection: [0.3, 1, 0.6] } as any;
      const frame = (await readLinearTexture(device, renderer.renderToTexture(instances, draw), W, H, settled)).data;
      let red = 0, blue = 0, covered = 0;
      for (let p = 0; p < W * H; p += 1) {
        if (frame[p * 4 + 3]! < 0.5) continue;
        covered += 1;
        if (frame[p * 4]! > frame[p * 4 + 2]!) red += 1;
        else blue += 1;
      }
      return { red, blue, covered };
    };
    device.pushErrorScope("validation");
    // From +x the red half is nearer: it covers the blue one. From −x, the other way.
    const fromRed = await look(impostor, [7, 1.2, 0.3]);
    const fromBlue = await look(impostor, [-7, 1.2, -0.3]);
    const failure = await settled(device.popErrorScope());
    expect(failure ? String((failure as any).message) : null).toBeNull();
    expect(fromRed.red).toBeGreaterThan(fromRed.blue * 3);
    expect(fromBlue.blue).toBeGreaterThan(fromBlue.red * 3);
    // About the mesh's own size on screen.
    const realRed = await look(real, [7, 1.2, 0.3]);
    expect(fromRed.covered).toBeGreaterThan(realRed.covered * 0.7);
    expect(fromRed.covered).toBeLessThan(realRed.covered * 1.3);
    renderer.dispose();
  });

  it("bends each copy with the wind in the world, however it is turned", async () => {
    const mesh = foliageInstanceMesh({ wind: 3 }, post());
    // Two copies, one turned a quarter: a bend in the mesh's own space would lean them different ways.
    const instances = [
      { mesh, model: composeModelMatrix([-1.5, 0, 0], [0, 0, 0], [1, 1, 1]) },
      { mesh, model: composeModelMatrix([1.5, 0, 0], [0, 90, 0], [1, 1, 1]) },
    ] as unknown as MeshSceneInstance[];
    const draw = (wind: object | null) =>
      ({ width: W, height: H, view: viewMatrix([0, 1, 6], [0, 1, 0]), projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 50), environment: null, lights: [], ambient: 1, lightDirection: [0.3, 1, 0.6], time: 0.01, ...(wind ? { wind } : {}) }) as any;
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const still = centroids((await readLinearTexture(device, renderer.renderToTexture(instances, draw(null)), W, H, settled)).data);
    // A wind along the world's +x.
    const blown = centroids((await readLinearTexture(device, renderer.renderToTexture(instances, draw({ direction: 0, strength: 1, gust: 0 })), W, H, settled)).data);
    const failure = await settled(device.popErrorScope());
    expect(failure ? String((failure as any).message) : null).toBeNull();
    // Both lean right on screen (+x).
    const shift = [blown[0] - still[0], blown[1] - still[1]];
    expect(shift[0]).toBeGreaterThan(0.5);
    expect(shift[1]).toBeGreaterThan(0.5);
    // And the turned copy leans as an unturned one standing where it does: its turn changes nothing (a square post).
    const straight = [instances[0]!, { ...instances[1]!, model: composeModelMatrix([1.5, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    const stillStraight = centroids((await readLinearTexture(device, renderer.renderToTexture(straight, draw(null)), W, H, settled)).data);
    const blownStraight = centroids((await readLinearTexture(device, renderer.renderToTexture(straight, draw({ direction: 0, strength: 1, gust: 0 })), W, H, settled)).data);
    expect(Math.abs(blownStraight[1] - stillStraight[1] - shift[1]!)).toBeLessThan(0.75);
    renderer.dispose();
  });
});
