/**
 * Volumetric fog and sun shafts (HALO2_STYLE_ROADMAP.md, H7): the height-fog
 * integral and box spans, the fog mix (distance fog unchanged), the rasteriser
 * and uniform packing, the lighting rig's parsing, the sun-shaft pass and the
 * overlay that runs it, and Lockout's chasm mist.
 */

import { describe, expect, it } from "vitest";

import {
  applyFog,
  applySunShafts,
  composeModelMatrix,
  defaultSunShafts,
  defaultSceneLighting,
  fogBoxSpan,
  fogFactor,
  fogIsVolumetric,
  fogLayerDepth,
  fogVolumeAmount,
  lockoutMeshSidecar,
  parseFog,
  parseSceneLighting,
  parseShafts,
  projectionMatrix,
  renderMeshScene,
  serializeMeshAsset,
  setSceneShafts,
  sunScreenPosition,
  viewMatrix,
  LOCKOUT_LIGHTING,
  MAX_FOG_VOLUMES,
  type MeshAsset,
  type SceneFog,
} from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";
import { UNIFORM_FLOATS, writeInstanceUniform } from "../packages/player/src/render/scenePacking";

const base: SceneFog = { color: [0.8, 0.8, 0.8], density: 0, start: 0, max: 0 };

/** Numerically integrate the layer density d·e^(−k·max(0, y − base)) along a ray. */
function numeric(d: number, k: number, b: number, cy: number, dy: number, len: number, t0: number, t1: number): number {
  const n = 20000;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const t = t0 + ((i + 0.5) / n) * (t1 - t0);
    sum += d * Math.exp(-k * Math.max(0, cy + dy * t - b));
  }
  return (sum / n) * (t1 - t0) * len;
}

describe("fog maths", () => {
  it("integrates the height layer exactly, above, below and across its base", () => {
    const cases: [number, number, number, number, number, number, number, number][] = [
      [0.2, 0.5, 0, 5, 3, 10, 0, 1], // entirely above
      [0.2, 0.5, 0, -5, -2, 8, 0, 1], // entirely below: even
      [0.3, 0.8, 1, 4, -8, 12, 0, 1], // crossing downward
      [0.3, 0.8, 1, -3, 9, 12, 0.2, 0.9], // crossing upward, clipped
      [0.1, 0, 0, 2, 5, 7, 0, 1], // no falloff: even
      [0.4, 1.2, -2, 3, 0, 6, 0, 1], // level ray
    ];
    for (const c of cases) expect(fogLayerDepth(...c)).toBeCloseTo(numeric(...c), 3);
    expect(fogLayerDepth(0, 1, 0, 0, 1, 1, 0, 1)).toBe(0);
    expect(fogLayerDepth(1, 1, 0, 0, 1, 1, 0.6, 0.4)).toBe(0);
  });

  it("finds where a segment passes through a box", () => {
    const span = fogBoxSpan([-1, -1, -1], [1, 1, 1], -3, 0, 0, 6, 0, 0)!;
    expect(span[0]).toBeCloseTo(2 / 6);
    expect(span[1]).toBeCloseTo(4 / 6);
    expect(fogBoxSpan([-1, -1, -1], [1, 1, 1], -3, 2, 0, 6, 0, 0)).toBeNull(); // passes above
    expect(fogBoxSpan([-1, -1, -1], [1, 1, 1], -3, 0, 0, 1, 0, 0)).toBeNull(); // stops short
    expect(fogBoxSpan([-1, -1, -1], [1, 1, 1], 0, 0, 0, 5, 0, 0)![0]).toBe(0); // starts inside
  });

  it("leaves distance-only fog exactly the old mix, and thickens with height fog and volumes", () => {
    const fog: SceneFog = { color: [0.9, 0.9, 0.9], density: 0.05, start: 2, max: 0.6 };
    expect(fogIsVolumetric(fog)).toBe(false);
    const px = [40, 80, 120, 255];
    applyFog(fog, px, 0, 12, [0, 0, 0], [0, 0, -12], [0, 1, 0]);
    const f = fogFactor(fog, 12);
    expect(px[0]).toBeCloseTo(40 + (0.9 * 255 - 40) * f, 6);
    expect(px[2]).toBeCloseTo(120 + (0.9 * 255 - 120) * f, 6);

    const low: SceneFog = { ...base, height: { base: 0, density: 0.3, falloff: 1 } };
    // A point down in the fog is fogged more than one the same distance up out of it.
    expect(fogVolumeAmount(low, [0, 2, 0], [0, -4, -6])).toBeGreaterThan(fogVolumeAmount(low, [0, 2, 0], [0, 8, -6]) + 0.3);
    const box: SceneFog = { ...base, volumes: [{ min: [-5, -5, -20], max: [5, 0, -10], density: 0.5, falloff: 0 }] };
    expect(fogVolumeAmount(box, [0, 1, 0], [0, -2, -15])).toBeGreaterThan(0.5);
    expect(fogVolumeAmount(box, [0, 1, 0], [0, 1, -15])).toBe(0); // the ray misses the box
  });

  it("brightens the fog toward the sun", () => {
    const fog: SceneFog = { ...base, height: { base: 10, density: 0.5, falloff: 0 }, glow: { color: [1, 0.5, 0], strength: 1 } };
    const toward = [0, 0, 0, 255];
    const away = [0, 0, 0, 255];
    applyFog(fog, toward, 0, 10, [0, 0, 0], [0, 0, -10], [0, 0, -1]);
    applyFog(fog, away, 0, 10, [0, 0, 0], [0, 0, 10], [0, 0, -1]);
    expect(toward[0]).toBeGreaterThan(away[0]! + 40);
    expect(toward[2]).toBeCloseTo(away[2]!, 6); // the glow colour has no blue
  });
});

