/**
 * Reflection probes (HALO2_STYLE_ROADMAP.md, H2): the authored model on the
 * lighting rig, the load-time bake (six cube faces → an equirect strip), the
 * box-projected sampling every renderer shares, the software rasteriser using
 * it, the GPU packing, the player baking probes after load, and Lockout's set.
 */

import { describe, expect, it } from "vitest";

import {
  LOCKOUT_LIGHTING,
  MAX_REFLECTION_PROBES,
  PROBE_FADE,
  PROBE_RANGE,
  bakePanorama,
  bakeReflectionProbes,
  bakeReflectionProbesAsync,
  boxProject,
  composeModelMatrix,
  defaultSceneLighting,
  parseReflectionProbes,
  parseSceneLighting,
  pickProbe,
  probeWeight,
  projectionMatrix,
  reflectionProbeAt,
  renderMeshScene,
  sampleProbe,
  setSceneProbes,
  viewMatrix,
  type EnvironmentLight,
  type MeshAsset,
  type ProbeBox,
  type ReflectionProbeSet,
} from "@cartbox/editor";
import { MeshOverlaySurface, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { PROBE_FLOATS, UNIFORM_FLOATS, packProbes, writeInstanceUniform } from "../packages/player/src/render/scenePacking";

type Material = MeshAsset["primitives"][number]["material"];
const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
const SKY: EnvironmentLight = { sky: [0.2, 0.3, 0.8], horizon: [0.2, 0.3, 0.8], ground: [0.2, 0.3, 0.8], intensity: 1 };

/** A quad facing -X at x = `x`, spanning y and z in ±`half`, in one flat colour. */
function wall(x: number, half: number, color: [number, number, number]): MeshAsset {
  const material: Material = { name: "wall", baseColorFactor: [...color, 1], baseColorImage: null, emissiveFactor: color, metallicFactor: 0, roughnessFactor: 1 };
  return {
    name: "wall",
    primitives: [
      {
        positions: Float32Array.from([x, -half, -half, x, half, -half, x, half, half, x, -half, half]),
        normals: Float32Array.from([-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      },
    ],
  };
}

const box = (min: [number, number, number], max: [number, number, number], position: [number, number, number] = [0, 0, 0]): ProbeBox => ({
  min,
  max,
  position,
  average: [0.5, 0.5, 0.5],
});

describe("probe model", () => {
  it("reads authored probes defensively", () => {
    const probes = parseReflectionProbes([
      { name: "room", position: [9, 1, 0], min: [2, 3, 2], max: [-2, 0, -2] }, // corners swapped, capture outside
      { min: [0, 0, 0], max: [0, 0, 0] }, // degenerate: grown to 0.1
      { min: [0, 0], max: [1, 1, 1] }, // malformed: dropped
      "nope",
    ]);
    expect(probes).toHaveLength(2);
    expect(probes[0]).toEqual({ name: "room", position: [2, 1, 0], min: [-2, 0, -2], max: [2, 3, 2] });
    expect(probes[1]!.max[0] - probes[1]!.min[0]).toBeCloseTo(0.1, 6);
    expect(probes[1]!.name).toBe("probe 2");
    expect(parseReflectionProbes(Array.from({ length: 20 }, () => ({ min: [0, 0, 0], max: [1, 1, 1] })))).toHaveLength(MAX_REFLECTION_PROBES);
    expect(parseReflectionProbes(null)).toEqual([]);
  });

  it("lives on the lighting rig: parsed, round-tripped, and cleared", () => {
    const probe = reflectionProbeAt([1, 2, 3], [4, 2, 6], "hall");
    expect(probe.min).toEqual([-1, 1, 0]);
    expect(probe.max).toEqual([3, 3, 6]);
    const lit = setSceneProbes(defaultSceneLighting(), [probe]);
    expect(parseSceneLighting(JSON.parse(JSON.stringify(lit)))!.probes).toEqual([probe]);
    const cleared = setSceneProbes(lit, []);
    expect("probes" in cleared).toBe(false);
    expect(parseSceneLighting(JSON.parse(JSON.stringify(defaultSceneLighting())))!.probes).toBeUndefined();
  });
});

describe("probe sampling", () => {
  it("fades a probe in from its box's faces", () => {
    const b = box([-4, -4, -4], [4, 4, 4]);
    expect(probeWeight(b, 0, 0, 0)).toBe(1);
    expect(probeWeight(b, 4 - PROBE_FADE / 2, 0, 0)).toBeCloseTo(0.5, 6);
    expect(probeWeight(b, 5, 0, 0)).toBe(0);
  });

  it("picks the first (smallest) box that holds the point", () => {
    const set: ReflectionProbeSet = { atlas: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) }, probes: [box([0, 0, 0], [2, 2, 2]), box([-10, -10, -10], [10, 10, 10])] };
    expect(pickProbe(set, 1, 1, 1)!.index).toBe(0);
    expect(pickProbe(set, 5, 5, 5)!.index).toBe(1);
    expect(pickProbe(set, 50, 0, 0)).toBeNull();
  });

  it("box-projects: a ray from off-centre lands on the wall, seen from the capture point", () => {
    const b = box([-5, -5, -5], [5, 5, 5], [0, 0, 0]);
    // From the capture point itself nothing changes direction.
    const [dx, dy, dz] = boxProject(b, 0, 0, 0, 1, 0, 0);
    expect(dy).toBeCloseTo(0, 6);
    expect(dz).toBeCloseTo(0, 6);
    expect(dx).toBeGreaterThan(0);
    // From near the +Z wall looking +X, the hit is at (5, 0, 4): up and to the side of the capture point.
    expect(boxProject(b, 0, 0, 4, 1, 0, 0)).toEqual([5, 0, 4]);
  });

  it("reads probe i's strip of the atlas, scaled to radiance", () => {
    const w = 8;
    const h = 4;
    const data = new Uint8ClampedArray(w * h * 2 * 4);
    for (let i = 0; i < w * h; i += 1) data.set([255, 0, 0, 255], i * 4); // probe 0: red
    for (let i = w * h; i < w * h * 2; i += 1) data.set([0, 255, 0, 255], i * 4); // probe 1: green
    const set: ReflectionProbeSet = { atlas: { width: w, height: h * 2, data }, probes: [box([0, 0, 0], [1, 1, 1]), box([0, 0, 0], [2, 2, 2])] };
    expect(sampleProbe(set, 0, 0, -1, 0)).toEqual([PROBE_RANGE, 0, 0]); // straight down: still probe 0's rows
    expect(sampleProbe(set, 1, 0, 1, 0)).toEqual([0, PROBE_RANGE, 0]);
  });
});

describe("probe bake", () => {
  const scene = [{ mesh: wall(3, 3, [1, 0, 0]), model: IDENTITY }];

  it("captures the scene around the point, and the sky where nothing is", () => {
    const w = 32;
    const strip = bakePanorama([0, 0, 0], scene, { environment: SKY, ambient: 0.4, lights: [] }, w);
    const at = (dx: number, dy: number, dz: number) => {
      const u = Math.atan2(dz, dx) / (2 * Math.PI) + 0.5;
      const v = Math.acos(dy / Math.hypot(dx, dy, dz)) / Math.PI;
      const o = (Math.min(w / 2 - 1, Math.floor(v * (w / 2))) * w + Math.min(w - 1, Math.floor(u * w))) * 4;
      return [strip[o]!, strip[o + 1]!, strip[o + 2]!];
    };
    const [r, g] = at(1, 0, 0); // the red wall (emissive, so it shows whatever the light)
    expect(r).toBeGreaterThan(g + 50);
    const [sr, , sb] = at(-1, 0, 0); // behind: the blue sky, at 1/range
    expect(sb).toBeGreaterThan(sr + 30);
    expect(sb).toBeLessThanOrEqual(Math.ceil((0.8 / PROBE_RANGE) * 255) + 1);
  });

  it("stacks probes smallest box first, with each one's mean colour", () => {
    const big = reflectionProbeAt([0, 0, 0], [20, 20, 20], "big");
    const small = reflectionProbeAt([0, 0, 0], [2, 2, 2], "small");
    const set = bakeReflectionProbes([big, small], scene, { environment: SKY, lights: [] }, 16)!;
    expect(set.atlas.width).toBe(16);
    expect(set.atlas.height).toBe(16); // two 16×8 strips
    expect(set.probes.map((p) => p.max[0])).toEqual([1, 10]);
    for (const p of set.probes) expect(p.average.every((c) => c > 0 && c <= PROBE_RANGE)).toBe(true);
    expect(bakeReflectionProbes([], scene, {})).toBeNull();
  });

  it("bakes the same set when it pauses between probes", async () => {
    const probes = [reflectionProbeAt([0, 0, 0], [4, 4, 4]), reflectionProbeAt([1, 0, 0], [8, 8, 8])];
    let pauses = 0;
    const later = await bakeReflectionProbesAsync(probes, scene, { environment: SKY, lights: [] }, 16, async () => void (pauses += 1));
    const now = bakeReflectionProbes(probes, scene, { environment: SKY, lights: [] }, 16)!;
    expect(pauses).toBe(1);
    expect(Buffer.from(later!.atlas.data).equals(Buffer.from(now.atlas.data))).toBe(true);
  });
});

describe("rasteriser reflections", () => {
  const SIZE = 32;
  // A mirror-smooth metal floor facing +Y, seen from above at an angle.
  const mirror: MeshAsset = {
    name: "mirror",
    primitives: [
      {
        positions: Float32Array.from([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: null,
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "chrome", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 0 },
      },
    ],
  };
  const render = (environment: EnvironmentLight) => {
    const out = new Uint8ClampedArray(SIZE * SIZE * 4);
    renderMeshScene([{ mesh: mirror, model: IDENTITY }], {
      width: SIZE,
      height: SIZE,
      out,
      depth: new Float32Array(SIZE * SIZE),
      view: viewMatrix([0, 3, 3], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
      lightDirection: [0, -1, 0],
      environment,
    });
    const o = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
    return [out[o]!, out[o + 1]!, out[o + 2]!];
  };
  const redProbe = (min: [number, number, number], max: [number, number, number]): ReflectionProbeSet => {
    const data = new Uint8ClampedArray(8 * 4 * 4);
    for (let i = 0; i < 32; i += 1) data.set([200, 0, 0, 255], i * 4);
    return { atlas: { width: 8, height: 4, data }, probes: [{ min, max, position: [0, 1, 0], average: [1.5, 0, 0] }] };
  };

  it("reflects a probe's room instead of the sky inside its box", () => {
    const [sr, , sb] = render(SKY);
    expect(sb).toBeGreaterThan(sr); // the blue sky
    const [pr, , pb] = render({ ...SKY, probes: redProbe([-5, -1, -5], [5, 4, 5]) });
    expect(pr).toBeGreaterThan(pb + 50); // the red room
  });

  it("leaves surfaces outside every probe box on the sky", () => {
    expect(render({ ...SKY, probes: redProbe([20, 20, 20], [30, 30, 30]) })).toEqual(render(SKY));
  });
});

describe("GPU packing", () => {
  it("packs each probe's box, capture point and mean colour, at least one slot", () => {
    expect(packProbes(null)).toHaveLength(PROBE_FLOATS);
    const packed = packProbes({
      atlas: { width: 8, height: 8, data: new Uint8ClampedArray(256) },
      probes: [
        { min: [1, 2, 3], max: [4, 5, 6], position: [2, 3, 4], average: [0.1, 0.2, 0.3] },
        { min: [-1, -1, -1], max: [1, 1, 1], position: [0, 0, 0], average: [1, 1, 1] },
      ],
    });
    expect(packed).toHaveLength(2 * PROBE_FLOATS);
    expect(Array.from(packed.subarray(0, 16)).map((v) => +v.toFixed(3))).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 2, 3, 4, 0, 0.1, 0.2, 0.3, 0]);
  });

  it("puts the probe count in the uniform's ssaoMeta.w", () => {
    const data = new Float32Array(UNIFORM_FLOATS);
    const uniform = (environment: EnvironmentLight | null) => ({
      mvp: IDENTITY,
      normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      baseColor: [1, 1, 1, 1] as const,
      hasTexture: false,
      light: { direction: [0, 1, 0] as const, ambient: 0.3 },
      viewDir: [0, 0, 1] as const,
      pbr: { metallic: 1, roughness: 0, isPbr: true, emissive: [0, 0, 0] as const },
      hasMrMap: false,
      hasOcclusionMap: false,
      hasEmissiveMap: false,
      environment,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: IDENTITY,
      lightCount: 0,
    });
    writeInstanceUniform(data, 0, uniform({ ...SKY, probes: { atlas: { width: 8, height: 8, data: new Uint8ClampedArray(256) }, probes: [box([0, 0, 0], [1, 1, 1]), box([0, 0, 0], [2, 2, 2])] } }));
    expect(data[368 / 4 + 3]).toBe(2);
    writeInstanceUniform(data, 0, uniform(SKY));
    expect(data[368 / 4 + 3]).toBe(0);
  });
});

describe("player", () => {
  it("bakes a scene's probes after it loads and draws with them", async () => {
    const lighting = setSceneProbes(defaultSceneLighting(), [reflectionProbeAt([0, 0, 0], [8, 8, 8], "room")]);
    const draws: SceneDraw[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (_instances, draw) => void draws.push(draw), dispose: () => {} };
    const scene = {
      instances: [{ mesh: wall(3, 3, [1, 0, 0]), model: IDENTITY }],
      bounds: { min: [-3, -3, -3] as [number, number, number], max: [3, 3, 3] as [number, number, number], center: [0, 0, 0] as [number, number, number], radius: 5 },
      lighting,
    };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene as never, renderer);
    await surface.probesReady;
    surface.blit(new Uint8Array(16 * 16 * 4));
    const probes = draws.at(-1)!.environment?.probes;
    expect(probes?.probes).toHaveLength(1);
    expect(probes?.atlas.width).toBeGreaterThan(0);
  });
});

describe("Lockout", () => {
  it("places probes in bottom mid, on the walkway, in both towers and over the arena", () => {
    const probes = LOCKOUT_LIGHTING.probes!;
    expect(probes.map((p) => p.name)).toEqual(["bottom mid", "walkway", "sniper tower", "BR tower", "arena"]);
    // Each is well-formed as authored (the parser changes nothing).
    expect(parseReflectionProbes(JSON.parse(JSON.stringify(probes)))).toEqual(probes);
    // The rooms are smaller than the arena-wide fallback, so they win inside it.
    const volume = (p: (typeof probes)[number]) => (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]) * (p.max[2] - p.min[2]);
    for (const p of probes.slice(0, 4)) expect(volume(p)).toBeLessThan(volume(probes[4]!));
  });
});
