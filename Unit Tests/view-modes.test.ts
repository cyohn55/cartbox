/**
 * View modes (AAA_FIDELITY_ROADMAP.md F10a): the lit frame or a diagnostic of
 * it on the linear-light renderer. The mode list and its ramp, the LOD level a
 * batch carries into its uniforms, and, on a real device (Dawn), each view's
 * pixels from the values the shader shades with.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance, type SceneLight } from "@cartbox/editor";
import { UNIFORM_FLOATS, VIEW_MODES, WebgpuSceneRenderer, heat, readViewMode, viewModeCode, writeInstanceUniform, type ViewMode } from "@cartbox/player";

import { batchInstances } from "../packages/player/src/render/gpuFrame";

const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function quad(name: string, material: Record<string, unknown> = {}): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name, baseColorFactor: [0.8, 0.4, 0.2, 1], baseColorImage: null, metallicFactor: 0.3, roughnessFactor: 0.6, ...material },
      },
    ],
  } as unknown as MeshAsset;
}

describe("the view modes", () => {
  it("lists each mode once, with lit as 0 and unknowns falling back to lit", () => {
    expect(new Set(VIEW_MODES.map((m) => m.id)).size).toBe(VIEW_MODES.length);
    expect(new Set(VIEW_MODES.map((m) => m.code)).size).toBe(VIEW_MODES.length);
    expect(viewModeCode("lit")).toBe(0);
    expect(viewModeCode(undefined)).toBe(0);
    expect(viewModeCode("overdraw")).toBe(11);
    expect(readViewMode("normals")).toBe("normals");
    expect(readViewMode("wireframe")).toBe("lit");
  });

  it("ramps heat from black through blue, green, yellow and red to white", () => {
    expect(heat(0)).toEqual([0, 0, 0]);
    expect(heat(1)).toEqual([1, 1, 1]);
    expect(heat(0.4)).toEqual([0, 0.85, 0.2]);
    expect(heat(-1)).toEqual([0, 0, 0]);
  });

  it("carries the LOD level a batch draws into its uniforms (−1 without a chain)", () => {
    const near = quad("near");
    const far = quad("far");
    const lod = { meshes: [near, far], distances: [1] };
    const geometry = (mesh: MeshAsset) => mesh.primitives.map(() => ({ indexCount: 6 }));
    const { batches } = batchInstances(
      [
        { mesh: far, lod, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
        { mesh: quad("plain"), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
      ] as MeshSceneInstance[],
      geometry,
    );
    expect(batches.map((b) => b.lod)).toEqual([1, -1]);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const uniform = {
      mvp: identity,
      normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      baseColor: [1, 1, 1, 1] as const,
      hasTexture: false,
      light: { direction: [0, 1, 0] as const, ambient: 0.3 },
      viewDir: [0, 0, 1] as const,
      pbr: { isPbr: true, metallic: 0, roughness: 1, emissive: [0, 0, 0] as const },
      hasMrMap: false,
      hasOcclusionMap: false,
      hasEmissiveMap: false,
      environment: null,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: null,
      lightCount: 0,
    };
    const out = new Float32Array(UNIFORM_FLOATS);
    // motion0.w (float 235): the level, −1 without a chain.
    writeInstanceUniform(out, 0, { ...uniform, lodLevel: 2 });
    expect(out[235]).toBe(2);
    writeInstanceUniform(out, 0, uniform);
    expect(out[235]).toBe(-1);
  });
});

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
  for (let i = 0; i < 400 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

const W = 48;
const H = 48;

describe.skipIf(!device)("view modes on a real device", { timeout: 120_000 }, () => {
  let renderer: WebgpuSceneRenderer;

  /** The linear RGBA at the frame's centre of `instances` (default: the quad, 4 m across, facing the eye 3 m off), shown as `mode`. */
  async function centre(mode: ViewMode, options: { instances?: MeshSceneInstance[]; lights?: SceneLight[]; prepass?: boolean; texelDensity?: number } = {}): Promise<number[]> {
    renderer ??= (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const instances = options.instances ?? [{ mesh: quad("q"), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]) }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      ambient: 0.2,
      lightDirection: [0, 0.6, 0.8],
      environment: null,
      lights: options.lights ?? [],
      lod: true,
      viewMode: mode,
      ...(options.prepass ? { prepass: true } : {}),
      ...(options.texelDensity ? { texelDensity: options.texelDensity } : {}),
    } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const at = ((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4;
    return [0, 1, 2, 3].map((c) => half(halves[at + c]!));
  }

  const close = (got: number[], want: number[], tolerance = 0.01) => want.forEach((w, c) => expect(Math.abs(got[c]! - w)).toBeLessThan(tolerance + w * 0.01));

  it("shows the buffers the surface shades with", async () => {
    close(await centre("baseColor"), [srgb(0.8), srgb(0.4), srgb(0.2), 1]);
    close(await centre("unlit"), [srgb(0.8), srgb(0.4), srgb(0.2)]);
    close(await centre("roughness"), [srgb(0.6), srgb(0.6), srgb(0.6)]);
    close(await centre("metallic"), [srgb(0.3), srgb(0.3), srgb(0.3)]);
    // Facing +z: (0.5, 0.5, 1) as a display colour.
    close(await centre("normals"), [srgb(0.5), srgb(0.5), 1]);
    close(await centre("ambientOcclusion"), [1, 1, 1]);
  });

  it("lights a white dielectric for lighting only", async () => {
    const lit = await centre("lit");
    const only = await centre("lightingOnly");
    // The same light on white: red (0.8 albedo, part metal) under it, blue (0.2) far under it.
    expect(only[0]!).toBeGreaterThan(lit[0]!);
    expect(only[2]!).toBeGreaterThan(lit[2]! * 2);
    expect(Math.abs(only[0]! - only[2]!)).toBeLessThan(0.02 * only[0]!);
  });

  it("counts the lights a pixel loops over", async () => {
    const none = await centre("lightComplexity");
    const point = (x: number): SceneLight => ({ kind: "point", position: [x, 0, 1], color: [1, 1, 1], intensity: 1 });
    const four = await centre("lightComplexity", { lights: [point(-0.5), point(0), point(0.5), point(1)] });
    expect(Math.max(...none.slice(0, 3))).toBeLessThan(0.01);
    expect(Math.max(...four.slice(0, 3))).toBeGreaterThan(0.05);
    // More work for more lights, a normal map, parallax…
    const plain = await centre("shaderComplexity");
    const busy = await centre("shaderComplexity", { lights: [point(0), point(0.5)] });
    expect(busy).not.toEqual(plain);
  });

  it("colours the LOD level drawn", async () => {
    const lod = { meshes: [quad("near"), quad("far")], distances: [1] };
    const plain = await centre("lod");
    expect(plain[0]! > 0.1 && Math.abs(plain[0]! - plain[2]!) < 0.01).toBe(true); // white × form
    // 3 m off at scale 2: 1.5 mesh units, past the first switch, so level 1 (green).
    const level = await centre("lod", { instances: [{ mesh: lod.meshes[0]!, lod, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]) }] });
    expect(level[1]!).toBeGreaterThan(level[0]! * 4);
  });

  it("measures texel density against its target", async () => {
    const texture: DecodedTexture = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) };
    const textured = (): MeshSceneInstance[] => [{ mesh: quad("t"), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]), textures: [texture] }];
    // 64 texels over 4 m: 16 per metre.
    const onTarget = await centre("texelDensity", { instances: textured(), texelDensity: 16 });
    expect(onTarget[1]!).toBeGreaterThan(onTarget[0]! * 4);
    const under = await centre("texelDensity", { instances: textured(), texelDensity: 512 });
    expect(under[2]!).toBeGreaterThan(under[1]! * 2);
    const over = await centre("texelDensity", { instances: textured(), texelDensity: 1 });
    expect(over[0]!).toBeGreaterThan(over[1]! * 4);
    // About a texel a pixel: mip 0, green.
    const mip = await centre("mipLevel", { instances: textured() });
    expect(mip[1]!).toBeGreaterThan(mip[0]!);
  });

  it("adds up overdraw, depth ignored", async () => {
    const stack = [0, -0.5, -1].map((z) => ({ mesh: quad("o"), model: composeModelMatrix([0, 0, z], [0, 0, 0], [2, 2, 1]) }));
    const three = await centre("overdraw", { instances: stack });
    const one = await centre("overdraw", { instances: stack.slice(0, 1) });
    expect(three[3]).toBe(1);
    // A third of the way along a ramp the twelfth of which one fragment is.
    expect(three).not.toEqual(one);
    const want = heat(3 / 12).map(srgb);
    close(three, [...want, 1]);
  });

  it("draws motion vectors from the velocity buffer", async () => {
    // The same mesh frame to frame, so its copy is matched to last frame's.
    const mesh = quad("m");
    const at = (x: number): MeshSceneInstance[] => [{ mesh, model: composeModelMatrix([x, 0, 0], [0, 0, 0], [2, 2, 1]) }];
    await centre("motion", { instances: at(0), prepass: true });
    const still = await centre("motion", { instances: at(0), prepass: true });
    close(still, [srgb(0.08), srgb(0.08), srgb(0.08), 1]);
    // 1.5 m across 3.46 m of frame: about 21 px of a 32 px scale.
    const moved = await centre("motion", { instances: at(1.5), prepass: true });
    expect(Math.max(...moved.slice(0, 3)) - Math.min(...moved.slice(0, 3))).toBeGreaterThan(0.05);
  });

  it("shows the lit frame unchanged as lit", async () => {
    const a = await centre("lit");
    const b = await centre("lit");
    expect(a).toEqual(b);
    expect(a[0]!).toBeGreaterThan(0);
  });
});