describe("renderers", () => {
  const floor = (y: number): MeshAsset => ({
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-20, y, 5, 20, y, 5, 20, y, -60, -20, y, -60]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.2, 0.2, 0.2, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  });
  const draw = (fog: SceneFog | null, y: number) => {
    const S = 32;
    const out = new Uint8ClampedArray(S * S * 4);
    renderMeshScene([{ mesh: floor(y), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }], {
      width: S,
      height: S,
      out,
      depth: new Float32Array(S * S),
      view: viewMatrix([0, y + 2, 0], [0, y, -8]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 100),
      background: [0, 0, 0, 255],
      lightDirection: [0, 1, 0],
      ambient: 0.3,
      tonemap: { exposure: 1 },
      fog,
    });
    return out[(24 * S + 16) * 4]!;
  };

  it("fogs a floor down in the height fog, not one up above it", () => {
    const fog: SceneFog = { ...base, height: { base: 0, density: 0.3, falloff: 2 } };
    expect(draw(fog, -6)).toBeGreaterThan(draw(null, -6) + 60);
    expect(Math.abs(draw(fog, 20) - draw(null, 20))).toBeLessThan(3);
  });

  it("packs the eye, height fog, glow and volumes for the GPU after the surface block", () => {
    const data = new Float32Array(UNIFORM_FLOATS);
    const light = { direction: [0, 1, 0] as const, ambient: 0.25 };
    const common = {
      mvp: Array.from({ length: 16 }, (_, i) => i) as never,
      normalBasis: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      baseColor: [0, 0, 0, 0] as const,
      hasTexture: false,
      light,
      viewDir: [0, 0, 1] as const,
      pbr: { isPbr: false, metallic: 1, roughness: 1, emissive: [0, 0, 0] as const },
      hasMrMap: false,
      hasOcclusion: false,
      hasEmissiveMap: false,
      environment: null,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: null,
      lightCount: 0,
    } as const;
    const volumes = Array.from({ length: 5 }, (_, i) => ({ min: [i, 1, 2] as const, max: [i + 3, 4, 5] as const, density: 0.5, falloff: 0.25 }));
    const fog: SceneFog = { color: [0.5, 0.5, 0.5], density: 0.1, start: 1, max: 0.5, height: { base: -2, density: 0.3, falloff: 0.7 }, glow: { color: [1, 0.5, 0.25], strength: 0.8 }, volumes };
    writeInstanceUniform(data, 0, { ...common, fog, eye: [7, 8, 9] });
    expect(data[119]).toBe(1); // fogParams.w: layered fog on
    expect(Array.from(data.subarray(140, 152))).toEqual([7, 8, 9, MAX_FOG_VOLUMES, 0.30000001192092896, -2, 0.699999988079071, 0.800000011920929, 1, 0.5, 0.25, 0]);
    expect(Array.from(data.subarray(152, 160))).toEqual([0, 1, 2, 0.5, 3, 4, 5, 0.25]);
    expect(Array.from(data.subarray(176, 184))).toEqual([3, 1, 2, 0.5, 6, 4, 5, 0.25]); // the fourth volume; the fifth is dropped
    writeInstanceUniform(data, 0, { ...common, fog: { color: [0.5, 0.5, 0.5], density: 0.1, start: 1, max: 0.5 }, eye: [7, 8, 9] });
    expect(data[119]).toBe(0);
    expect(Array.from(data.subarray(143, 184)).every((v) => v === 0)).toBe(true);
  });
});

