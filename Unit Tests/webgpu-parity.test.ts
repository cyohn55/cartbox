/**
 * WebGPU parity against the software rasteriser, on a real device.
 *
 * This is the test the rest of the WebGPU suite cannot be: everything else
 * drives the renderer through a recording fake, which proves what the code
 * *asks* of the API but not that a driver accepts it or that the picture
 * matches. Both need an adapter.
 *
 * ## Running it
 *
 * It skips unless `@kmamal/gpu` (Dawn bound into Node) is installed. That is
 * deliberately NOT a devDependency: it is a ~100MB native binary, and making
 * every `npm install` pay for it to run one suite is a bad trade. To run:
 *
 * ```
 * npm i --no-save @kmamal/gpu@0.2.0
 * npx vitest run "Unit Tests/webgpu-parity.test.ts"
 * ```
 *
 * Pin 0.2.0. In 0.2.1 `texture.createView()` passes a swizzle field Dawn
 * rejects without `TextureComponentSwizzle`, so every view fails validation —
 * reproducible in four lines with no Cartbox code involved, and nothing to do
 * with this renderer.
 *
 * On a machine with no GPU this still works: install Mesa's software Vulkan
 * (`mesa-vulkan-drivers`, which provides the lavapipe ICD) and Dawn will find
 * it. That is how this was first verified.
 *
 * ## What passing means
 *
 * Byte-identical output is the contract (see `WebgpuSceneRenderer`): a cart
 * must not look different depending on whether the viewer's browser has
 * WebGPU. So this asserts zero difference, not a tolerance.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  computeEnvironmentAverage,
  computeSsao,
  orthographicMatrix,
  projectionMatrix,
  renderGeometryBuffers,
  renderShadowMap,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { SoftwareSceneRenderer, WebgpuSceneRenderer, type SceneDraw } from "@cartbox/player";

import { graphInstances } from "./helpers/graphScenes";
import { LAYER_ENVIRONMENT, LAYER_LIGHTS, layerInstances } from "./helpers/layerScenes";
import { localShadowRig } from "./helpers/localShadowScene";
import { manyLights } from "./helpers/manyLights";
import { probeRig } from "./helpers/probeScene";
import { expectTemporal, temporalReport, type GpuRenderer } from "./helpers/temporalScene";
import { expectReflections, reflectionReport } from "./helpers/reflectionScene";


const W = 64;
const H = 48;

/** Resolve a real device, or null when this machine cannot provide one. */
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

function quad(): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.9, 0.4, 0.2, 1], baseColorImage: null },
      },
    ],
  };
}

/** Distinct texels, so a wrong UV flip or wrap shows as a mismatch. */
function testTexture(): DecodedTexture {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) {
    data[i * 4] = (i * 17) & 255;
    data[i * 4 + 1] = (255 - i * 13) & 255;
    data[i * 4 + 2] = (i * 31) & 255;
    data[i * 4 + 3] = 255;
  }
  return { width: 4, height: 4, data };
}

/** Angled, overlapping, textured and untextured — several dynamic offsets. */
function scene(): MeshSceneInstance[] {
  const texture = testTexture();
  return [
    { mesh: quad(), model: composeModelMatrix([0, 0, 0], [0, 30, 0], [1.4, 1.4, 1.4]), textures: null },
    { mesh: quad(), model: composeModelMatrix([0.8, 0.3, -0.6], [15, -40, 0], [0.9, 0.9, 0.9]), textures: null },
    { mesh: quad(), model: composeModelMatrix([-0.9, -0.2, 0.5], [-20, 55, 10], [0.8, 0.8, 0.8]), textures: [texture] },
    { mesh: quad(), model: composeModelMatrix([0.2, -0.7, 0.9], [40, 10, -25], [0.6, 0.6, 0.6]), textures: [texture] },
  ];
}

/** A metallic-roughness quad — carries a metallic + roughness factor so the
 *  Modern-tier BRDF branch runs on both backends. */
function pbrQuad(metallic: number, roughness: number): MeshAsset {
  const mesh = quad();
  return {
    ...mesh,
    primitives: [{ ...mesh.primitives[0]!, material: { ...mesh.primitives[0]!.material, metallicFactor: metallic, roughnessFactor: roughness } }],
  };
}

