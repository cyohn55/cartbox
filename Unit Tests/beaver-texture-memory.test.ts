/**
 * Beaver Creek's texture memory on the AAA tier (AAA_FIDELITY_ROADMAP.md F1a):
 * what the GPU holds for each texture the map uploads, before F1a (RGBA, one
 * level) and now (its baked KTX2 transcoded to BC7 or BC1 with its mips, or
 * RGBA with its mips where it stays uncompressed: the cut-outs). Also that the
 * baked images ride the sidecar where the player can find them.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { arenaMap, base64ToBytes, imageKey, pairKey } from "@cartbox/editor";
import { transcodeKtx2 } from "@/lib/ktx2Decoder";

const vendor = (name: string) => new URL(`../apps/web/src/vendor/basis/${name}`, import.meta.url);
async function transcoderModule() {
  const require = createRequire(import.meta.url);
  const createBasis = require(vendor("basis_transcoder.cjs").pathname) as (o: object) => Promise<{ initializeBasis(): void }>;
  const bytes = readFileSync(vendor("basis_transcoder.wasm"));
  const basis = await createBasis({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  basis.initializeBasis();
  return basis;
}

const SLOTS = ["image", "emissiveImage", "blendImage", "lightmapImage", "metallicRoughnessImage", "occlusionImage", "materialImage", "detailImage", "normalImage"] as const;

interface Stored {
  mime: string;
  bytes: string;
  ktx2?: string;
  ktx2Relief?: boolean;
}

/** The textures a map uploads: each distinct image once, an occlusion and its relief as the one packed texture. */
function uploads(json: string): { key: string; image: Stored; relief: Stored | null }[] {
  const out = new Map<string, { key: string; image: Stored; relief: Stored | null }>();
  const isImage = (v: unknown): v is Stored => !!v && typeof v === "object" && typeof (v as Stored).bytes === "string" && (v as Stored).bytes.length > 0;
  const walk = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("{") && value.includes('"primitives"')) return walk(JSON.parse(value));
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const material = value as Record<string, unknown>;
    for (const v of Object.values(material)) walk(v);
    const relief = isImage(material.reliefImage) ? material.reliefImage : null;
    for (const slot of SLOTS) {
      const image = material[slot];
      if (!isImage(image)) continue;
      const key = slot === "occlusionImage" && relief ? pairKey(image.bytes, relief.bytes) : imageKey(image.bytes);
      if (!out.has(key)) out.set(key, { key, image, relief: slot === "occlusionImage" ? relief : null });
    }
  };
  walk(JSON.parse(json));
  return [...out.values()];
}

const size = (base64: string) => {
  const png = base64ToBytes(base64);
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe("Beaver Creek's textures on the AAA tier", () => {
  it("ride the sidecar with their baked KTX2, the occlusion maps packed with their relief", () => {
    const textures = uploads(arenaMap("beaver").sidecar());
    expect(textures.filter((t) => t.image.ktx2).length).toBeGreaterThanOrEqual(7);
    expect(textures.filter((t) => t.image.ktx2Relief).length).toBe(3);
  });

  it("take at least 4× less GPU memory than with RGBA mip chains, and 2.5× less than before F1a's mips", async () => {
    const transcoder = await transcoderModule();
    let before = 0; // RGBA, one level: what the GPU held before F1a
    let mipped = 0; // RGBA with its mips (F1a-1, before compression)
    let now = 0;
    const rows: string[] = [];
    for (const { image, relief } of uploads(arenaMap("beaver").sidecar())) {
      const a = size(image.bytes);
      const b = relief ? size(relief.bytes) : a;
      const { width, height } = a.width * a.height >= b.width * b.height ? a : b;
      before += width * height * 4;
      mipped += Math.round((width * height * 4 * 4) / 3);
      const gpu = image.ktx2 ? transcodeKtx2(transcoder, base64ToBytes(image.ktx2), { gpuFormats: ["bc7-rgba-unorm", "bc1-rgba-unorm"] })?.gpu : undefined;
      const bytes = gpu ? gpu.levels.reduce((s, l) => s + l.data.byteLength, 0) : Math.round((width * height * 4 * 4) / 3);
      now += bytes;
      rows.push(`${width}×${height} ${gpu?.format ?? "rgba8unorm"} ${bytes}`);
    }
    console.log(`Beaver Creek textures: before ${before}, RGBA with mips ${mipped}, now ${now} (${(before / now).toFixed(2)}× / ${(mipped / now).toFixed(2)}×)\n${rows.join("\n")}`);
    expect(mipped / now).toBeGreaterThanOrEqual(4);
    expect(before / now).toBeGreaterThanOrEqual(2.5);
  });
});