describe("lighting rig", () => {
  it("reads height fog, volumes, glow and shafts defensively, and older fog unchanged", () => {
    expect(parseFog({ color: [0.5, 0.5, 0.5], density: 0.02, start: 3, max: 0.5 })).toEqual({ color: [0.5, 0.5, 0.5], density: 0.02, start: 3, max: 0.5 });
    const fog = parseFog({
      height: { base: 2, density: 99, falloff: -1 },
      volumes: [{ min: [5, 5, 5], max: [0, 0, 0], density: 0.2 }, { min: [1, 2] }, ...Array.from({ length: 6 }, () => ({ min: [0, 0, 0], max: [1, 1, 1] }))],
      glow: { strength: 7 },
    })!;
    expect(fog.height).toEqual({ base: 2, density: 4, falloff: 0 });
    expect(fog.volumes).toHaveLength(MAX_FOG_VOLUMES);
    expect(fog.volumes![0]).toMatchObject({ min: [0, 0, 0], max: [5, 5, 5], density: 0.2 });
    expect(fog.glow!.strength).toBe(2);
    expect(parseShafts({ strength: -1, length: 9 })).toEqual({ strength: 0, length: 1 });
    expect(parseShafts(null)).toBeNull();

    const rig = setSceneShafts(defaultSceneLighting(), defaultSunShafts());
    const back = parseSceneLighting(JSON.parse(JSON.stringify(rig)))!;
    expect(back.shafts).toEqual(defaultSunShafts());
    expect("shafts" in setSceneShafts(back, null)).toBe(false);
  });
});

