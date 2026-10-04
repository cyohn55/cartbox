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
import { manyLights } from "./helpers/manyLights";


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
