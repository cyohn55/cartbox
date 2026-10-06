/**
 * The KTX2 transcoder for a standalone export (EP18): the vendored Basis
 * Universal transcoder with its WebAssembly inlined. Bundled to
 * public/standalone/ktx2.js, carried only by exports with KTX2 textures.
 */

import createBasis from "../vendor/basis/basis_transcoder.cjs";
import wasm from "../vendor/basis/basis_transcoder.wasm";

import { transcodeKtx2, type Ktx2Decode } from "../lib/ktx2Decoder";

export async function decoder(): Promise<Ktx2Decode> {
  const basis = await (createBasis as unknown as (options: object) => Promise<{ initializeBasis(): void }>)({ wasmBinary: wasm });
  basis.initializeBasis();
  return (bytes: Uint8Array) => transcodeKtx2(basis, bytes);
}
