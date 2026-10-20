/**
 * The AAA tier's tone curve as the maps were authored (AAA_FIDELITY_ROADMAP.md
 * F11a-5). The byte path's shader maps its display-space shading through the
 * curve: `aces(exposure · v)` on sRGB values. The AAA tier maps linear light:
 * `encode(aces(exposure · x))`, which crushes what the byte path lifted (a 0.3
 * surface shows 0.33 where it was tuned to show 0.47). A rig can ask for the
 * curve as authored, on the light's encoding, `aces(exposure · encode(x))`, so
 * a fully lit surface shows as tuned while its lighting stays linear. It is
 * not the default: on linear lighting it lifts the shade past the byte path's.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, parseSceneLighting, projectionMatrix, sceneLightingTonemap, viewMatrix, type MeshAsset, type MeshSceneInstance, type SceneLighting } from "@cartbox/editor";
import { GpuPresenter, WebgpuSceneRenderer } from "@cartbox/player";
import { extendedExposure } from "../packages/player/src/render/grading";
import { shownAs, srgbDecode, srgbEncode, toneMap } from "../packages/player/src/render/toneMappers";

const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));

describe("the curve's two domains", () => {
  it("as authored, shows a fully lit surface as the byte path's shader does", () => {
    for (const v of [0.05, 0.3, 0.5, 0.8, 1]) {
      expect(shownAs("filmic", [srgbDecode(v), srgbDecode(v), srgbDecode(v)], 1.1, true)[1]).toBeCloseTo(aces(1.1 * v), 6);
    }
    // Physically it crushes the shade the art was tuned to show, and lifts the highlights.
    expect(shownAs("filmic", [srgbDecode(0.3), srgbDecode(0.3), srgbDecode(0.3)], 1.1)[1]).toBeLessThan(aces(1.1 * 0.3) - 0.1);
    expect(shownAs("filmic", [1, 1, 1], 1.1)[1]).toBeGreaterThan(aces(1.1) + 0.05);
  });

  it("keeps grey where SDR shows it on an HDR display, in either domain", () => {
    const top = srgbEncode(3);
    const grey = srgbEncode(0.18);
    const s = extendedExposure("filmic", 3, true);
    expect(top * toneMap("filmic", [(grey * s) / top, (grey * s) / top, (grey * s) / top])[1]).toBeCloseTo(toneMap("filmic", [grey, grey, grey])[1], 4);
    expect(s).not.toBeCloseTo(extendedExposure("filmic", 3), 2);
  });

  it("is physical unless the rig asks for it as authored, and the choice survives a save", () => {
    const rig = parseSceneLighting({ tonemap: true, exposure: 1.1 }) as SceneLighting;
    expect(sceneLightingTonemap(rig)).toEqual({ exposure: 1.1 });
    const authored = parseSceneLighting(JSON.parse(JSON.stringify({ ...rig, authoredCurve: true }))) as SceneLighting;
    expect(authored.authoredCurve).toBe(true);
    expect(sceneLightingTonemap(authored)).toEqual({ exposure: 1.1, authored: true });
    expect(sceneLightingTonemap({ ...authored, tonemap: false })).toBeNull();
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
  for (let i = 0; i < 800 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

const W = 32;
const H = 32;
const VIEW = viewMatrix([0, 0, 3], [0, 0, 0]);
const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 50);

/** A rough dielectric square facing the camera, and the light. */
const pane = (albedo: number): MeshAsset =>
  ({
    name: "pane",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorImage: null, baseColorFactor: [albedo, albedo, albedo, 1], metallicFactor: 0, roughnessFactor: 0.9 },
      },
    ],
  }) as unknown as MeshAsset;

/** The centre of the frame a renderer draws and a presenter shows, 0–255: byte space, or linear light through either curve. */
async function shown(hdr: boolean, albedo: number, tonemap: { exposure: number; authored?: boolean }): Promise<number> {
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr }))!;
  const presenter = new GpuPresenter(device, W, H, { hdr });
  const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
  const instances: MeshSceneInstance[] = [{ mesh: pane(albedo), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]) }];
  device.pushErrorScope("validation");
  const scene = renderer.renderToTexture(instances, {
    width: W,
    height: H,
    view: VIEW,
    projection: PROJECTION,
    ambient: 0,
    lightDirection: [0, 0, 1],
    lights: [{ kind: "directional", direction: [0, 0, 1], color: [1, 1, 1], intensity: 1 }],
    tonemap,
  } as any);
  presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene, ...(hdr ? { tonemap } : {}) } as any, out, "rgba8unorm");
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const buffer = device.createBuffer({ size: 256 * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: out }, { buffer, bytesPerRow: 256, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const value = new Uint8Array(buffer.getMappedRange().slice(0))[(H / 2) * 256 + (W / 2) * 4]!;
  buffer.unmap();
  buffer.destroy();
  out.destroy();
  presenter.dispose();
  renderer.dispose();
  return value;
}

describe.skipIf(!device)("the curve as authored, on a real device", { timeout: 120_000 }, () => {
  it("shows a lit surface as the byte path does, where the physical curve did not", async () => {
    let authoredOff = 0;
    let physicalOff = 0;
    for (const albedo of [0.3, 0.5, 0.8]) {
      const byte = await shown(false, albedo, { exposure: 1.1 });
      const authored = await shown(true, albedo, { exposure: 1.1, authored: true });
      const physical = await shown(true, albedo, { exposure: 1.1 });
      // What is left is the AAA tier's BRDF, which reflects a little more off a dark rough surface.
      expect(Math.abs(authored - byte)).toBeLessThanOrEqual(12);
      authoredOff += Math.abs(authored - byte);
      physicalOff += Math.abs(physical - byte);
    }
    // The physical curve showed the dark surface far darker and the pale one far paler (by 20 levels and more).
    expect(physicalOff).toBeGreaterThan(authoredOff * 2.5);
  });
});