/** A scene of PBR spheres-as-quads spanning the metallic/roughness space. */
function pbrScene(): MeshSceneInstance[] {
  return [
    { mesh: pbrQuad(1, 0.15), model: composeModelMatrix([-0.9, 0, 0], [0, 15, 0], [1.1, 1.1, 1.1]) },
    { mesh: pbrQuad(0, 0.8), model: composeModelMatrix([0.9, 0, 0], [0, -15, 0], [1.1, 1.1, 1.1]) },
  ];
}

/** A horizontal PBR floor (normal +Y) of half-extent `h` at height `y`. */
function pbrFloor(h: number, y: number): MeshAsset {
  return {
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-h, y, -h, h, y, -h, h, y, h, -h, y, h]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  };
}

/** A floor with an occluder above it, so a directional shadow is cast. */
function shadowScene(): MeshSceneInstance[] {
  return [
    { mesh: pbrFloor(5, 0), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
    { mesh: pbrFloor(1.2, 3), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
  ];
}

function draw(): SceneDraw {
  return {
    width: W,
    height: H,
    out: new Uint8ClampedArray(W * H * 4),
    depth: new Float32Array(W * H),
    view: viewMatrix([0, 0, 4], [0, 0, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [0, 0, 0, 255],
  };
}

describe.skipIf(!device)("WebGPU parity on a real device", () => {
  it("compiles the shader and builds the pipeline", async () => {
    // A null here means the WGSL failed to compile, the explicit bind group
    // layout was rejected, or a resource could not be allocated — the class of
    // failure no fake device can surface.
    const renderer = await WebgpuSceneRenderer.create(device, W, H);
    expect(renderer).not.toBeNull();
    renderer!.dispose();
  });

  it("renders byte-identically to the software rasteriser", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = scene();

    // Frame one draws on the CPU and submits GPU work; the readback lands
    // asynchronously, so pump the device until a GPU frame is available.
    renderer.render(instances, draw());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = draw();
    renderer.render(instances, gpu);

    const software = draw();
    new SoftwareSceneRenderer().render(instances, software);

    // Guard against two blank frames trivially matching.
    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let differing = 0;
    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      const delta = Math.abs(gpu.out[i]! - software.out[i]!);
      if (delta > 0) {
        differing += 1;
        maxDelta = Math.max(maxDelta, delta);
      }
    }
    expect({ differing, maxDelta }).toEqual({ differing: 0, maxDelta: 0 });

    renderer.dispose();
  });

  it("renders instanced copies byte-identically to the software rasteriser", async () => {
    // Many copies of one mesh, some sharing a texture: the GPU batches them into
    // instanced draws (each copy's transforms from the instance buffer), and the
    // picture must not change for it.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const shared = quad();
    const texture = testTexture();
    const instances: MeshSceneInstance[] = [];
    for (let i = 0; i < 9; i += 1) {
      const x = ((i % 3) - 1) * 1.1;
      const y = (Math.floor(i / 3) - 1) * 0.8;
      instances.push({
        mesh: shared,
        model: composeModelMatrix([x, y, -0.3 * (i % 4)], [10 * i, 20 * (i % 3) - 20, 5 * i], [0.45, 0.45, 0.45]),
        textures: i % 2 === 0 ? [texture] : null,
      });
    }

    renderer.render(instances, draw());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = draw();
    renderer.render(instances, gpu);
    // Two batches (textured and untextured) for nine copies.
    expect(renderer.lastFrameStats).toMatchObject({ drawCalls: 2, instances: 9 });

    const software = draw();
    new SoftwareSceneRenderer().render(instances, software);
    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let differing = 0;
    for (let i = 0; i < W * H * 4; i += 1) if (gpu.out[i] !== software.out[i]) differing += 1;
    expect(differing).toBe(0);

    renderer.dispose();
  });

  it("matches the software rasteriser on the metallic-roughness path (within float tolerance)", async () => {
    // The Modern-tier BRDF cannot be byte-identical — GGX and pow differ between
    // the GPU's float32 and the CPU's float64 — so this is the tolerant twin of
    // the parity test above: same shading, off by at most a few least-significant
    // bits. A large delta means the WGSL diverged from meshRasterizer.ts, not
    // rounding. This is the gate that validates the WGSL PBR branch on hardware.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = pbrScene();

    renderer.render(instances, draw());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = draw();
    renderer.render(instances, gpu);

    const software = draw();
    new SoftwareSceneRenderer().render(instances, software);

    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
    }
    // A few 8-bit levels of rounding is expected; anything larger is a real
    // divergence in the shading maths.
    expect(maxDelta).toBeLessThanOrEqual(4);

    renderer.dispose();
  });

  it("matches the software rasteriser on shield effects — rim, glow, bands and camo (within float tolerance)", async () => {
    // HALO2_STYLE_ROADMAP.md H11: the camo dither must drop the very same pixels
    // (an exact pattern), and the rim, glow and bands shade within rounding.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances: MeshSceneInstance[] = [
      { ...pbrScene()[0]!, effect: { rim: [1.2, 0.9, 0.3], rimPower: 1.5, glow: [0.2, 0.15, 0.05] } },
      { ...pbrScene()[1]!, effect: { bands: [0.8, 0.7, 0.4], camo: 0.5, rim: [0.2, 0.3, 0.5], rimPower: 3 } },
    ];
    const at = (): SceneDraw => ({ ...draw(), time: 0.37 });
    renderer.render(instances, at());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = at();
    renderer.render(instances, gpu);
    const software = at();
    new SoftwareSceneRenderer().render(instances, software);

    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);
    let maxDelta = 0;
    let coverage = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
      if (i % 4 === 3 && (gpu.out[i] === 0) !== (software.out[i] === 0)) coverage += 1;
    }
    expect(coverage).toBe(0);
    expect(maxDelta).toBeLessThanOrEqual(4);
    renderer.dispose();
  });

  it("draws transparency like the software rasteriser: blended, added and cut out (within float tolerance)", async () => {
    // EP6: the opaque wall first, then the see-through surfaces farthest first,
    // blended (premultiplied) and added without writing depth; the cut-out quad
    // drops the same texels. A few levels of rounding from the premultiply are expected.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const half = (() => {
      const data = new Uint8ClampedArray(4 * 4 * 4);
      for (let i = 0; i < 16; i += 1) data.set([255, 255, 255, (i + (i >> 2)) % 2 === 0 ? 255 : 40], i * 4);
      return { width: 4, height: 4, data };
    })();
    const mat = (m: Record<string, unknown>) => {
      const q = quad();
      return { ...q, primitives: [{ ...q.primitives[0]!, material: { ...q.primitives[0]!.material, ...m } }] };
    };
    const instances: MeshSceneInstance[] = [
      { mesh: mat({ metallicFactor: 0, roughnessFactor: 0.8 }), model: composeModelMatrix([0, 0, -1], [0, 0, 0], [2.2, 1.6, 1]) },
      { mesh: mat({ baseColorFactor: [0.2, 0.6, 1, 0.4], metallicFactor: 0, roughnessFactor: 0.2, alphaMode: "blend" }), model: composeModelMatrix([-0.5, 0, 0.3], [0, 20, 0], [0.9, 0.9, 1]) },
      { mesh: mat({ baseColorFactor: [1, 0.3, 0.1, 0.7], alphaMode: "additive" }), model: composeModelMatrix([0.6, 0.2, 0.6], [0, -15, 0], [0.6, 0.6, 1]) },
      { mesh: mat({ baseColorFactor: [0.3, 1, 0.3, 1], alphaMode: "mask", alphaCutoff: 0.5 }), model: composeModelMatrix([0.3, -0.6, 0.2], [0, 0, 0], [0.6, 0.6, 1]), textures: [half] },
    ];
    renderer.render(instances, draw());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = draw();
    renderer.render(instances, gpu);
    const software = draw();
    new SoftwareSceneRenderer().render(instances, software);
    let maxDelta = 0;
    let coverage = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
      if (i % 4 === 3 && (gpu.out[i] === 0) !== (software.out[i] === 0)) coverage += 1;
    }
    expect(coverage).toBe(0);
    expect(maxDelta).toBeLessThanOrEqual(5);
    renderer.dispose();
  });

  it("fades soft see-through edges where they meet the floor, like the software rasteriser", async () => {
    // EP6b: the see-through pass reads the opaque depth (attached read-only)
    // and fades each surface as it nears the floor behind it.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const mat = (m: Record<string, unknown>) => {
      const q = quad();
      return { ...q, primitives: [{ ...q.primitives[0]!, material: { ...q.primitives[0]!.material, ...m } }] };
    };
    const ground = mat({ baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 });
    const instances: MeshSceneInstance[] = [
      { mesh: ground, model: composeModelMatrix([0, 0, 0], [-90, 0, 0], [3, 3, 1]) },
      { mesh: mat({ baseColorFactor: [0.2, 0.6, 1, 0.8], metallicFactor: 0, roughnessFactor: 1, alphaMode: "blend", softDepth: 0.8 }), model: composeModelMatrix([-0.7, 0.4, 0], [0, 10, 0], [0.8, 0.8, 1]) },
      { mesh: mat({ baseColorFactor: [1, 0.4, 0.1, 0.9], alphaMode: "additive", softDepth: 0.5 }), model: composeModelMatrix([0.8, 0.3, 0.5], [0, -20, 0], [0.6, 0.6, 1]) },
    ];
    const lit = () => ({ ...draw(), view: viewMatrix([0, 4, 7], [0, 0, 0]) });
    renderer.render(instances, lit());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = lit();
    renderer.render(instances, gpu);
    const software = lit();
    new SoftwareSceneRenderer().render(instances, software);
    let maxDelta = 0;
    let coverage = 0;
    let softened = 0;
    const hard = lit();
    new SoftwareSceneRenderer().render(instances.map((inst, i) => (i === 0 ? inst : { ...inst, mesh: mat({ ...inst.mesh.primitives[0]!.material, softDepth: 0 }) })), hard);
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
      if (i % 4 === 3 && (gpu.out[i] === 0) !== (software.out[i] === 0)) coverage += 1;
      if (software.out[i] !== hard.out[i]) softened += 1;
    }
    expect(softened).toBeGreaterThan(20); // the soft edge really changed the picture
    expect(coverage).toBe(0);
    expect(maxDelta).toBeLessThanOrEqual(5);
    renderer.dispose();
  });

  it("runs material graphs like the software rasteriser: noise, fresnel, maths and a scrolling texture", async () => {
    // EP7: each graph compiles to its own WGSL pipeline variant; the CPU interprets the same steps.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const mat = (m: Record<string, unknown>) => {
      const q = quad();
      return { ...q, primitives: [{ ...q.primitives[0]!, material: { ...q.primitives[0]!.material, ...m } }] };
    };
    const instances = graphInstances(mat);
    const timed = () => ({ ...draw(), time: 0.7 });
    renderer.render(instances, timed());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = timed();
    renderer.render(instances, gpu);
    const software = timed();
    new SoftwareSceneRenderer().render(instances, software);
    let maxDelta = 0;
    let coverage = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
      if (i % 4 === 3 && (gpu.out[i] === 0) !== (software.out[i] === 0)) coverage += 1;
    }
    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);
    expect(coverage).toBe(0);
    expect(maxDelta).toBeLessThanOrEqual(6);
    renderer.dispose();
  });

  it("shades clearcoat, brushed metal, parallax relief and wear masks like the software rasteriser (I4)", async () => {
    const mat = (m: Record<string, unknown>) => {
      const q = quad();
      return { ...q, primitives: [{ ...q.primitives[0]!, material: { ...q.primitives[0]!.material, ...m } }] };
    };
    const instances = layerInstances(mat);
    for (const [name, frame] of [
      ["key light", (): SceneDraw => ({ ...draw(), lightDirection: [0.4, 0.8, 0.6], environment: LAYER_ENVIRONMENT })],
      ["light list", (): SceneDraw => ({ ...draw(), environment: LAYER_ENVIRONMENT, lights: LAYER_LIGHTS })],
    ] as const) {
      const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
      renderer.render(instances, frame());
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        device.tick?.();
      }
      const gpu = frame();
      renderer.render(instances, gpu);
      const software = frame();
      new SoftwareSceneRenderer().render(instances, software);
      let drawn = 0;
      let coverage = 0;
      let far = 0;
      for (let p = 0; p < W * H; p += 1) {
        if (software.out[p * 4]! + software.out[p * 4 + 1]! + software.out[p * 4 + 2]! > 0) drawn += 1;
        if ((gpu.out[p * 4 + 3] === 0) !== (software.out[p * 4 + 3] === 0)) coverage += 1;
        let worst = 0;
        for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(gpu.out[p * 4 + c]! - software.out[p * 4 + c]!));
        if (worst > 8) far += 1;
      }
      expect(drawn, name).toBeGreaterThan(400);
      expect(coverage, name).toBe(0);
      // The parallax march steps by the screen's UV derivatives on the GPU and
      // the triangle's exact gradients on the CPU, so a step can land on the
      // other side of a relief texel: a few pixels may differ, the rest match.
      expect(far, name).toBeLessThanOrEqual(drawn * 0.03);
      renderer.dispose();
    }
  });

  it("matches the software rasteriser on image-based lighting (within float tolerance)", async () => {
    // The environment replaces flat ambient with directional irradiance +
    // reflection; the WGSL envColor/envAverage must match meshRasterizer.ts. As
    // with the BRDF this is tolerant, not byte-identical (transcendental-free but
    // still float32 vs float64). Validates the WGSL IBL branch on hardware.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = pbrScene();
    const environment = {
      sky: [0.3, 0.5, 0.95] as const,
      horizon: [0.7, 0.7, 0.68] as const,
      ground: [0.3, 0.22, 0.12] as const,
      intensity: 1,
    };
    const withEnv = (): SceneDraw => ({ ...draw(), environment });

    renderer.render(instances, withEnv());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = withEnv();
    renderer.render(instances, gpu);

    const software = withEnv();
    new SoftwareSceneRenderer().render(instances, software);

    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
    }
    expect(maxDelta).toBeLessThanOrEqual(4);

    renderer.dispose();
  });

  it("matches the software rasteriser on an equirectangular env map (within float tolerance)", async () => {
    // The GPU samples the *same* uploaded panorama with the same nearest
    // projection (atan2/acos → texel) as sampleEnvironmentDir, so only the base
    // PBR shading differs by a few float bits.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = pbrScene();
    // A 4x2 panorama with distinct columns, so the reflection is direction-varying.
    const data = new Uint8ClampedArray(4 * 2 * 4);
    for (let i = 0; i < 8; i += 1) {
      data[i * 4] = (i * 30) & 255;
      data[i * 4 + 1] = (255 - i * 20) & 255;
      data[i * 4 + 2] = (i * 45) & 255;
      data[i * 4 + 3] = 255;
    }
    const map: DecodedTexture = { width: 4, height: 2, data };
    const environment = {
      sky: [0, 0, 0] as const,
      horizon: [0, 0, 0] as const,
      ground: [0, 0, 0] as const,
      intensity: 1,
      map,
      average: computeEnvironmentAverage(map),
    };
    const withEnv = (): SceneDraw => ({ ...draw(), environment });

    renderer.render(instances, withEnv());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = withEnv();
    renderer.render(instances, gpu);

    const software = withEnv();
    new SoftwareSceneRenderer().render(instances, software);

    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
    }
    expect(maxDelta).toBeLessThanOrEqual(4);

    renderer.dispose();
  });

  it("matches the software rasteriser on SSAO (within float tolerance)", async () => {
    // The GPU samples the *same* CPU-generated AO buffer (uploaded r32float) per
    // fragment, so the ambient it removes is identical; only the base PBR shading
    // differs by a few float bits.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = shadowScene(); // a floor + occluder gives a concave crease
    const geo = renderGeometryBuffers(instances, {
      width: W,
      height: H,
      view: viewMatrix([0, 7, 8], [0, 0, 0]),
      projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    });
    const ssao = computeSsao(geo, projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100), { radius: 0.6, intensity: 1, bias: 0.025 });
    const withSsao = (): SceneDraw => ({ ...draw(), view: viewMatrix([0, 7, 8], [0, 0, 0]), ambient: 0.6, ssao });

    renderer.render(instances, withSsao());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = withSsao();
    renderer.render(instances, gpu);

    const software = withSsao();
    new SoftwareSceneRenderer().render(instances, software);

    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
    }
    expect(maxDelta).toBeLessThanOrEqual(4);

    renderer.dispose();
  });

  it("matches the software rasteriser on multi-light forward shading (within float tolerance)", async () => {
    // Several directional + point lights: the GPU loops the same packed list and
    // the same BRDF as meshRasterizer.ts, so only float rounding differs.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = pbrScene();
    const lights = [
      { kind: "directional" as const, direction: [0.3, 0.6, 1] as const, color: [1, 0.9, 0.8] as const, intensity: 1 },
      { kind: "point" as const, position: [1.5, 1, 2] as const, color: [0.2, 0.4, 1] as const, intensity: 3, range: 6 },
      { kind: "point" as const, position: [-1.5, -0.5, 2] as const, color: [1, 0.3, 0.1] as const, intensity: 3, range: 6 },
    ];
    const withLights = (): SceneDraw => ({ ...draw(), lights });

    renderer.render(instances, withLights());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = withLights();
    renderer.render(instances, gpu);

    const software = withLights();
    new SoftwareSceneRenderer().render(instances, software);

    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
    }
    expect(maxDelta).toBeLessThanOrEqual(4);

    renderer.dispose();
  });

  it("shades forty point lights and four spots through the light clusters like the software rasteriser", async () => {
    // EP8: the ranged lights are sorted into the view's cells and each fragment
    // shades only its cell's list; the software path shades every light.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = [{ mesh: pbrFloor(6, 0), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }];
    const lit = (): SceneDraw => ({ ...draw(), view: viewMatrix([0, 4, 7], [0, 0, 0]), lights: manyLights() });
    renderer.render(instances, lit());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = lit();
    renderer.render(instances, gpu);
    const software = lit();
    new SoftwareSceneRenderer().render(instances, software);
    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
    expect(Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length).toBeGreaterThan(100);
    expect(maxDelta).toBeLessThanOrEqual(4);
    renderer.dispose();
  });

  it("picks the near shadow cascade where it covers a point, the main map elsewhere, like the software rasteriser", async () => {
    // EP8b: both maps packed side by side in one texture; the near one chosen from the world position.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = shadowScene();
    const lightView = viewMatrix([0, 10, 0], [0, 0, 0], [0, 0, -1]);
    const far = renderShadowMap(instances, { lightView, lightProjection: orthographicMatrix(-6, 6, -6, 6, 0.1, 20), size: 64, depth: new Float32Array(64 * 64) });
    const near = renderShadowMap(instances, { lightView, lightProjection: orthographicMatrix(-2, 2, -2, 2, 0.1, 20), size: 64, depth: new Float32Array(64 * 64) });
    const shadow = { ...far, pcf: true, near: { lightViewProj: near.lightViewProj, depth: near.depth, bias: 0.002, slopeBias: 0 } };
    const lit = (withNear = true): SceneDraw => ({ ...draw(), view: viewMatrix([0, 7, 8], [0, 0, 0]), lightDirection: [0, 1, 0], shadow: withNear ? shadow : far });
    renderer.render(instances, lit());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = lit();
    renderer.render(instances, gpu);
    const software = lit();
    new SoftwareSceneRenderer().render(instances, software);
    const coarse = lit(false);
    new SoftwareSceneRenderer().render(instances, coarse);
    let maxDelta = 0;
    let sharper = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
      if (software.out[i] !== coarse.out[i]) sharper += 1;
    }
    expect(sharper).toBeGreaterThan(10); // the near cascade really changed the shadow's edge
    expect(maxDelta).toBeLessThanOrEqual(4);
    renderer.dispose();
  });

  it("casts spot and point light shadows like the software rasteriser", async () => {
    // EP8c: the tiles packed in an atlas; each fragment a light reaches projects into its tile.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const rig = localShadowRig();
    const lit = (withShadows = true): SceneDraw => ({ ...draw(), view: viewMatrix([0, 4, 6], [0, 0.5, 0]), lights: rig.lights, localShadows: withShadows ? rig.localShadows : null });
    renderer.render(rig.instances, lit());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = lit();
    renderer.render(rig.instances, gpu);
    const software = lit();
    new SoftwareSceneRenderer().render(rig.instances, software);
    const unshadowed = lit(false);
    new SoftwareSceneRenderer().render(rig.instances, unshadowed);
    let maxDelta = 0;
    let shaded = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
      if (software.out[i]! < unshadowed.out[i]! - 8) shaded += 1;
    }
    expect(shaded).toBeGreaterThan(30); // the shadows really darken the floor
    expect(maxDelta).toBeLessThanOrEqual(4);
    renderer.dispose();
  });

  it("lights surfaces without light maps from the probe grid like the software rasteriser", async () => {
    // EP9: the grid as a 3D texture, trilinear by hand, the ambient cube's faces by the normal.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const rig = probeRig();
    const lit = (withProbes = true): SceneDraw => ({ ...draw(), view: viewMatrix([0, 3.5, 5.5], [0, 0.5, 0]), lightDirection: [0.3, 1, 0.4], ambient: 0.3, environment: withProbes ? rig.environment : { ...rig.environment, lightProbes: null } });
    renderer.render(rig.instances, lit());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = lit();
    renderer.render(rig.instances, gpu);
    const software = lit();
    new SoftwareSceneRenderer().render(rig.instances, software);
    const plain = lit(false);
    new SoftwareSceneRenderer().render(rig.instances, plain);
    let maxDelta = 0;
    let changed = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
      if (Math.abs(software.out[i]! - plain.out[i]!) > 6) changed += 1;
    }
    expect(changed).toBeGreaterThan(100); // the probes really shape the ambient
    expect(maxDelta).toBeLessThanOrEqual(4);
    renderer.dispose();
  });

  it("matches the software rasteriser on directional shadows (within float tolerance)", async () => {
    // The GPU samples the *same* CPU-generated shadow map (uploaded as r32float)
    // with the same nearest compare + bias, so the shadow decision is identical;
    // only the base PBR shading differs by a few float bits. A large delta means
    // the WGSL shadow projection or the upload diverged.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = shadowScene();
    const shadow = renderShadowMap(instances, {
      lightView: viewMatrix([0, 10, 0], [0, 0, 0], [0, 0, -1]),
      lightProjection: orthographicMatrix(-6, 6, -6, 6, 0.1, 20),
      size: 256,
      depth: new Float32Array(256 * 256),
    });
    const withShadow = (): SceneDraw => ({
      ...draw(),
      view: viewMatrix([0, 7, 8], [0, 0, 0]),
      lightDirection: [0, 1, 0],
      shadow,
    });

    renderer.render(instances, withShadow());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = withShadow();
    renderer.render(instances, gpu);

    const software = withShadow();
    new SoftwareSceneRenderer().render(instances, software);

    const drawn = Array.from(software.out).filter((_, i) => i % 4 === 3 && software.out[i] !== 0).length;
    expect(drawn).toBeGreaterThan(100);

    let maxDelta = 0;
    for (let i = 0; i < W * H * 4; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(gpu.out[i]! - software.out[i]!));
    }
    expect(maxDelta).toBeLessThanOrEqual(4);

    renderer.dispose();
  });
});

