/**
 * The offline bake of a map (BEAVER_CREEK_ROADMAP.md B1): `npm run bake:map
 * <id> [parts]` runs this with BAKE_MAP=<id> (and BAKE_PARTS, comma-separated:
 * lightmap, probes, kit; all by default) and rewrites that map's generated
 * files. Skipped otherwise: a bake takes a while. map-bakes.test.ts checks
 * every map's stored bakes still fit.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAP_BAKES,
  MAP_BAKE_PARTS,
  bakeMapKitSource,
  bakeMapLightmapSource,
  bakeMapProbesSource,
  bakeMapTexturesSource,
  base64ToBytes,
  bytesToBase64,
  sidecarImages,
  sidecarPairs,
  type MapBakePart,
} from "@cartbox/editor";
import { occlusionWithRelief } from "../packages/player/src/render/gpuFrame";
import { encodeKtx2 } from "@/lib/ktx2Encoder";

const id = process.env.BAKE_MAP ?? "";
const parts = (process.env.BAKE_PARTS ? process.env.BAKE_PARTS.split(",") : MAP_BAKE_PARTS) as MapBakePart[];
const root = path.resolve(__dirname, "..");

describe.skipIf(!id)(`baking map "${id}"`, () => {
  it("bakes the parts asked for and stores them", async () => {
    const map = MAP_BAKES[id];
    expect(map, `no map "${id}" (known: ${Object.keys(MAP_BAKES).join(", ")})`).toBeDefined();
    for (const part of parts) {
      expect(MAP_BAKE_PARTS, `unknown part "${part}"`).toContain(part);
      const started = Date.now();
      const source =
        part === "lightmap" ? bakeMapLightmapSource(id) : part === "probes" ? bakeMapProbesSource(id) : part === "kit" ? bakeMapKitSource(id) : await bakeTexturesSource(id);
      const file = map!.files[part];
      if (source === null || !file) {
        console.log(`${id}: no ${part} to bake`);
        continue;
      }
      writeFileSync(path.join(root, file.path), source);
      console.log(`${id}: baked ${part} in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${file.path}`);
    }
  }, 1_800_000);
});

/**
 * The texture bake (AAA_FIDELITY_ROADMAP.md F1a): every image of the map's
 * sidecar encoded to KTX2 with its mip chain — or left as it is ("") when it
 * is a cut-out's colour map, one of an occlusion and relief pair, or not a PNG.
 */
async function bakeTexturesSource(id: string): Promise<string | null> {
  const map = MAP_BAKES[id]!;
  if (!map.sidecar) return null;
  const encoder = await encoderModule();
  // Loaded only for this bake: pngjs decodes the stored PNGs to RGBA in Node.
  const { PNG } = (await import("pngjs")) as unknown as { PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } };
  const table: Record<string, string> = {};
  let kept = 0;
  for (const image of sidecarImages(map.sidecar())) {
    table[image.key] = "";
    if (image.packed || image.mime !== "image/png") continue;
    const png = PNG.sync.read(Buffer.from(base64ToBytes(image.base64)));
    const texture = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
    let seeThrough = false;
    for (let i = 3; i < texture.data.length; i += 4) if (texture.data[i]! < 255) seeThrough = true;
    if (seeThrough && image.kind === "color") continue;
    const ktx2 = encodeKtx2(encoder, texture, image.kind);
    if (!ktx2) continue;
    table[image.key] = bytesToBase64(ktx2);
    kept += 1;
  }
  // Each occlusion and relief pair, packed as the player packs it at load (I4), as one data map.
  const rgba = (base64: string) => {
    const png = PNG.sync.read(Buffer.from(base64ToBytes(base64)));
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  };
  for (const pair of sidecarPairs(map.sidecar())) {
    const packed = occlusionWithRelief(pair.occlusion ? rgba(pair.occlusion) : null, rgba(pair.relief))!;
    const ktx2 = encodeKtx2(encoder, packed, "data");
    table[pair.key] = ktx2 ? bytesToBase64(ktx2) : "";
    if (ktx2) kept += 1;
  }
  console.log(`${id}: ${kept} of ${Object.keys(table).length} images compressed`);
  return bakeMapTexturesSource(id, table);
}

async function encoderModule() {
  const file = readFileSync(path.join(root, "apps/web/src/vendor/basis/basis_encoder.wasm"));
  const { default: createBasis } = (await import("../apps/web/src/vendor/basis/basis_encoder.mjs")) as { default: (o: object) => Promise<{ initializeBasis(): void }> };
  const basis = await createBasis({ wasmBinary: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) });
  basis.initializeBasis();
  return basis;
}
