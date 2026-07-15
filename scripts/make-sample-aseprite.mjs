// Generate a real .aseprite file with the project's encoder, for manual and
// browser verification of the import flow. Writes a 16x16 indexed sprite whose
// pattern touches every palette colour.
//
// Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" scripts/make-sample-aseprite.mjs [outPath]

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exportPath = path.resolve(here, "../packages/editor/src/model/asepriteExport.ts");
const { encodeAseprite } = await import(pathToFileURL(exportPath).href);

const palette = [
  [26, 28, 44], // 0: transparent slot
  [93, 39, 93],
  [177, 62, 83],
  [239, 125, 87],
  [255, 205, 117],
  [56, 183, 100],
  [37, 113, 121],
  [41, 54, 111],
];

const width = 16;
const height = 16;
const indices = new Uint8Array(width * height);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    // Concentric rings so the sprite is visually recognisable after import.
    const ring = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) | 0;
    indices[y * width + x] = ring % palette.length;
  }
}

const bytes = await encodeAseprite({ width, height, palette, indices, transparentIndex: 0 });
const out = process.argv[2] ?? path.resolve(here, "sample.aseprite");
writeFileSync(out, bytes);
console.log(`Wrote ${bytes.length} bytes -> ${out}`);
