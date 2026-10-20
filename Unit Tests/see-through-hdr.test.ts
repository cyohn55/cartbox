/**
 * Colours authored for the display, in linear light (AAA_FIDELITY_ROADMAP.md
 * F11a). Fog's colour mixes into what the display shows, as on the byte path,
 * so it lifts the distance as much as it did there and no more. And a
 * refracting surface's colour is authored for the display, so on the AAA tier
 * it mixes with what is behind it as the display shows the two (exposed,
 * through the curve, sRGB-encoded) and back, as the byte path mixes them. Mixed
 * in linear light instead, a dark tint (Beaver Creek's water) only dimmed the
 * creek bed, and the water's colour was lost.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, riverWaterMaterial, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";

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

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const acesInverse = (y: number) => {
  const a = 2.51 - 2.43 * y;
  const b = 0.03 - 0.59 * y;
  return (-b + Math.sqrt(b * b + 4 * a * 0.14 * y)) / (2 * a);
};
const encode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** What the display shows for linear light x at exposure e, and back. */
const shown = (x: number, e: number) => encode(aces(x * e));
const light = (d: number, e: number) => acesInverse(decode(d)) / e;

const R = 32;
const EXPOSURE = 1.1;

/** A flat square facing the camera, `z` along the view. */
const pane = (material: Record<string, unknown>): MeshAsset =>
  ({
    name: "pane",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, ...material },
      },
    ],
  }) as unknown as MeshAsset;

const bed = { mesh: pane({ baseColorFactor: [0.8, 0.7, 0.5, 1] }), model: composeModelMatrix([0, 0, -0.5], [0, 0, 0], [2, 2, 1]) };
const over = (material: Record<string, unknown>): MeshSceneInstance => ({ mesh: pane(material), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [0.8, 0.8, 1]) });

/** The frame's centre pixel (rgb), rendered linear (half floats) or in bytes (0–1). */
async function centre(hdr: boolean, instances: MeshSceneInstance[], extra: Record<string, unknown> = {}): Promise<number[]> {
  const renderer = (await WebgpuSceneRenderer.create(device, R, R, undefined, { hdr } as any))!;
  device.pushErrorScope("validation");
  const texture = renderer.renderToTexture!(instances, {
    width: R,
    height: R,
    view: viewMatrix([0, 0, 3], [0, 0, 0]),
    projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
    ambient: 0.5,
    lightDirection: [0.3, 0.5, 1],
    tonemap: { exposure: EXPOSURE },
    ...extra,
  } as any);
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const texel = hdr ? 8 : 4;
  const bytesPerRow = Math.ceil((R * texel) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * R, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: R }, { width: R, height: R });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const copy = buffer.getMappedRange().slice(0);
  buffer.unmap();
  buffer.destroy();
  renderer.dispose();
  const at = (R / 2) * bytesPerRow + (R / 2) * texel;
  if (!hdr) return Array.from(new Uint8Array(copy).slice(at, at + 3)).map((v) => v / 255);
  return Array.from(new Uint16Array(copy).slice(at / 2, at / 2 + 3)).map(half);
}

describe.skipIf(!device)("a refracting tint over the scene, in linear light", { timeout: 60_000 }, () => {
  it("mixes as the display shows the two, not in linear light", async () => {
    const tint = { baseColorFactor: [0.16, 0.3, 0.34, 1] };
    const behind = await centre(true, [bed]);
    const alone = await centre(true, [over(tint)]);
    const mixed = await centre(true, [bed, over({ ...tint, baseColorFactor: [0.16, 0.3, 0.34, 0.55], alphaMode: "blend", refraction: 0.001 })]);
    for (let k = 0; k < 3; k += 1) {
      const want = light(0.45 * shown(behind[k]!, EXPOSURE) + 0.55 * shown(alone[k]!, EXPOSURE), EXPOSURE);
      expect(Math.abs(mixed[k]! - want) / want).toBeLessThan(0.03);
    }
    // A linear mix would be far off where the two differ most (red: the sand's 0.8 against the tint's 0.16).
    const linear = 0.45 * behind[0]! + 0.55 * alone[0]!;
    expect(Math.abs(mixed[0]! - linear) / mixed[0]!).toBeGreaterThan(0.15);
  });

  it("keeps Beaver Creek's water the colour of water: its blue over the sand's red, as on the byte path", async () => {
    const water = riverWaterMaterial();
    const shownHdr = (await centre(true, [bed, over(water as any)])).map((v) => shown(v, EXPOSURE));
    const bytes = await centre(false, [bed, over(water as any)]);
    // Sand alone reads red over blue; through the water, blue over red, on both paths.
    const sand = (await centre(true, [bed])).map((v) => shown(v, EXPOSURE));
    expect(sand[0]!).toBeGreaterThan(sand[2]! * 1.2);
    expect(bytes[2]!).toBeGreaterThan(bytes[0]!);
    expect(shownHdr[2]!).toBeGreaterThan(shownHdr[0]!);
    expect(shownHdr[1]!).toBeGreaterThan(shownHdr[0]!);
  });
});

describe.skipIf(!device)("fog in linear light", { timeout: 60_000 }, () => {
  it("mixes its colour into what the display shows, as the byte path does, not into the light", async () => {
    const fogColour: [number, number, number] = [0.72, 0.82, 0.92];
    // The bed 3.5 m off: past the start, and dense enough that the fog stops at its cap.
    const fog = { color: fogColour, density: 5, start: 0.5, max: 0.4 };
    const clear = await centre(true, [bed]);
    const fogged = await centre(true, [bed], { fog });
    for (let k = 0; k < 3; k += 1) {
      const want = light(0.6 * shown(clear[k]!, EXPOSURE) + 0.4 * fogColour[k]!, EXPOSURE);
      expect(Math.abs(fogged[k]! - want) / want).toBeLessThan(0.03);
    }
    // Mixed in light, the pale fog weighed far more: the far sand came out lighter than the byte path shows it.
    const linear = 0.6 * clear[2]! + 0.4 * decode(fogColour[2]!);
    expect(linear / fogged[2]!).toBeGreaterThan(1.1);
  });

  it("leaves light past white what it has over it: a glow in thin fog still glows", async () => {
    const glow = { mesh: pane({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [8, 8, 8] }), model: bed.model };
    const thin = { color: [0.72, 0.82, 0.92], density: 5, start: 0.5, max: 0.05 };
    const clear = await centre(true, [glow]);
    const fogged = await centre(true, [glow], { fog: thin });
    expect(clear[0]!).toBeGreaterThan(5);
    expect(fogged[0]!).toBeGreaterThan(clear[0]! * 0.7);
  });
});