describe("sun shafts", () => {
  const view = viewMatrix([0, 0, 0], [0, 0, -1]);
  const projection = projectionMatrix(Math.PI / 2, 1, 0.1, 100);

  it("puts the sun on screen, or nowhere when it is behind", () => {
    const mid = sunScreenPosition([0, 0, -1], view, projection, 100, 100)!;
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(50);
    expect(sunScreenPosition([0, 1, -1], view, projection, 100, 100)!.y).toBeLessThan(10);
    expect(sunScreenPosition([0, 0, 1], view, projection, 100, 100)).toBeNull();
  });

  it("streams light from the sun past a wall's edge, and none when the sun is covered", () => {
    const W = 80;
    const H = 60;
    const sky = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i += 1) sky.set([235, 240, 250, 255], i * 4);
    // A dark wall over the right half of the frame, the sun just left of its edge.
    const scene = () => {
      const f = sky.slice();
      for (let y = 0; y < H; y += 1) for (let x = 40; x < W; x += 1) f.set([20, 20, 30, 255], (y * W + x) * 4);
      return f;
    };
    const frame = scene();
    applySunShafts(frame, sky, W, H, { x: 36, y: 20 }, [1, 0.9, 0.7], { strength: 1, length: 0.8 });
    const at = (f: Uint8ClampedArray, x: number, y: number) => f[(y * W + x) * 4]!;
    // The wall near the sun is lit by the beams; far away it is not.
    expect(at(frame, 44, 22)).toBeGreaterThan(20 + 40);
    expect(at(frame, 78, 58)).toBeLessThan(20 + 10);
    // Open sky takes a smaller share than the wall.
    expect(at(frame, 32, 20) - 235).toBeLessThan(at(frame, 44, 22) - 20);
    // With the sun behind the wall and no sky near it, nothing shines.
    const covered = scene();
    applySunShafts(covered, sky, W, H, { x: 70, y: 30 }, [1, 1, 1], { strength: 1, length: 0.3 });
    expect(covered).toEqual(scene());
    // Strength 0 is a no-op.
    const off = scene();
    applySunShafts(off, sky, W, H, { x: 36, y: 20 }, [1, 1, 1], { strength: 0, length: 1 });
    expect(off).toEqual(scene());
  });

  it("runs in the first-person overlay over the sky dome", async () => {
    const cube: MeshAsset = {
      name: "cube",
      primitives: [
        {
          positions: Float32Array.from([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0]),
          normals: null,
          uvs: null,
          indices: Uint32Array.from([0, 1, 2]),
          material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null },
        },
      ],
    };
    const rig = (sun: [number, number, number], shafts: boolean) =>
      JSON.stringify({
        version: 2,
        meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(cube), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
        lighting: { ...defaultSceneLighting(), sky: { sunDirection: sun, sunColor: [1, 1, 1] }, ...(shafts ? { shafts: { strength: 2, length: 1 } } : {}) },
      });
    // A renderer that blocks the lower half of the frame, and remembers where it looked.
    let look: readonly number[] = [];
    const renderer: SceneRenderer = {
      backend: "software",
      render: (_i, d: SceneDraw) => {
        look = d.view;
        for (let y = d.height / 2; y < d.height; y += 1) for (let x = 0; x < d.width; x += 1) d.out.set([10, 10, 10, 255], (y * d.width + x) * 4);
      },
      dispose: () => {},
    };
    const run = async (json: string) => {
      let shown = new Uint8Array(0);
      const surface = await MeshOverlaySurface.create({ blit: (px) => void (shown = px.slice()), destroy() {} }, 48, 32, parseMeshScene(json)!, renderer);
      surface.setHudMode(true);
      surface.blit(new Uint8Array(48 * 32 * 4));
      return shown;
    };
    await run(rig([0, 1, 0], false));
    // Put the sun straight ahead, on the horizon between sky and "ground".
    const ahead: [number, number, number] = [-look[2]!, -look[6]!, -look[10]!];
    const plain = await run(rig(ahead, false));
    const lit = await run(rig(ahead, true));
    let brighter = 0;
    for (let i = 0; i < plain.length; i += 4) if (lit[i]! > plain[i]! + 8) brighter += 1;
    expect(brighter).toBeGreaterThan(20);
  });
});

describe("Lockout", () => {
  it("pools mist in the chasm under the deck, glows toward the sun and casts shafts", () => {
    const fog = LOCKOUT_LIGHTING.fog!;
    const mist = fog.volumes![0]!;
    expect(mist.max[1]).toBeLessThan(0); // under the deck
    expect(mist.min[1]).toBeLessThan(-30);
    expect(fog.glow!.strength).toBeGreaterThan(0);
    expect(LOCKOUT_LIGHTING.shafts!.strength).toBeGreaterThan(0);
    // Looking straight down over the edge the chasm floor is lost in the mist;
    // across the deck it is clear.
    expect(fogVolumeAmount(fog, [-14, 3, 2], [-40, -95, 10])).toBeGreaterThan(0.9);
    expect(fogVolumeAmount(fog, [-14, 3, 2], [10, 0.5, -5])).toBe(0);
    // The shipped sidecar carries all of it through the player's parse.
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    expect(scene.lighting!.fog!.volumes).toHaveLength(1);
    expect(scene.lighting!.shafts).toEqual(LOCKOUT_LIGHTING.shafts);
  });
});