/**
 * Anti-aliasing (HALO_INFINITE_STYLE_ROADMAP.md I1) on the real device: the
 * multisampled pipelines and targets validate (a material graph's variant and
 * the see-through pass's multisampled depth included), and the frame differs
 * from the plain one only on edges, each changed pixel a blend of the colours
 * around it.
 */
describe.skipIf(!device)("WebGPU anti-aliasing on a real device", () => {
  const mat = (m: Record<string, unknown>) => {
    const q = quad();
    return { ...q, primitives: [{ ...q.primitives[0]!, material: { ...q.primitives[0]!.material, ...m } }] };
  };

  async function frame(instances: MeshSceneInstance[], make: () => SceneDraw, antialias: boolean): Promise<{ out: Uint8ClampedArray; error: string | null }> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    device.pushErrorScope("validation");
    renderer.render(instances, { ...make(), antialias });
    // Wait for a real GPU frame: until one lands, the renderer shows its software warm-up (which ignores antialias).
    for (let attempt = 0; attempt < 200 && !(renderer as unknown as { latest: Uint8Array | null }).latest; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    expect((renderer as unknown as { latest: Uint8Array | null }).latest).not.toBeNull();
    const d = { ...make(), antialias };
    renderer.render(instances, d);
    const error = await device.popErrorScope();
    renderer.dispose();
    return { out: d.out, error: error ? String(error.message ?? error) : null };
  }

  function compare(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    const px = (o: Uint8ClampedArray, x: number, y: number) => [o[(y * W + x) * 4]!, o[(y * W + x) * 4 + 1]!, o[(y * W + x) * 4 + 2]!];
    let changed = 0;
    let offEdge = 0;
    let outside = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const p = px(a, x, y);
        const q = px(b, x, y);
        if (p.every((v, c) => Math.abs(v - q[c]!) <= 2)) continue;
        changed += 1;
        const ring = (r: number) => {
          const out: number[][] = [];
          for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) if ((dx || dy) && x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H) out.push(px(a, x + dx, y + dy));
          return out;
        };
        if (!ring(1).some((n) => n.some((v, c) => Math.abs(v - p[c]!) > 2))) offEdge += 1;
        const around = [p, ...ring(2)];
        for (let c = 0; c < 3; c += 1) {
          const values = around.map((n) => n[c]!);
          if (q[c]! < Math.min(...values) - 8 || q[c]! > Math.max(...values) + 8) {
            outside += 1;
            break;
          }
        }
      }
    }
    return { changed, offEdge, outside };
  }

  const cases: Record<string, { instances: () => MeshSceneInstance[]; draw: () => SceneDraw }> = {
    textured: { instances: scene, draw },
    transparent: {
      instances: () => [
        { mesh: mat({ metallicFactor: 0, roughnessFactor: 0.8 }), model: composeModelMatrix([0, 0, -1], [0, 0, 0], [2.2, 1.6, 1]) },
        { mesh: mat({ baseColorFactor: [0.2, 0.6, 1, 0.4], metallicFactor: 0, roughnessFactor: 0.2, alphaMode: "blend" }), model: composeModelMatrix([-0.5, 0, 0.3], [0, 20, 0], [0.9, 0.9, 1]) },
        { mesh: mat({ baseColorFactor: [1, 0.3, 0.1, 0.7], alphaMode: "additive" }), model: composeModelMatrix([0.6, 0.2, 0.6], [0, -15, 0], [0.6, 0.6, 1]) },
      ],
      draw,
    },
    soft: {
      instances: () => [
        { mesh: mat({ baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 }), model: composeModelMatrix([0, 0, 0], [-90, 0, 0], [3, 3, 1]) },
        { mesh: mat({ baseColorFactor: [0.2, 0.6, 1, 0.8], metallicFactor: 0, roughnessFactor: 1, alphaMode: "blend", softDepth: 0.8 }), model: composeModelMatrix([-0.7, 0.4, 0], [0, 10, 0], [0.8, 0.8, 1]) },
      ],
      draw: () => ({ ...draw(), view: viewMatrix([0, 4, 7], [0, 0, 0]) }),
    },
    graph: { instances: () => graphInstances(mat), draw: () => ({ ...draw(), time: 0.7 }) },
  };

  for (const [name, c] of Object.entries(cases)) {
    it(`smooths only edges: ${name}`, async () => {
      const instances = c.instances();
      const plain = await frame(instances, c.draw, false);
      const smooth = await frame(instances, c.draw, true);
      expect(plain.error).toBeNull();
      expect(smooth.error).toBeNull();
      const result = compare(plain.out, smooth.out);
      expect(result.changed).toBeGreaterThan(10);
      expect(result.offEdge).toBe(0);
      expect(result.outside).toBe(0);
    }, 60_000);
  }
});

