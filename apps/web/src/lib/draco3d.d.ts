/** draco3d ships no types; its Emscripten decoder factory is all gltfDecoders.ts uses. */
declare module "draco3d/draco_decoder_nodejs.js" {
  const createDecoderModule: (options: { wasmBinary?: ArrayBuffer }) => Promise<unknown>;
  export default createDecoderModule;
}
