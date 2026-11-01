/**
 * The KTX2 transcoder on a worker (AAA_FIDELITY_ROADMAP.md F0e): the Basis
 * module loads here, once, and each file is transcoded off the main thread;
 * its pixels (and any block-compressed chain) go back transferred. See
 * {@link loadKtx2DecoderOffThread} in ktx2Decoder.ts.
 */

import { loadKtx2Decoder, ktx2Transfers, type Ktx2Decode } from "./ktx2Decoder";

/* eslint-disable @typescript-eslint/no-explicit-any -- the worker's own global */

const scope = self as any;
let decode: Promise<Ktx2Decode> | null = null;

scope.onmessage = async (event: { data: { id: number; bytes: Uint8Array; options?: { gpuFormats?: readonly string[] } } }) => {
  const { id, bytes, options } = event.data;
  try {
    decode ??= loadKtx2Decoder();
    const texture = (await decode)(bytes, options);
    scope.postMessage({ id, texture }, texture ? ktx2Transfers(texture) : []);
  } catch (error) {
    scope.postMessage({ id, texture: null, error: String(error) });
  }
};
