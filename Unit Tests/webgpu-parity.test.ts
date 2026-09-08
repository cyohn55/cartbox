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
  projectionMatrix,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { SoftwareSceneRenderer, WebgpuSceneRenderer, type SceneDraw } from "@cartbox/player";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
});
