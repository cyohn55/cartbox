// Builds a minimal, self-contained TIC-80 Lua cartridge for verification/demos.
//
// A .tic cart is a sequence of chunks. Each chunk header is one 32-bit word (LE):
//   bits 0-4   type (ChunkType; CHUNK_CODE = 5)
//   bits 5-7   bank
//   bits 8-23  size (16-bit)
//   bits 24-31 reserved
// A single CODE chunk with no "-- script:" marker defaults to the Lua runtime.

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHUNK_CODE = 5;

/**
 * The Lua program embedded in the sample cart: animated concentric rings, an
 * orbiting dot, and a label. `t` advances each frame so playback is visibly
 * moving (proving the run loop and the engine's timer callbacks work).
 */
export const SAMPLE_CODE = [
  "t=0",
  "function TIC()",
  " cls(1)",
  " for i=0,60 do circ(120,68,(60-i+t)%64,i%15) end",
  " local x=120+math.sin(t/18)*70",
  " local y=68+math.cos(t/15)*44",
  " circ(x,y,5,12)",
  ' print("CARTBOX",78,64,15)',
  " t=t+1",
  "end",
].join("\n");

/** Returns the bytes of a minimal Lua cartridge. */
export function buildLuaCart(code = SAMPLE_CODE) {
  const codeBytes = Buffer.from(code, "ascii");
  const header = Buffer.from([
    CHUNK_CODE, // type in low 5 bits, bank 0
    codeBytes.length & 0xff,
    (codeBytes.length >> 8) & 0xff,
    0,
  ]);
  return new Uint8Array(Buffer.concat([header, codeBytes]));
}

// CLI: `node sample-cart.mjs <output.tic>` writes the cart to disk.
// pathToFileURL handles paths with spaces/special chars; guard against argv[1]
// being undefined (e.g. under `node -e`, or when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node sample-cart.mjs <output.tic>");
    process.exit(1);
  }
  const bytes = buildLuaCart();
  writeFileSync(out, bytes);
  console.log(`wrote ${out} (${bytes.byteLength} bytes)`);
}