describe.skipIf(!device)("WebGPU temporal anti-aliasing on a real device", () => {
  const make = async (width: number, height: number) => (await WebgpuSceneRenderer.create(device, width, height)) as unknown as GpuRenderer;
  const reference = (instances: readonly MeshSceneInstance[], d: SceneDraw) => new SoftwareSceneRenderer().render(instances, d);
  const tick = () => device.tick?.();

  for (const [name, extra] of [["alone", {}], ["with multisampling", { antialias: true }]] as const) {
    it(`converges toward a supersampled frame, keeps it through a pan, and stops the crawl: ${name}`, async () => {
      device.pushErrorScope("validation");
      const report = await temporalReport(make, reference, tick, W, H, extra);
      const error = await device.popErrorScope();
      expect(error ? String(error.message ?? error) : null).toBeNull();
      expectTemporal(report);
    }, 120_000);
  }
});

describe.skipIf(!device)("WebGPU screen-space reflections on a real device", () => {
  const make = async (width: number, height: number) => (await WebgpuSceneRenderer.create(device, width, height)) as unknown as GpuRenderer;
  const tick = () => device.tick?.();

  for (const [name, extra] of [["alone", {}], ["with multisampling", { antialias: true }], ["with multisampling and temporal", { antialias: true, temporal: true }]] as const) {
    it(`reflects the panels in the floor, each on its side, and changes nothing else: ${name}`, async () => {
      device.pushErrorScope("validation");
      const report = await reflectionReport(make, tick, W, H, extra);
      const error = await device.popErrorScope();
      expect(error ? String(error.message ?? error) : null).toBeNull();
      expectReflections(report);
    }, 120_000);
  }
});
