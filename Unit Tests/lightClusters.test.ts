/**
 * Spot lights and clustered light culling (ENGINE_PARITY_ROADMAP.md EP8): the
 * cone, its stored and packed forms, and the cells — above all that a cell
 * never leaves out a light that reaches a point inside it, which is what lets
 * the GPU shade only its cell's list and still match the software rasteriser.
 */

import { describe, expect, it } from "vitest";

import {
  CLUSTER_X,
  CLUSTER_Y,
  buildLightClusters,
  clusterSlice,
  clusterTile,
  composeModelMatrix,
  orderLights,
  orthographicMatrix,
  parseSceneLighting,
  projectionMatrix,
  renderMeshScene,
  spotCone,
  viewMatrix,
  type MeshAsset,
  type SceneLight,
} from "@cartbox/editor";

import { LIGHT_FLOATS, packLights } from "../packages/player/src/render/scenePacking";
import { manyLights } from "./helpers/manyLights";

const W = 320;
const H = 180;
const eye = [0, 4, 7] as const;
const view = viewMatrix(eye, [0, 0, 0]);
const projection = projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100);

describe("ordering", () => {
  it("puts the global lights (sun, unranged) first, then the clustered ones", () => {
    const lights: SceneLight[] = [
      { kind: "point", position: [0, 0, 0], color: [1, 1, 1], intensity: 1, range: 2 },
      { kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1 },
      { kind: "point", position: [0, 0, 0], color: [1, 1, 1], intensity: 1, range: 0 },
      { kind: "spot", position: [0, 0, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 1, range: 3 },
    ];
    const { ordered, globalCount } = orderLights(lights);
    expect(globalCount).toBe(2);
    expect(ordered.map((l) => [l.kind, l.range ?? null])).toEqual([
      ["directional", null],
      ["point", 0],
      ["point", 2],
      ["spot", 3],
    ]);
  });
});

describe("cells", () => {
  const { ordered, globalCount } = orderLights(manyLights());
  const clusters = buildLightClusters(ordered, globalCount, view, projection, W, H)!;

  it("lists, in a point's cell, every light that reaches the point", () => {
    // Sample points all through the frustum; any light whose range covers one must be in its cell.
    let checked = 0;
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let s = 0; s < 4000; s += 1) {
      const px = rand() * W;
      const py = rand() * H;
      const depth = 0.2 + rand() * 12;
      const ndcX = (px / W) * 2 - 1;
      const ndcY = 1 - (py / H) * 2;
      const vx = (ndcX * depth) / projection[0]!;
      const vy = (ndcY * depth) / projection[5]!;
      const vz = -depth;
      // View space back to world: the view is a rotation and a translation, so world = Rᵀ(v − t).
      const m = view;
      const tx = vx - m[12]!;
      const ty = vy - m[13]!;
      const tz = vz - m[14]!;
      const wx = m[0]! * tx + m[1]! * ty + m[2]! * tz;
      const wy = m[4]! * tx + m[5]! * ty + m[6]! * tz;
      const wz = m[8]! * tx + m[9]! * ty + m[10]! * tz;
      const [cx, cy] = clusterTile(clusters.params, px, py);
      const k = clusterSlice(clusters.params, depth);
      if (k < 0) continue;
      const cell = (k * CLUSTER_Y + cy) * CLUSTER_X + cx;
      const list = new Set(Array.from(clusters.indices.subarray(clusters.table[cell * 2]!, clusters.table[cell * 2]! + clusters.table[cell * 2 + 1]!)));
      for (let li = globalCount; li < ordered.length; li += 1) {
        const l = ordered[li]!;
        const p = l.position!;
        if (Math.hypot(p[0] - wx, p[1] - wy, p[2] - wz) < l.range!) {
          expect(list.has(li), `light ${li} at sample ${s}`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(500); // the test really exercised the lists
    expect(clusters.overflow).toBe(false);
  });

  it("keeps lists short: a cell holds far fewer than all the lights", () => {
    let total = 0;
    let busy = 0;
    for (let cell = 0; cell < clusters.table.length / 2; cell += 1) {
      const n = clusters.table[cell * 2 + 1]!;
      total += n;
      if (n > 0) busy += 1;
    }
    expect(busy).toBeGreaterThan(0);
    expect(total / busy).toBeLessThan((ordered.length - globalCount) / 3);
  });

  it("lists nothing for a light behind the camera or out of reach", () => {
    const behind: SceneLight[] = [{ kind: "point", position: [0, 4, 30], color: [1, 1, 1], intensity: 1, range: 2 }];
    const built = buildLightClusters(behind, 0, view, projection, W, H)!;
    expect(built.used).toBe(0);
  });

  it("has no cells for an orthographic camera (the renderers loop every light then)", () => {
    expect(buildLightClusters(ordered, globalCount, view, orthographicMatrix(-5, 5, -5, 5, 0.1, 50), W, H)).toBeNull();
  });
});

describe("spot lights", () => {
  it("keep their cone through storage, clamped, and pack it for the GPU", () => {
    const lighting = parseSceneLighting({ lights: [{ kind: "spot", position: [1, 2, 3], direction: [0, -1, 0], color: [1, 1, 1], intensity: 2, range: 5, innerAngle: 50, outerAngle: 40 }] })!;
    const spot = lighting.lights[0]!;
    expect(spot).toMatchObject({ kind: "spot", position: [1, 2, 3], direction: [0, -1, 0], range: 5, outerAngle: 40, innerAngle: 40 });
    const [cosOuter, cosInner] = spotCone(spot);
    expect(cosOuter).toBeCloseTo(Math.cos((40 * Math.PI) / 180));
    expect(cosInner).toBeGreaterThan(cosOuter); // never equal: the fade can't divide by zero
    const packed = packLights([spot]);
    expect(packed.length).toBe(LIGHT_FLOATS);
    expect(Array.from(packed.subarray(0, 4))).toEqual([1, 2, 3, 2]);
    expect(packed[9]).toBeCloseTo(cosOuter, 5);
    expect(Array.from(packed.subarray(12, 15))).toEqual([0, -1, 0]);
  });

  it("light the floor inside the cone and leave it dark outside", () => {
    const floor: MeshAsset = {
      name: "floor",
      primitives: [
        {
          positions: Float32Array.from([-6, 0, -6, 6, 0, -6, 6, 0, 6, -6, 0, 6]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
        },
      ],
    };
    const S = 64;
    const out = new Uint8ClampedArray(S * S * 4);
    renderMeshScene([{ mesh: floor, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }], {
      width: S,
      height: S,
      out,
      depth: new Float32Array(S * S),
      view: viewMatrix([0, 8, 0.01], [0, 0, 0]),
      projection: projectionMatrix((70 * Math.PI) / 180, 1, 0.1, 50),
      ambient: 0,
      background: [0, 0, 0, 255],
      lights: [{ kind: "spot", position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 3, range: 10, innerAngle: 10, outerAngle: 20 }],
    });
    const at = (x: number, y: number) => out[(y * S + x) * 4]!;
    expect(at(32, 32)).toBeGreaterThan(100); // under the beam
    expect(at(4, 4)).toBe(0); // far outside the cone
  });
});
